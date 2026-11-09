'use strict';
/* ================= Server-Sent Events: spec parser + tolerant decoder =================
 * The old decoder split on '\n', kept only `data:` lines and flushed on blank lines.
 * That lost whole events in several real-world cases:
 *   - the final event/line had no trailing newline (buf was never processed on end);
 *   - an upstream used bare CR or split CRLF across TCP packets;
 *   - a BOM preceded the first `data:` line;
 *   - a sloppy upstream omitted the blank line between events, so several JSON
 *     payloads were joined into one string and JSON.parse dropped the batch.
 * This parser keeps exact per-event field lines for lossless passthrough, handles
 * LF / CRLF / CR, flushes the last event at EOF, and never requires a trailing
 * blank line. `SSEDecoder` keeps the old `onData(string)` contract and adds a
 * tolerant fallback for back-to-back JSON events. */

const { StringDecoder } = require('string_decoder');
const { logErr } = require('./util');

/* A single SSE line has no business being this long. Without a cap, an upstream that never sends a
 * newline makes this.line grow until the process dies, and nothing downstream ever runs: no write
 * happens, so backpressure never applies. 8 MB is far above any real frame (the largest common case
 * is an inline image delta) -- past it the fragment is dropped and the parser starts a fresh line. */
const MAX_SSE_LINE = 8 * 1024 * 1024;

const COLON = 58;
const LF = 10;
const CR = 13;
const BOM = 0xfeff;

class SSEParser {
  constructor(onEvent, opts) {
    if (onEvent && typeof onEvent === 'object') { opts = onEvent; onEvent = opts.onEvent; }
    opts = opts || {};
    this.onEvent = typeof onEvent === 'function' ? onEvent : function () {};
    this.onComment = typeof opts.onComment === 'function' ? opts.onComment : null;
    this.decoder = new StringDecoder('utf8');
    this.started = false;
    this.ended = false;
    this.line = '';
    this.dropping = false;
    this.pendingCR = false;
    this.fieldLines = [];
    this.dataLines = [];
    this.eventName = '';
    this.eventId = null;
    this.retry = null;
    this.hasFields = false;
  }

  push(chunk) {
    if (this.ended || chunk == null) return;
    let text;
    if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) text = this.decoder.write(chunk);
    else text = String(chunk);
    if (!text) return;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === BOM) text = text.slice(1);
    }
    this._feed(text);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    try {
      const tail = this.decoder.end();
      if (tail) this._feed(tail);
    } catch (_) {}
    if (this.pendingCR) { this.pendingCR = false; this._emitLine(); }
    if (this.line !== '') this._emitLine();
    this._dispatch();
  }

  _feed(text) {
    if (!text) return;
/* Still inside a line that was already dropped as runaway: swallow everything up to and including
 * its newline. Without this, the fragment after the drop became a field line of its own and was
 * forwarded to the client as one multi-megabyte junk event. */
    if (this.dropping) {
      // CR counts as a terminator too: an upstream that ends lines with bare CR would otherwise
      // keep the parser silent forever
      let end = -1;
      for (let k = 0; k < text.length; k++) {
        const cc = text.charCodeAt(k);
        if (cc === LF || cc === CR) { end = k; break; }
      }
      if (end < 0) return;
      this.dropping = false;
      text = text.slice(end + 1);
      if (!text) return;
    }
    let i = 0;
    if (this.pendingCR) {
      this.pendingCR = false;
      if (text.charCodeAt(0) === LF) i = 1;
      this._emitLine();
    }
    let start = i;
    for (; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === LF) {
        this.line += text.slice(start, i);
        this._emitLine();
        start = i + 1;
      } else if (c === CR) {
        this.line += text.slice(start, i);
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === LF) i++;
          this._emitLine();
          start = i + 1;
        } else {
          this.pendingCR = true;
          start = i + 1;
        }
      }
    }
    if (start < text.length) {
      this.line += text.slice(start);
      if (this.line.length > MAX_SSE_LINE) this._dropRunawayLine();
    }
  }

  _dropRunawayLine() {
    const dropped = this.line.length;
    this.dropping = true;
    this.line = '';
    this.dataLines = [];
    this.fieldLines = [];
    this.eventName = '';
    this.eventId = null;
    this.retry = null;
    this.hasFields = false;
    try { logErr('[sse] 单行超过 ' + Math.round(MAX_SSE_LINE / 1048576) + ' MB, 已丢弃 ' + dropped + ' 字节的残缺事件'); } catch (_) {}
  }

  _emitLine() {
    const line = this.line;
    this.line = '';
    // a line that arrives whole but is still over the cap must behave like one that grew past it
    // across chunks -- otherwise the outcome depends on TCP framing
    if (line.length > MAX_SSE_LINE) {
      // clear the same state _dropRunawayLine clears, so the outcome does not depend on how the
      // line happened to be split across chunks
      this.dataLines = [];
      this.fieldLines = [];
      this.eventName = '';
      this.eventId = null;
      this.retry = null;
      this.hasFields = false;
      try { logErr('[sse] 单行超过 ' + Math.round(MAX_SSE_LINE / 1048576) + ' MB, 已丢弃 ' + line.length + ' 字节'); } catch (_) {}
      return;
    }
    if (line === '') { this._dispatch(); return; }
    if (line.charCodeAt(0) === COLON) {
      if (this.onComment) { try { this.onComment(line + '\n'); } catch (_) {} }
      return;
    }
    let at = line.indexOf(':');
    let field, value;
    if (at < 0) { field = line; value = ''; }
    else {
      field = line.slice(0, at);
      value = line.slice(at + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
    }
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id') { if (value.indexOf('\u0000') < 0) this.eventId = value; }
    else if (field === 'retry') { if (/^\d+$/.test(value)) this.retry = Number(value); }
    this.fieldLines.push(line);
    this.hasFields = true;
  }

  _dispatch() {
    if (!this.hasFields && !this.dataLines.length) return;
    const dataLines = this.dataLines;
    const ev = {
      event: this.eventName,
      data: dataLines.join('\n'),
      dataLines: dataLines,
      id: this.eventId,
      retry: this.retry,
      raw: this.hasFields ? this.fieldLines.join('\n') + '\n\n' : '',
    };
    this.fieldLines = [];
    this.dataLines = [];
    this.eventName = '';
    this.eventId = null;
    this.retry = null;
    this.hasFields = false;
    try { this.onEvent(ev); } catch (_) {}
  }
}

function jsonish(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  if (t === '[DONE]') return true;
  const c = t.charCodeAt(0);
  if (c !== 123 && c !== 91) return false;
  try { JSON.parse(t); return true; } catch (_) { return false; }
}

class SSEDecoder {
  constructor(onData) {
    this.onData = typeof onData === 'function' ? onData : function () {};
    this.parser = new SSEParser((ev) => this._event(ev));
  }
  push(chunk) { this.parser.push(chunk); }
  end() { this.parser.end(); }
  _send(d) { try { this.onData(d); } catch (_) {} }
  _event(ev) {
    const lines = ev.dataLines;
    if (!lines || !lines.length) return;
    if (lines.length === 1) { this._send(lines[0]); return; }
    const joined = lines.join('\n');
    if (jsonish(joined)) { this._send(joined); return; }
    let eachIsEvent = true;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '') continue;
      if (!jsonish(t)) { eachIsEvent = false; break; }
    }
    if (eachIsEvent) {
      for (let i = 0; i < lines.length; i++) this._send(lines[i]);
      return;
    }
    this._send(joined);
  }
}

function serializeEvent(ev, dataLines) {
  let out = '';
  if (ev && ev.event) out += 'event: ' + ev.event + '\n';
  if (ev && ev.id != null) out += 'id: ' + ev.id + '\n';
  if (ev && ev.retry != null) out += 'retry: ' + ev.retry + '\n';
  const lines = dataLines || (ev && ev.dataLines) || [];
  for (let i = 0; i < lines.length; i++) {
    const parts = String(lines[i]).split('\n');
    for (let k = 0; k < parts.length; k++) out += 'data: ' + parts[k] + '\n';
  }
  return out + '\n';
}

function isDoneEvent(ev) {
  return !!(ev && typeof ev.data === 'string' && ev.data.trim() === '[DONE]');
}

module.exports = { SSEParser, SSEDecoder, serializeEvent, isDoneEvent, jsonish };
