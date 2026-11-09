'use strict';
/* Request recording and error passthrough must not buffer whole bodies (2026-11-09).
 *
 * Before:
 *   - record.enable wrapped res.write into recChunks and kept every byte until res.end(), only then
 *     cutting to record.maxChars. One long streamed answer held the entire response in memory.
 *   - an upstream error page was collected whole even when only 200-300 chars were read from it, and
 *     the pass-through paths buffered the full page before res.end().
 * After: the record buffer stops at maxChars while collecting; error bodies keep a bounded head.
 *
 * Memory is measured as a sampled RSS peak around each request, because the interesting allocation
 * is transient and rss() after the fact misses it.
 * Run: node test/record_memory_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
const MB = 1024 * 1024;

// ---------- fake upstream ----------
let mode = 'stream';
const EVENTS = 4000;             // 4000 x ~8 KB = ~32 MB
const EVENT = 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'A'.repeat(7900) }, finish_reason: null }] }) + '\n\n';
const ERROR_BODY = Buffer.alloc(32 * MB, 0x78);   // 32 MB of 'x'

function pump(res, total, chunk, done) {
  let sent = 0;
  const step = () => {
    while (sent < total) {
      sent += chunk.length;
      if (!res.write(chunk)) { res.once('drain', step); return; }
    }
    done();
  };
  step();
}

const up = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (mode === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      const step = () => {
        while (i < EVENTS) {
          i++;
          if (!res.write(EVENT)) { res.once('drain', step); return; }
        }
        res.end('data: [DONE]\n\n');
      };
      step();
    } else if (mode === 'ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } else if (mode === 'breakstream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(EVENT);
      res.write(EVENT);
      setTimeout(() => { try { res.destroy(); } catch (_) {} }, 30);
    } else if (mode === 'silent') {
      // answer only after the client has already hung up
      setTimeout(() => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); } catch (_) {} }, 1000);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      pump(res, ERROR_BODY.length, ERROR_BODY.subarray(0, 64 * 1024), () => res.end());
    }
  });
});

function post(port, body, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let peak = 0;
    const timer = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 5);
    const chunks = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let bytes = 0;
      res.on('data', c => { bytes += c.length; if (opts.keep) chunks.push(c); });
      res.on('end', () => {
        clearInterval(timer);
        resolve({ status: res.statusCode, headers: res.headers, bytes, body: opts.keep ? Buffer.concat(chunks) : null, peak });
      });
    });
    req.on('error', e => { clearInterval(timer); reject(e); });
    req.end(JSON.stringify(body));
  });
}

function records(dir) {
  const f = path.join(dir, 'log', 'requests-default.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

(async () => {
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const upPort = up.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-recmem-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    retrySame: 0,
    record: { enable: true, maxChars: 2000 },
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'x', models: ['m'], default: true }],
    apiKeys: [],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;

  // ---------- 1. long streamed answer ----------
  const base0 = process.memoryUsage().rss;
  const r1 = await post(port, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { keep: false });
  const peak1 = Math.max(0, r1.peak - base0);
  ok(r1.status === 200, 'stream: 200');
  ok(r1.bytes >= 30 * MB, 'stream: client received the whole body (' + r1.bytes + ' bytes)');

  const recs = records(dir);
  const rec = recs.filter(x => x.response && x.response.indexOf('AAAA') !== -1).pop();
  ok(!!rec, 'stream: a request record was written');
  if (rec) {
    ok(rec.response.length <= 2100, 'stream: recorded response stops at maxChars (got ' + rec.response.length + ')');
    ok(rec.response.indexOf('…[截断]') !== -1, 'stream: record is marked as truncated');
  }
  ok(peak1 < 64 * MB, 'stream: RSS peak stays bounded (delta ' + Math.round(peak1 / MB) + ' MB for a 32 MB answer)');

  // ---------- 2. huge upstream error body ----------
  mode = 'error';
  const base1 = process.memoryUsage().rss;
  const r2 = await post(port, { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }, { keep: true });
  const peak2 = Math.max(0, r2.peak - base1);
  ok(r2.status === 400, 'error: status passed through (got ' + r2.status + ')');
  ok(r2.body.length <= 2 * MB + 1, 'error: body is capped at 2 MB (got ' + r2.body.length + ')');
  ok(r2.headers['x-ai-gateway-truncated'] === '1', 'error: truncation is signalled to the client');
  // the capped body above is the real proof (before the fix the client received all 32 MB); the RSS
  // bound is only a disaster guard -- streaming 32 MB through loopback grows V8's transient heap anyway
  ok(peak2 < 96 * MB, 'error: RSS peak stays bounded (delta ' + Math.round(peak2 / MB) + ' MB for a 32 MB error body)');

  // ---------- 3. client hangs up mid-stream: the record must still land ----------
  mode = 'stream';
  await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let got = 0;
      res.on('data', c => { got += c.length; if (got > 200000) { rq.destroy(); resolve(); } });
      res.on('error', () => resolve());
    });
    rq.on('error', () => resolve());
    rq.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'bye' }] }));
    setTimeout(resolve, 3000);
  });
  await new Promise(r => setTimeout(r, 800));
  const all = records(dir);
  const last = all[all.length - 1];
  ok(!!last && last.status === 499, 'disconnect: record settles as 499 (got ' + (last && last.status) + ')');
  ok(!!last && typeof last.response === 'string' && last.response.length > 0, 'disconnect: partial response is still recorded');

  // ---------- 4. hang up before the upstream answered: no status -> 499, not 0 ----------
  mode = 'silent';
  const beforeEarly = records(dir).length;
  await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.on('data', () => {}); res.on('error', () => resolve());
    });
    rq.on('error', () => resolve());
    rq.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'early bye' }] }));
    // hang up once the socket is really connected, so the request reached the gateway on a busy machine
    rq.on('socket', (sock) => sock.on('connect', () => setTimeout(() => { try { rq.destroy(); } catch (_) {} resolve(); }, 150)));
    setTimeout(() => { try { rq.destroy(); } catch (_) {} resolve(); }, 2000);
  });
  await new Promise(r => setTimeout(r, 900));
  const early = records(dir);
  ok(early.length === beforeEarly + 1, 'early disconnect: a record is written (' + beforeEarly + ' -> ' + early.length + ')');
  const lastEarly = early[early.length - 1];
  ok(!!lastEarly && lastEarly.status === 499, 'early disconnect: record settles as 499 (got ' + (lastEarly && lastEarly.status) + ')');

  // ---------- 5. upstream dies mid-stream: 502, not "client gone" ----------
  mode = 'breakstream';
  const beforeBreak = records(dir).length;
  await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.on('data', () => {});
      res.on('end', resolve);
      res.on('error', resolve);
    });
    rq.on('error', resolve);
    rq.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'break' }] }));
    setTimeout(resolve, 3000);
  });
  await new Promise(r => setTimeout(r, 600));
  const brk = records(dir);
  ok(brk.length === beforeBreak + 1, 'upstream break: a record is written (' + beforeBreak + ' -> ' + brk.length + ')');
  const lastBrk = brk[brk.length - 1];
  ok(!!lastBrk && lastBrk.status === 502, 'upstream break: record says 502, not 499 (got ' + (lastBrk && lastBrk.status) + ')');

  // ---------- 6. cross-format success: the writer ends the response itself -> 200, real channel ----------
  mode = 'ok';
  const beforeX = records(dir).length;
  const xr = await new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(b).toString('utf8') }));
    });
    rq.on('error', reject);
    rq.end(JSON.stringify({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
  });
  await new Promise(r => setTimeout(r, 400));
  const xs = records(dir);
  ok(xr.status === 200, 'cross-format: client got 200 (got ' + xr.status + ')');
  ok(xs.length === beforeX + 1, 'cross-format: a record is written (' + beforeX + ' -> ' + xs.length + ')');
  const lastX = xs[xs.length - 1];
  ok(!!lastX && lastX.status === 200, 'cross-format success records 200, not a fake disconnect (got ' + (lastX && lastX.status) + ')');
  ok(!!lastX && lastX.channel === 'up', 'cross-format record keeps the channel (got ' + (lastX && lastX.channel) + ')');

  if (started.server && started.server.close) started.server.close();
  up.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { up.close(); } catch (_) {} process.exit(1); });
