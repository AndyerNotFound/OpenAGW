'use strict';
const surface = require('./_surface');
/* Hour / minute usage buckets (2026-11-10).
 *
 * The stats card can render 1D / 1H / 1M, so every settled request must land in a day bucket, an hour
 * bucket and a minute bucket with the same totals. Day keys are ISO dates as before; the finer keys are
 * "YYYY-MM-DD HH" and "YYYY-MM-DD HH:MM" in UTC. Assertions read the numbers back over the admin API, so
 * a broken accumulation path cannot pass by inspecting internals.
 *
 * Run: node test/stats_gran_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
function request(port, p, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: surface.spath(p), method: body == null ? 'GET' : 'POST',
      headers: Object.assign(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, headers || {}),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const up = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-gran', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'gran-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }));
    });
  });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const upPort = up.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-gran-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: 'gran-token',
    panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    channels: [{ name: 'fake', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'sk-test', models: ['gran-model'], default: true }],
    apiKeys: [{ key: 'sk-test', name: 'test' }],
  }));
  const cfg = G.loadConfig(cfgFile);
  surface.set(cfg);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  try {
    const chat = await request(started.port, '/v1/chat/completions', { Authorization: 'Bearer sk-test' }, {
      model: 'gran-model', messages: [{ role: 'user', content: 'hi' }],
    });
    ok(chat.status === 200, 'chat request 200 (got ' + chat.status + ')');

    const r = await request(started.port, '/admin/api/stats', { 'x-agw-token': 'gran-token' });
    ok(r.status === 200, 'stats 200');
    const j = JSON.parse(r.body || '{}');

    const iso = new Date().toISOString();
    const day = iso.slice(0, 10);
    const hour = day + ' ' + iso.slice(11, 13);
    const min = day + ' ' + iso.slice(11, 16);

    const d = (j.daily || {})[day];
    ok(!!d, 'day bucket ' + day + ' exists');
    ok(d && d.requests === 1 && d.inputTokens === 120 && d.outputTokens === 30, 'day bucket totals (got ' + JSON.stringify(d && { r: d.requests, i: d.inputTokens, o: d.outputTokens }) + ')');

    const h = (j.hourly || {})[hour];
    ok(!!h, 'hour bucket ' + hour + ' exists');
    ok(h && h.requests === 1 && h.inputTokens === 120 && h.outputTokens === 30, 'hour bucket totals');
    ok(h && h.errors === 0 && h.cached === 0, 'hour bucket carries errors/cached');

    const m = (j.minutely || {})[min];
    ok(!!m, 'minute bucket ' + min + ' exists');
    ok(m && m.requests === 1 && m.inputTokens === 120 && m.outputTokens === 30, 'minute bucket totals');

    ok(Object.keys(j.hourly).length <= 24 * 7 + 16, 'hour buckets stay bounded');
    ok(Object.keys(j.minutely).length <= 240 + 16, 'minute buckets stay bounded');

    const keys = Object.keys(j.hourly);
    ok(keys.every(k => /^\d{4}-\d\d-\d\d \d\d$/.test(k)), 'hour keys are "YYYY-MM-DD HH"');
    ok(Object.keys(j.minutely).every(k => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(k)), 'minute keys are "YYYY-MM-DD HH:MM"');

    for (let i = 0; i < 3; i++) {
      await request(started.port, '/v1/chat/completions', { Authorization: 'Bearer sk-test' }, { model: 'gran-model', messages: [{ role: 'user', content: 'x' }] });
    }
    const r2 = await request(started.port, '/admin/api/stats', { 'x-agw-token': 'gran-token' });
    const j2 = JSON.parse(r2.body || '{}');
    const m2 = (j2.minutely || {})[min] || {};
    ok(m2.requests === 4, 'minute bucket accumulates (got ' + m2.requests + ')');
    ok((j2.daily[day] || {}).requests === 4, 'day bucket accumulates (got ' + ((j2.daily[day] || {}).requests) + ')');
  } finally {
    if (started && started.server && started.server.close) started.server.close();
    if (started && started.servers) for (const s of started.servers) { try { s.close(); } catch (_) {} }
    up.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
