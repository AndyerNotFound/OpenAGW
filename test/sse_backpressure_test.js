'use strict';
const surface = require('./_surface');
/* SSE backpressure must resume (regression, 2026-11-09).
 *
 * Symptom before the fix: a streamed answer stalled after ~382 KB with the upstream silent until the
 * 180 s idle timeout fired. makeDirectPipe.push() returned lastWriteOk even when the chunk produced no
 * write at all (a split SSE frame) -- the stale `false` from the previous chunk made the caller pause
 * the upstream, and with no write pending res never emitted 'drain', so nothing ever resumed.
 *
 * This test pushes 400 x ~8 KB events through a same-dialect passthrough channel and requires the
 * whole body to arrive quickly. Run: node test/sse_backpressure_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
const MB = 1024 * 1024;
const EVENTS = 400;
const EVENT = 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'A'.repeat(7900) }, finish_reason: null }] }) + '\n\n';

const up = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const step = () => {
      while (i < EVENTS) { i++; if (!res.write(EVENT)) { res.once('drain', step); return; } }
      res.end('data: [DONE]\n\n');
    };
    step();
  });
});

(async () => {
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-bp-'));
  const cf = path.join(dir, 'config.json');
  fs.writeFileSync(cf, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 }, webToken: '', panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false }, retrySame: 0,
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + up.address().port, apiKey: 'x', models: ['m'], default: true }],
    apiKeys: [{ key: 'sk-test', name: 'test' }],
  }));
  const cfg = G.loadConfig(cf);
  surface.set(cfg);
  const st = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });

  const t0 = Date.now();
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { req.destroy(); } catch (_) {} resolve({ timeout: true, bytes: 0, ms: Date.now() - t0 }); }, 15000);
    const req = http.request({ host: '127.0.0.1', port: st.port, path: surface.spath('/v1/chat/completions'), method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' } }, res => {
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, bytes, ms: Date.now() - t0 }); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  });

  ok(!result.timeout, 'stream finished instead of hanging on backpressure');
  ok(result.status === 200, 'status 200');
  ok(result.bytes >= 3 * MB, 'whole body relayed (got ' + Math.round(result.bytes / 1024) + ' KB)');
  ok(result.ms < 10000, 'no multi-second stall (took ' + result.ms + ' ms)');

  if (st.server && st.server.close) st.server.close();
  up.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { up.close(); } catch (_) {} process.exit(1); });
