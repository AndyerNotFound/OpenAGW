'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { logErr } = require('./util');

// ================= Redaction (redact) =================
const redactCache = require('./redact-cache.js'); // CDC 增量分块缓存: 干净内容只算 hash, 命中跳过正则

/* ---- Privacy filter: replace secrets/tokens in the request body with *** ---- */
const REDACT_PATTERNS = [
/\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic style
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
/\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // Bearer headers pasted into text
];
const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;
function redactText(s, extra) {
  return redactCache.redactSmart(s, extra);
}
/* Request-body filter scope ----------------------------------------------------------------
 * Only conversational content may be rewritten. Parameters, ids, schemas and URLs are the
 * request's structure: masking them does not protect anything, it corrupts the call (a masked
 * JSON schema stops validating, a masked image URL stops resolving, a masked tool id no longer
 * matches its result). So the walker skips those subtrees entirely. */
const REDACT_STRUCT_KEYS = new Set([
  'tools', 'functions', 'tool_choice', 'function_call', 'response_format', 'json_schema', 'schema',
  'input_schema', 'parameters', 'properties', 'metadata', 'user', 'safety_settings', 'safetysettings',
  'generation_config', 'generationconfig', 'thinking', 'thinking_config', 'thinkingconfig',
  'tool_config', 'toolconfig', 'stream_options',
  'stop', 'stop_sequences', 'stopsequences', 'audio', 'modalities', 'prediction', 'reasoning', 'logprobs',
  'signature', 'cache_control', 'image_url', 'file_url', 'file_uri', 'fileuri', 'file_data', 'filedata',
  'inline_data', 'inlinedata', 'output_config', 'outputconfig',
]);
/* Parameter names that *contain* a sensitive word but hold a number/identifier: "max_tokens"
 * matched the key rule and a stringified limit became "***", which upstream rejects outright. */
const REDACT_VALUE_KEYS = new Set([
  'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxoutputtokens', 'budget_tokens',
  'n', 'seed', 'temperature', 'top_p', 'top_k', 'topp', 'topk', 'presence_penalty', 'frequency_penalty',
  'reasoning_effort', 'service_tier', 'store', 'verbosity', 'effort', 'model', 'id', 'name', 'role',
  'type', 'format', 'mime_type', 'mimetype', 'media_type', 'mediatype',
]);
const REDACT_URL_RE = /^[a-z][a-z0-9+.\-]*:\/\/\S+$/i;   // a locator, not prose
const REDACT_DATA_URI_RE = /^data:/i;
const REDACT_BLOB_RE = /^[A-Za-z0-9+/=_\-]{512,}$/;      // base64 payloads (inlineData / files)
/* Counter-style keys ("input_tokens", "max_input_tokens", "token_count") hold numbers, never
 * credentials. Only those are exempt from the name rule: a numeric `password` / `api_key` is
 * still a secret and stays masked. */
function isCounterKey(k) {
  return k === 'tokens' || k === 'token_count' || /_tokens$/.test(k) || /_token_count$/.test(k);
}
/* Response-direction filter switch (instance redact.enable is the ceiling, further ANDed with redact.response;
 * a card's redact=false mirrors the request direction, disabling it per card) */
function respRedactOn(cfg, urlInfo) {
  if (!(cfg && cfg.redact && cfg.redact.enable !== false && cfg.redact.response)) return false;
  return !(urlInfo && urlInfo.userKey && urlInfo.userKey.redact === false);
}
function redactDeep(v, extra, depth, noFieldNames) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') {
    if (REDACT_URL_RE.test(v) || REDACT_DATA_URI_RE.test(v) || REDACT_BLOB_RE.test(v)) return v;
    return redactText(v, extra);
  }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1, noFieldNames); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (depth === 0 && k === 'model') continue;            // never touch the model name (routing)
      const lk = k.toLowerCase();
      const val = v[k];
      // `thinking` / `reasoning` are a parameter object on a request but the thinking TEXT on a
      // response (Claude thinking blocks, compat `message.reasoning`), so only skip the object form
      if (REDACT_STRUCT_KEYS.has(lk) && !((lk === 'thinking' || lk === 'reasoning') && typeof val === 'string')) continue;
      if (!noFieldNames && typeof val === 'string' && val && !REDACT_VALUE_KEYS.has(lk) && !isCounterKey(lk)
          && REDACT_FIELD_RE.test(k) && !REDACT_URL_RE.test(val) && !REDACT_DATA_URI_RE.test(val)) { v[k] = '***'; continue; }
      // Tool-call payloads are executed by the CLIENT: rewriting a key named `token` inside
      // `tool_use.input` breaks the call it just asked for. Pattern rules still apply there.
      const childNoNames = noFieldNames || (v.type === 'tool_use' && lk === 'input');
      v[k] = redactDeep(val, extra, depth + 1, childNoNames);
    }
    return v;
  }
  return v;
}
/* Streaming response filter: text/thinking/tool args buffered separately; secrets split across chunks are still caught;
 * Only tail tokens that might still grow are held back; everything else streams as it arrives. */
function wrapRedactWriter(baseWriter, extra) {
  const textF = redactCache.createStreamFilter(extra);
  const reasF = redactCache.createStreamFilter(extra);
  const toolFs = new Map();
  let done = false;
  const send = (ev) => { try { baseWriter.onEvent(ev); } catch (e) { logErr('redact writer error:', e.message); } };
  const flushText = () => { const o = textF.flush(); if (o) send({ type: 'text', t: o }); };
  const flushReas = () => { const o = reasF.flush(); if (o) send({ type: 'reasoning', t: o }); };
  const flushTools = () => {
    const keys = [...toolFs.keys()].sort((a, b) => a - b);
    for (const i of keys) { const o = toolFs.get(i).flush(); if (o) send({ type: 'tool_delta', i, s: o }); }
    toolFs.clear();
  };
  const flushAll = () => { flushText(); flushReas(); flushTools(); };
  return {
    onEvent(ev) {
      if (!ev || !ev.type || done) return;
      if (ev.type === 'text') { const o = textF.push(ev.t); if (o) send({ type: 'text', t: o }); return; }
      if (ev.type === 'reasoning') { const o = reasF.push(ev.t); if (o) send({ type: 'reasoning', t: o }); return; }
      if (ev.type === 'tool_delta') {
        let f = toolFs.get(ev.i);
        if (!f) { f = redactCache.createStreamFilter(extra); toolFs.set(ev.i, f); }
        const o = f.push(ev.s); if (o) send({ type: 'tool_delta', i: ev.i, s: o });
        return;
      }
      if (ev.type === 'end') { done = true; flushAll(); send(ev); return; }
      flushText(); flushReas(); send(ev);   // start/tool_start/usage: flush buffers first to preserve event order
    },
  };
}
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, redactCache, REDACT_PATTERNS, REDACT_FIELD_RE, redactText, respRedactOn, redactDeep, wrapRedactWriter };
