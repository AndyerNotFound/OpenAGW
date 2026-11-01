'use strict';
const { utf8, safeParse, rpApplyText, rpWalk, logErr } = require('./util');
const { SSEParser, serializeEvent, isDoneEvent, jsonish } = require('./sse');

/* ================= Response rewrite / forwarding pipe =================
 * One pipe for every response shape the gateway relays:
 *   - SSE streams: parsed event-by-event; only events that need a rewrite are
 *     re-serialized, everything else passes through byte-for-byte; [DONE] is
 *     appended when the upstream forgot it (OpenAI-shaped clients).
 *   - Non-stream JSON: rpInc text replacement applied to the whole body.
 *   - Line streams (mislabelled content-type): line-based replacement.
 * Finalization (trailing partial line + res.end) lives inside the pipe, so no
 * bytes are lost even when the upstream's last line lacks a newline.
 * (Formerly part of dsml.js; the DSML cleaning/backfill stages were removed.)
 */
function makeDirectPipe(res, rpInc, isStream, opts) {
  const u8 = utf8();
  const isSSE = !!(opts && opts.isSSE != null ? opts.isSSE : isStream);
  const appendDone = !(opts && opts.appendDone === false);
  let buf = '';
  let closed = false;
  let finished = false;
  let sawDone = false;
  let lastWriteOk = true;
  let lastEventName = '';
  let lastEventId = null;

  const write = (s) => {
    if (finished || !s) return true;
    try { lastWriteOk = res.write(s); } catch (_) { finished = true; lastWriteOk = true; }
    return lastWriteOk;
  };

  const writeEventObj = (obj, ev, eventName) => {
    const en = eventName || (ev && ev.event) || lastEventName;
    const id = ev && ev.id != null ? ev.id : lastEventId;
    write(serializeEvent({ event: en, id: id, retry: ev && ev.retry }, [JSON.stringify(obj)]));
  };

  const handleSSEEvent = (ev) => {
    if (!ev) return;
    if (!ev.dataLines || !ev.dataLines.length) { write(ev.raw || serializeEvent(ev, [])); return; }
    if (isDoneEvent(ev)) { sawDone = true; return; }
    lastEventName = ev.event || lastEventName;
    if (ev.id != null) lastEventId = ev.id;
    if (!rpInc.length) {
      // no rewrite rules: forward byte-for-byte without JSON.parse; keep the multi-line split behaviour
      if (ev.dataLines.length > 1) {
        let each = true;
        for (const l of ev.dataLines) { const t = l.trim(); if (t !== '' && t !== '[DONE]' && !jsonish(t)) { each = false; break; } }
        if (each) {
          for (const l of ev.dataLines) {
            if (l.trim() === '') continue;
            handleSSEEvent({ event: ev.event, data: l, dataLines: [l], id: ev.id, retry: ev.retry, raw: '' });
          }
          return;
        }
      }
      write(ev.raw || serializeEvent(ev, ev.dataLines));
      return;
    }
    const j = safeParse(ev.data);
    if (!j || typeof j !== 'object') {
      const lines = ev.dataLines.map(l => rpApplyText(l, rpInc));
      write(serializeEvent({ event: ev.event, id: ev.id, retry: ev.retry }, lines));
      return;
    }
    let dirty = false;
    if (rpInc.length) { try { rpWalk(j, rpInc, 0, true); dirty = true; } catch (_) {} }
    if (dirty) writeEventObj(j, ev);
    else write(ev.raw || serializeEvent(ev, ev.dataLines));
  };

  const parser = new SSEParser({
    onEvent: handleSSEEvent,
    onComment: (raw) => write(raw),
  });

  const handleNonStreamEnd = () => {
    const j = safeParse(buf);
    if (!j || typeof j !== 'object') {
      let out = buf;
      if (rpInc.length) out = rpApplyText(out, rpInc);
      if (out) write(out);
      return;
    }
    let dirty = false;
    if (rpInc.length) { try { rpWalk(j, rpInc, 0, true); dirty = true; } catch (_) {} }
    if (dirty) write(JSON.stringify(j));
    else write(buf);
  };

  const handleGenericStreamEnd = () => {
    if (buf) {
      let tail = buf;
      buf = '';
      if (rpInc.length) tail = rpApplyText(tail, rpInc);
      if (/^\s*data:\s*\[DONE\]\s*$/.test(tail)) sawDone = true;
      write(tail);
    }
  };

  return {
    push(c) {
      if (finished) return true;
      try {
        if (!isStream) { buf += u8(c); return true; }
        if (!isSSE) {
          buf += u8(c);
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) {
            const out = rpInc.length ? rpApplyText(l, rpInc) : l;
            if (/^\s*data:\s*\[DONE\]\s*$/.test(out)) sawDone = true;
            write(out + '\n');
          }
          return lastWriteOk;
        }
        parser.push(c);
        return lastWriteOk;
      } catch (e) { logErr('[sse] 流式改写失败:', e.message); return true; }
    },
    end() {
      if (closed) return;
      closed = true;
      try {
        if (!isStream) { handleNonStreamEnd(); }
        else if (!isSSE) { handleGenericStreamEnd(); if (appendDone && !sawDone) write('data: [DONE]\n\n'); }
        else {
          parser.end();
          if (appendDone || sawDone) write('data: [DONE]\n\n');
        }
      } catch (e) { logErr('[pipe] 收尾失败:', e.message); }
      finished = true;
      try { res.end(); } catch (_) {}
    },
  };
}

module.exports = { makeDirectPipe };
