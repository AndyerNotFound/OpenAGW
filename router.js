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
const { logErr, log, toText, utf8 } = require('./util');
const state = require('./state');
const admin = require('./admin');
const modelref = require('./modelref');
const permissions = require('./permissions');

// ================= Channel routing / auth / errors / model list =================
/* ================= Channel routing / auth / errors / model list ================= */

//// collect all channels matching the model, rotating the start by the round-robin counter
// Returns [{ ch, upstreamModel }, ...] (rotated; the first one is for this round)
//// channel lock check: lockAt = when the lock starts, lockUntil = when it unlocks (0/empty = locked until manually unlocked)
function channelLocked(ch, now) {
  if (!ch) return false;
  const t = now || Date.now();
  const at = Number(ch.lockAt) || 0, until = Number(ch.lockUntil) || 0;
  if (!at && !until) return false;
if (at && t < at) return false;         // lock time not reached yet
if (until && t >= until) return false;  // past the unlock time
  return true;
}
// ---- Circuit breaker (channel-level) ----
//// Returns true when the channel is in cooldown (tripped).
function channelBroken(cfg, chName, now) {
  if (!cfg || !cfg._breakerState) return false;
  const s = cfg._breakerState[chName];
  if (!s || !(s.until > 0)) return false;
  return (now || Date.now()) < s.until;
}
//// Record a channel failure; trip the breaker when >=threshold failures within windowSec.
function breakerFail(cfg, chName) {
  if (!cfg || !(cfg.breaker && cfg.breaker.enable)) return;
  const thresh = Math.max(1, Number(cfg.breaker.threshold) || 3);
  const win = Math.max(1, Number(cfg.breaker.windowSec) || 60) * 1000;
  const cool = Math.max(1, Number(cfg.breaker.cooldownSec) || 120) * 1000;
  if (!cfg._breakerState) cfg._breakerState = {};
  const s = cfg._breakerState[chName] = cfg._breakerState[chName] || { fails: [], until: 0 };
  s.fails.push(Date.now());
  if (s.fails.length > thresh * 3) s.fails = s.fails.slice(-thresh * 2); // cap
  const now = Date.now();
  const recent = s.fails.filter(t => now - t < win).length;
  if (recent >= thresh && !(s.until > now)) {
    s.until = now + cool;
  }
}
//// Clear failure history on success (cooldown still runs on time).
function breakerReset(cfg, chName) {
  if (!cfg || !cfg._breakerState) return;
  const s = cfg._breakerState[chName];
  if (s) s.fails = [];
}
//// Exclude broken AND locked channels from routing.
function _routeChannelExcluded(cfg, ch, now) {
  return channelLocked(ch, now) || channelBroken(cfg, ch && ch.name, now);
}

function pickChannels(cfg, model, forceName, preferChannel) {
const chs = (cfg.channels || []).filter(c => !_routeChannelExcluded(cfg, c)); // locked / circuit-broken stay out
  const candidates = [];
  // manual routing: x-agw-channel header > instance forceChannel > auto match. A hit pins the single channel; no rotation
  const forced = forceName ? String(forceName).trim() : '';
  if (forced) {
    const hit = chs.find(c => c.name === forced);
    if (hit) {
      const um = (hit.modelMap && model && Object.prototype.hasOwnProperty.call(hit.modelMap, model))
        ? String(hit.modelMap[model]) : (model || '');
      return [{ ch: hit, upstreamModel: um, forced: true }];
    }
    logErr('[route] 手动路由的渠道不存在, 退回自动匹配: ' + forced);
  }
// One-shot routing: the channel picked in the floating ball, cleared after one use, never persisted
  if (cfg._onceChannel) {
    const onceName = String(cfg._onceChannel);
    const hit = chs.find(c => c.name === onceName);
    cfg._onceChannel = null;
    if (hit) {
      const um = (hit.modelMap && model && Object.prototype.hasOwnProperty.call(hit.modelMap, model))
        ? String(hit.modelMap[model]) : (model || '');
      log('[route] 一次性路由命中: ' + onceName);
      return [{ ch: hit, upstreamModel: um, once: true }];
    }
    logErr('[route] 一次性路由的渠道已不存在, 走自动匹配: ' + onceName);
  }
  if (model) {
// Collect every channel that serves this model, from BOTH modelMap (rename) and the
// models list. Dedupe is per-channel: a channel matched via modelMap is not added again
// for its models list. Crucially, a channel that only lists the model in `models` is NOT
// masked by another channel's modelMap hit (the old `!candidates.length` short-circuit
// silently dropped such channels and skewed round-robin).
    const added = new Set();
// 1) exact hit in modelMap -> upstreamModel = the renamed real name
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
        added.add(ch);
      }
    }
// 2) hit in the models list -> upstreamModel = the model name as-is
    for (const ch of chs) {
      if (added.has(ch)) continue;
      if (ch.models && ch.models.includes(model)) {
        candidates.push({ ch, upstreamModel: model });
        added.add(ch);
      }
    }
  }
// 3) no exact hit -> fall back to default channel(s) (possibly several) or all channels
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
// Routing rotation: round-robin (default) or random (opt-in via cfg.routeRandom).
// Round-robin: a counter keyed by model decides the starting offset.
// Random: each request gets a fresh uniformly random offset; no state, better
//   distribution for first-hit allocation and fallthrough cascades.
  let rot;
  if (cfg.routeRandom) {
    rot = Math.floor(Math.random() * candidates.length);
  } else {
    if (!cfg._rr) cfg._rr = {};
    const key = model || '__nomodel__';
    cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
    rot = cfg._rr[key];
  }
  const rotated = candidates.slice(rot).concat(candidates.slice(0, rot));
// Sticky channel preference (prompt-cache affinity): the channel that last served this
// key+model goes first; failures still fall through to the round-robin order.
  if (preferChannel) {
    const idx = rotated.findIndex(c => c.ch.name === preferChannel);
    if (idx > 0) {
      const pref = rotated.splice(idx, 1)[0];
      rotated.unshift(pref);
    }
  }
  return rotated;
}

// Request/instance-level forced channel: the header wins (this request only), then instance config
function forcedChannelName(cfg, req) {
  const h = (req && req.headers) ? String(req.headers['x-agw-channel'] || '').trim() : '';
  if (h) return h;
  return cfg.forceChannel ? String(cfg.forceChannel) : '';
}

//// model-name glob matching (* = anything), case-insensitive
function globMatch(pat, str) {
  const esc = String(pat).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp('^' + esc + '$', 'i').test(String(str)); } catch (_) { return false; }
}

//// rough prompt token estimate: only for the hard limit's upfront block, not real tokenization
// CJK counts ~1 token per character; everything else ~1 token per charsPerToken characters (default 4)
const CJK_RE = /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/g;
// Allocation-free CJK counting (range check equivalent to the old CJK_RE): avoids match-array allocation on large contexts
function countCjk(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ||
        (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) n++;
  }
  return n;
}
//// rough token estimate (not real tokenization): CJK ~1 token per char, others ~1 token per cpt chars
function tokOf(str, cpt) {
  str = String(str || '');
  if (!str) return 0;
  const cjk = countCjk(str);
  return Math.ceil(cjk + (str.length - cjk) / cpt);
}

// Request-side single scan (2026-10-27 refactor): total + distribution (tools/system/user/history) in one pass
// history = assistant/tool turns, kept separate from system (the prompt), so you can tell prompt bloat from history bloat
function analyzePrompt(canonical, charsPerToken) {
  const cpt = Math.max(1, Number(charsPerToken) || 4);
  const dist = { tools: 0, system: 0, user: 0, history: 0 };
  const msgs = Array.isArray(canonical && canonical.messages) ? canonical.messages : [];
  if (Array.isArray(canonical && canonical.tools)) dist.tools = tokOf(JSON.stringify(canonical.tools), cpt);
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { dist.system += tokOf(toText(m.content), cpt) + 4; continue; }
    if (m.role === 'user') { dist.user += tokOf(toText(m.content), cpt) + 4; continue; }
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { const fn = (tc && tc.function) || {}; dist.history += tokOf(fn.name, cpt) + tokOf(fn.arguments, cpt); }
    dist.history += tokOf(toText(m.content), cpt) + 4;
  }
  dist.history += Math.ceil(msgs.length * 0.5);
  return { total: dist.tools + dist.system + dist.user + dist.history, dist };
}
// Backward compatible with old callers
function estimatePromptTokens(canonical, charsPerToken) { return analyzePrompt(canonical, charsPerToken).total; }
function estimatePromptDist(canonical, charsPerToken) { return analyzePrompt(canonical, charsPerToken).dist; }

// ---- Self-calibration (2026-10-27): per-model EMA of real input / local estimate, stored in byModel[n].estRatio with stats ----
const EST_RATIO_MIN = 0.1, EST_RATIO_MAX = 10, EST_EMA_A = 0.2;
function calibRatio(cfg, model) {
  const bm = cfg && cfg._stats && cfg._stats.byModel && cfg._stats.byModel[model];
  const r = bm && Number(bm.estRatio);
  return (r >= EST_RATIO_MIN && r <= EST_RATIO_MAX) ? r : 1;
}
function calibUpdate(cfg, model, actual, rawEst) {
  if (!(actual > 0) || !(rawEst > 0)) return;
  const stats = cfg._stats = cfg._stats || {};
  stats.byModel = stats.byModel || {};
  const bm = stats.byModel[model] = stats.byModel[model] || { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
  const r = Math.min(EST_RATIO_MAX, Math.max(EST_RATIO_MIN, actual / rawEst));
  bm.estRatio = bm.estRatio ? bm.estRatio * (1 - EST_EMA_A) + r * EST_EMA_A : r;
}
//// with real usage, normalize the distribution to the real input so the three parts sum to it (consistent convention)
function scaleDist(dist, rawTotal, actualInput) {
  if (!(actualInput > 0) || !(rawTotal > 0)) return dist;
  const f = actualInput / rawTotal, out = {};
  for (const k in dist) out[k] = Math.round(dist[k] * f);
  return out;
}

// Backward compatibility: return the first candidate
function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}

/* ---- Helper: collect a JSON body ---- */
function collectJson(req, res, cb) {
  let body = '';
const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
  req.on('data', c => { body += u8(c); if (body.length > 262144) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(body || '{}'); } catch (_) { return sendError('openai', res, 400, 'bad json'); } cb(j); });
  req.on('error', () => {});
}
// Instances a key card may reach. An empty whitelist means "the issuing instance only" -- crossing
// into another instance is always an explicit grant, never an accident. Wildcards are accepted.
function availableBranches(cfg, userKey) {
  const all = state.CUR_POOL ? [...state.CUR_POOL.instances.keys()].filter(n => { const c = state.CUR_POOL.instances.get(n); return c && !c._disabled; }) : [cfg._name || 'default'];
  if (!userKey) return all; // admin/keyless: everything
  const own = cfg._name || 'default';
  const wl = permissions.list(userKey.branches);
  if (!wl.length) return all.includes(own) ? [own] : [];
  return all.filter(n => permissions.allowsBranch(userKey, n));
}

/* ---- Key card generation (configurable length 8-128, base64url charset) ---- */
function genApiKey(len) {
  const n = Math.min(128, Math.max(8, Number(len) || 24));
  const bytes = Math.ceil(n * 3 / 4) + 2;
  return 'sk-' + crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}

/* ---- Persist runtime config (strips _-prefixed runtime fields; reuses admin.saveCfg) ---- */
function persistRuntimeCfg(cfg) {
  try {
    const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k && k[0] === '_') ? undefined : v));
    admin.saveCfg(cfg._name || 'default', clean);
  } catch (e) { logErr('[persist] 配置落盘失败:', e.message); }
}

// Key card balance JSON (/credits response)
function keyCreditsJSON(uk) {
  const quota = Number(uk.quotaTokens) || 0;
  const used = Number(uk.usedTokens) || 0;
  return {
    name: uk.name || '', uid: uk.uid || '',
    quotaTokens: quota, usedTokens: used,
    remainingTokens: quota > 0 ? Math.max(0, quota - used) : null,
    unlimited: quota <= 0,
    expiresAt: uk.expiresAt || '',
    models: uk.models || [],
  };
}

// Auth: returns {ok, admin, userKey, keyOwner, status, error}
//  - admin=true: the presented card has role "admin"
//  - userKey: matched a user card; keyOwner is the instance config that owns it (quota/usage home)
//  - quota / expiry / disabled are checked here; model / provider / instance whitelists are
//    enforced on the request path (record.js), where the target channel and model are known
function keyCardError(uk) {
  if (uk.enable === false) return { status: 401, error: 'key 已禁用' };
  if (uk.expiresAt) {
    const t = new Date(uk.expiresAt).getTime();
    if (!isNaN(t) && t < Date.now()) return { status: 401, error: 'key 已过期 (' + uk.expiresAt + ')' };
  }
  if (uk.quotaTokens > 0 && (uk.usedTokens || 0) >= uk.quotaTokens)
    return { status: 429, error: '额度已用尽 (' + (uk.usedTokens || 0) + '/' + uk.quotaTokens + ' tokens)' };
  return null;
}

/* One card = one user across instances: a card issued on instance A may reach instance B when its
 * `branches` whitelist allows B. The owner config keeps the usedTokens counter, so the quota and
 * the rate window are shared no matter which instance served the request. */
function findCrossInstanceKey(cfg, token) {
  if (!state.CUR_POOL) return null;
  const target = cfg._name || 'default';
  let denied = null;
  for (const [, c] of state.CUR_POOL.instances) {
    if (!c || c === cfg) continue;
    const uk = (c.apiKeys || []).find(k => k && k.key === token);
    if (!uk) continue;
    const err = keyCardError(uk);
    if (err) return { error: err };
    const wl = permissions.list(uk.branches);
    if (!wl.length || !permissions.allowsBranch(uk, target)) {
      denied = { status: 403, error: '此卡密未授权访问实例: ' + target + ' (实例权限: ' + (wl.join(', ') || '仅发卡实例') + ')' };
      continue;
    }
    return { userKey: uk, keyOwner: c };
  }
  return denied ? { error: denied } : null;
}

// opts.anyBranch: /v1/branches is a discovery endpoint -- a card that may not use the instance it
// asks from must still be able to learn where it is allowed to go.
function checkAuth(cfg, req, query, opts) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const presented = bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
  const keys = cfg.apiKeys || [];
  const own = cfg._name || 'default';
  const branchError = (uk) => {
    if (opts && opts.anyBranch) return null;
    if (permissions.allowsBranch(uk, own)) return null;
    return { status: 403, error: '此卡密未授权访问实例: ' + own + ' (实例权限: ' + (permissions.list(uk.branches).join(', ') || '仅发卡实例') + ')' };
  };
  if (presented) {
    const uk = keys.find(k => k.key && k.key === presented);
    if (uk) {
      const err = keyCardError(uk);
      if (err) return { ok: false, ...err };
      const brErr = branchError(uk);
      if (brErr) return { ok: false, ...brErr };
      return { ok: true, userKey: uk, keyOwner: cfg, admin: uk.role === 'admin' };
    }
    const cross = findCrossInstanceKey(cfg, presented);
    if (cross && cross.error) return { ok: false, ...cross.error };
    if (cross) {
      const brErr = branchError(cross.userKey);
      if (brErr) return { ok: false, ...brErr };
      return { ok: true, userKey: cross.userKey, keyOwner: cross.keyOwner, admin: cross.userKey.role === 'admin' };
    }
  }
  // /v1 always requires a card key; an instance with no cards answers 401 until one is issued
  return { ok: false, status: 401, error: 'invalid key' };
}

/* ---- Key card usage persistence (log/keyusage-<inst>.json, dirty-check flush every 30s) ---- */
function cfgDirOf(cfg) { return cfg._configFile ? path.dirname(cfg._configFile) : process.cwd(); }
function keyUsageFile(cfg) { return path.join(cfgDirOf(cfg), 'log', 'keyusage-' + (cfg._name || 'default') + '.json'); }
function loadKeyUsage(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(keyUsageFile(cfg), 'utf8'));
    for (const k of (cfg.apiKeys || [])) {
      const rec = j[k.key];
      if (rec && typeof rec.usedTokens === 'number') k.usedTokens = rec.usedTokens;
    }
  } catch (_) {}
}
function saveKeyUsage(cfg) {
  if (!(cfg.apiKeys || []).length) return;
  const j = {};
  for (const k of cfg.apiKeys) j[k.key] = { usedTokens: k.usedTokens || 0, name: k.name || '' };
  try { fs.mkdirSync(path.dirname(keyUsageFile(cfg)), { recursive: true }); fs.writeFileSync(keyUsageFile(cfg), JSON.stringify(j, null, 1)); } catch (_) {}
}
// dirty-check flush every 30s (all instances)
setInterval(() => {
  const cfgs = state.CUR_POOL ? [...state.CUR_POOL.instances.values()] : (state.CUR_CFG ? [state.CUR_CFG] : []);
  for (const c of cfgs) if (c._keyUsageDirty) { c._keyUsageDirty = false; saveKeyUsage(c); }
}, 30000).unref();

/* ---- Plugin gatewayApi factory: exposes restricted gateway capabilities to plugins ---- */
function makeGatewayApi(cfg) {
  return {
    // look up a key record by card token (lets plugins verify the caller's identity)
    findKey: (token) => (cfg.apiKeys || []).find(k => k && k.key && k.key === token) || null,
    // add card quota: implemented by reducing usedTokens (persisted via keyusage; config untouched)
    grantQuota: (keyId, tokens) => {
      const k = (cfg.apiKeys || []).find(x => x && x.key === keyId);
      if (!k || !(tokens > 0)) return false;
      k.usedTokens = Math.max(0, (k.usedTokens || 0) - tokens);
      cfg._keyUsageDirty = true;
      return true;
    },
  };
}

function corsHeaders() {
  if (!state.CUR_CFG || !state.CUR_CFG.cors) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}

function jsonErr(res, e) {
  try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
}

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
    res.end(JSON.stringify(obj));
  } catch (_) { try { res.end(); } catch (_) {} }
}

function sendError(format, res, status, message, code) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  let body;
  if (format === 'claude') body = { type: 'error', error: { type: 'api_error', message } };
  else if (format === 'gemini') body = { error: { code: status, message, status: code || 'INTERNAL' } };
  else body = { error: { message, type: 'gateway_error', code: code || String(status) } };
  try {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify(body));
  } catch (_) { try { res.end(); } catch (_) {} }
}

function collectModels(cfg) {
  const set = [];
  for (const ch of (cfg.channels || [])) {
    if (ch.models) for (const m of ch.models) if (!set.includes(m)) set.push(m);
    if (ch.modelMap) for (const m of Object.keys(ch.modelMap)) if (!set.includes(m)) set.push(m);
  }
  return set;
}
function modelsResponse(cfg, format, userKey) {
/* Model references (ported from ai-gateway-core): a model name served by several channels is
 * listed once per source under its composite id "instance:channel:model", so clients can pin
 * an exact source; unconflicted names keep their plain id. Plain names keep working in requests.
 * A user card only sees what it may call: providers outside its channels whitelist are dropped
 * first, then models outside its models whitelist. */
  const channels = permissions.filterChannels(userKey, cfg.channels || []);
  const refs = modelref.buildRefs([{ name: cfg._name || 'default', channels }]);
  const ms = [...new Set(refs.entries
    .filter(e => !userKey || permissions.allowsModel(userKey, e.id, e.plain))
    .map(e => e.id))];
  if (format === 'gemini') {
    return { models: ms.map(m => ({ name: 'models/' + m, displayName: m, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) };
  }
// openai and claude fields merged so both SDKs can read it
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'openagw', display_name: m })) };
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, state, admin, pickChannels, channelLocked, channelBroken, breakerFail, breakerReset, forcedChannelName, globMatch, CJK_RE, countCjk, tokOf, analyzePrompt, estimatePromptTokens, estimatePromptDist, EST_RATIO_MIN, calibRatio, calibUpdate, scaleDist, pickChannel, collectJson, availableBranches, genApiKey, persistRuntimeCfg, keyCreditsJSON, checkAuth, cfgDirOf, keyUsageFile, loadKeyUsage, saveKeyUsage, makeGatewayApi, corsHeaders, jsonErr, sendJson, sendError, collectModels, modelsResponse };
