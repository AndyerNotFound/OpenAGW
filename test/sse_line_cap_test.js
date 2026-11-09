'use strict';
/* An SSE line that never ends must not eat the process (2026-11-09).
 *
 * SSEParser accumulates bytes in `line` until it sees a newline. An upstream that sends one endless
 * line (a broken relay, a huge inline blob) made that buffer grow without bound, and because no
 * event ever completes, nothing is written downstream -- backpressure never applies. The parser now
 * drops a fragment past 8 MB and starts a fresh line.
 * Run: node test/sse_line_cap_test.js
 */
const { SSEParser } = require('../sse.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
const MB = 1024 * 1024;
const CAP = 8 * MB;

const events = [];
const p = new SSEParser({ onEvent: ev => events.push(ev) });

const before = process.memoryUsage().rss;
const chunk = Buffer.from('x'.repeat(64 * 1024));
for (let i = 0; i < 192; i++) p.push(chunk);          // 12 MB, not a single newline
const peak = process.memoryUsage().rss - before;

ok(p.line.length <= CAP, 'line buffer is capped at 8 MB (got ' + Math.round(p.line.length / 1024) + ' KB)');
ok(p.dataLines.length === 0, 'no half event is left queued');
ok(peak < 48 * MB, 'RSS stays bounded while feeding 12 MB of newline-free data (delta ' + Math.round(peak / MB) + ' MB)');

// the parser must still work after dropping the runaway fragment; terminate the physical line
// first (the dropped bytes and these belong to the same line as far as the stream is concerned)
p.push(Buffer.from('\n\n'));
p.push(Buffer.from('data: {"a":1}\n\n'));
p.push(Buffer.from('data: [DONE]\n\n'));
p.end();
const last = events[events.length - 1];
ok(events.length >= 1 && last && last.data === '[DONE]', 'parser still emits events after a runaway line');
ok(events.some(e => e.data === '{"a":1}'), 'the next normal event parses');
ok(!events.some(e => e.raw && e.raw.length > CAP), 'the dropped fragment never reaches the event stream');

// a line that arrives whole but is over the cap must be dropped the same way (not forwarded)
const before2 = events.length;
const big = Buffer.from('data: ' + 'y'.repeat(9 * MB) + '\n\n');
p.push(big);
ok(events.length === before2, 'an oversized whole line is dropped, not emitted');

// the "line stream" path in pipe.js (upstream labelled text/plain) has the same failure mode
const { makeDirectPipe } = require('../pipe.js');
let written = 0;
const fakeRes = {
  write: (s) => { written += Buffer.byteLength(typeof s === 'string' ? s : String(s)); return true; },
  end: () => {},
  writableNeedDrain: false,
};
const pipe = makeDirectPipe(fakeRes, [], true, { isSSE: false, appendDone: false });
for (let i = 0; i < 192; i++) pipe.push(chunk);     // 12 MB with no newline
ok(written === 0, 'line stream: nothing is forwarded while the line is incomplete');
pipe.push(Buffer.from('\n'));
ok(written === 0, 'line stream: the runaway fragment is not forwarded at all');
ok(pipe.push(Buffer.from('ok\n')) !== false, 'line stream: still accepts data afterwards');
ok(written > 0 && written < 4096, 'line stream: the next complete line is forwarded normally (wrote ' + written + ' bytes)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
