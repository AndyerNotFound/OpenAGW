'use strict';
const surface = require('./_surface');
/* Random routing test (2026-11-03)
 * routeRandom=true: no sticky interference (fresh key per request), many requests
 *   should hit all 3 channels roughly evenly; with round-robin every request would
 *   cycle A,B,C deterministically. Statistical check: each channel >= 10% share.
 * routeRandom=false (control): with fresh keys RR is deterministic A,B,C,A,B,C...
 *   shares are nearly exactly 1/3 each (still passes the even check, but we assert
 *   the sequence property differently: sticky holds the same key).
 */
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }

async function runOne(routeRandom, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-rand-'));
  require('./_surface').useDir(dir);
  const cfgPath = path.join(dir, 'config.json');
  const PA = 45500 + Math.floor(Math.random() * 200);
  const PB = PA + 1, PC = PA + 2;
  const hits = { A: 0, B: 0, C: 0 };
  const mk = (tag, p) => http.createServer((req, res) => {
    hits[tag]++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'from-' + tag }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  const ma = mk('A', PA), mb = mk('B', PB), mc = mk('C', PC);
  await new Promise(r => ma.listen(PA, '127.0.0.1', r));
  await new Promise(r => mb.listen(PB, '127.0.0.1', r));
  await new Promise(r => mc.listen(PC, '127.0.0.1', r));

  const apiKeys = [];
  for (let i = 1; i <= 40; i++) apiKeys.push({ name: 'u' + i, key: 'sk-k' + i });
  fs.writeFileSync(cfgPath, JSON.stringify({
    listen: { host: '127.0.0.1', port },
    apiKeys,
    panel: { openBrowser: false }, modelSync: { enable: false },
    redact: { enable: false }, retrySame: 0, connRetry: 0,
    routeRandom,
    channels: [
      { name: 'chanA', type: 'openai', baseUrl: 'http://127.0.0.1:' + PA, apiKey: 'sk-a', models: ['gpt'], default: true },
      { name: 'chanB', type: 'openai', baseUrl: 'http://127.0.0.1:' + PB, apiKey: 'sk-b', models: ['gpt'] },
      { name: 'chanC', type: 'openai', baseUrl: 'http://127.0.0.1:' + PC, apiKey: 'sk-c', models: ['gpt'] },
    ],
  }, null, 2));

  const gw = spawn('node', ['gateway.js', cfgPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AGW_SINGLE: '1', AGW_HOT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const waitPort = (p, tries = 120) => new Promise((res, rej) => {
    const tick = () => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.end(); res(); }); s.on('error', () => --tries > 0 ? setTimeout(tick, 150) : rej(new Error('port ' + p + ' never came up'))); }; tick();
  });
  const reqJson = (key) => new Promise((resolve) => {
    const data = JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({
      host: '127.0.0.1', port, path: surface.spath('/v1/chat/completions'), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + key },
    }, res => {
      const cs = []; res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(data); req.end();
  });

  try {
    await waitPort(port);
    // 30 requests, each with a fresh key so sticky affinity never kicks in
    const seq = [];
    for (let i = 1; i <= 30; i++) {
      const r = await reqJson('sk-k' + i);
      if (r.status !== 200) { ok(false, 'request ' + i + ' failed: ' + r.status + ' ' + r.body.slice(0, 80)); return { hits, seq }; }
      const m = /from-([ABC])/.exec(r.body);
      if (m) seq.push(m[1]);
    }
    return { hits, seq };
  } finally {
    gw.kill('SIGKILL'); ma.close(); mb.close(); mc.close();
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
}

(async () => {
  const rnd = await runOne(true, 45601);
  const total = rnd.hits.A + rnd.hits.B + rnd.hits.C;
  ok(total === 30, 'random: 30 requests served: ' + total);
  const shares = ['A', 'B', 'C'].map(t => rnd.hits[t] / total);
  ok(shares.every(s => s >= 0.1), 'random: every channel >= 10% share: A=' + rnd.hits.A + ' B=' + rnd.hits.B + ' C=' + rnd.hits.C);
  // Round-robin is not just an even split, it is a fixed A,B,C,A,B,C ... order. Testing the
  // order is deterministic; testing "not exactly 10/10/10" used to fail ~7% of runs by chance.
  const isRR = rnd.seq.every((t, i) => t === ['A', 'B', 'C'][i % 3]);
  ok(rnd.seq.length === 30, 'random: 30 responses attributed: ' + rnd.seq.length);
  ok(!isRR, 'random: channel order is not the deterministic A,B,C cycle: ' + rnd.seq.join(''));

  console.log(`\nrandom route test: ${pass} passed, ${fail} failed`);
  if (failures.length) console.error('failures:', failures.join('\n  '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });