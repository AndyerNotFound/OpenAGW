'use strict';
const surface = require('./_surface');
/* Circuit breaker test (channel-level cooldown, 2026-11-03)
 * chanA(default, healthy) + chanB(flaky: always 503 in phase 1, healthy in phase 2).
 * Each request uses a fresh API key so sticky affinity cannot pin a channel,
 * and round-robin keeps alternating A/B across requests.
 * breaker ON (threshold=2, cooldownSec=2):
 *   - 2 failures trip chanB; the 3rd RR turn at B gets redirected to A (bHits stays 2)
 *   - after cooldown chanB is eligible again and recovers
 * breaker OFF (control): every RR turn at B still hits B (bHits = 3) and keeps failing.
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

async function runOne(enableBreaker, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-breaker-'));
  require('./_surface').useDir(dir);
  const cfgPath = path.join(dir, 'config.json');
  const PORT_A = 45200 + Math.floor(Math.random() * 400), PORT_B = PORT_A + 1;

  let bHits = 0, aHits = 0, bHealthy = false;
  const mockA = http.createServer((req, res) => {
    aHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok-from-A' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  const mockB = http.createServer((req, res) => {
    bHits++;
    if (!bHealthy) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'mock B down' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok-from-B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise(r => mockA.listen(PORT_A, '127.0.0.1', r));
  await new Promise(r => mockB.listen(PORT_B, '127.0.0.1', r));

  // 8 key cards: one per request -> sticky cannot pin a channel
  const apiKeys = [];
  for (let i = 1; i <= 12; i++) apiKeys.push({ name: 'u' + i, key: 'sk-k' + i });
  fs.writeFileSync(cfgPath, JSON.stringify({
    listen: { host: '127.0.0.1', port },
    apiKeys,
    panel: { openBrowser: false }, modelSync: { enable: false },
    redact: { enable: false }, retrySame: 0, connRetry: 0,
    breaker: { enable: enableBreaker, threshold: 2, windowSec: 60, cooldownSec: 2 },
    channels: [
      { name: 'chanA', type: 'openai', baseUrl: 'http://127.0.0.1:' + PORT_A, apiKey: 'sk-a', models: ['gpt'], default: true },
      { name: 'chanB', type: 'openai', baseUrl: 'http://127.0.0.1:' + PORT_B, apiKey: 'sk-b', models: ['gpt'] },
    ],
  }, null, 2));

  const gw = spawn('node', ['gateway.js', cfgPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AGW_SINGLE: '1', AGW_HOT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLog = [];
  gw.stdout.on('data', d => gwLog.push(d.toString()));
  gw.stderr.on('data', d => gwLog.push(d.toString()));

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
    const phase1 = [];
    for (let i = 1; i <= 6; i++) {
      const r = await reqJson('sk-k' + i);
      phase1.push(r.status);
    }
    const bHitsPhase1 = bHits;
    // cooldown 2s + margin; B becomes healthy for the recovery phase
    bHealthy = true;
    await new Promise(r => setTimeout(r, 2600));
    const phase2 = [];
    for (let i = 7; i <= 10; i++) {
      const r = await reqJson('sk-k' + i);
      phase2.push(r.status);
    }
    return { phase1, phase2, bHitsPhase1, bHits, aHits, log: gwLog.join('') };
  } finally {
    gw.kill('SIGKILL'); mockA.close(); mockB.close();
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
}

(async () => {
  /* breaker ON */
  const on = await runOne(true, 44501);
  ok(on.phase1.every(s => s === 200), 'ON: phase1 all 200 (failures fall to A): ' + on.phase1.join(','));
  ok(on.bHitsPhase1 === 2, 'ON: chanB hit exactly 2x then tripped: ' + on.bHitsPhase1);
  ok(on.phase2.every(s => s === 200), 'ON: phase2 all 200 after cooldown: ' + on.phase2.join(','));
  ok(on.bHits > on.bHitsPhase1, 'ON: chanB hit again after cooldown (recovered): ' + on.bHits);

  /* breaker OFF (control) */
  const off = await runOne(false, 44502);
  ok(off.bHitsPhase1 >= 3, 'OFF: chanB keeps getting hits without breaker: ' + off.bHitsPhase1);
  ok(off.phase1.filter(s => s === 200).length >= 3, 'OFF: phase1 has failures falling to A: ' + off.phase1.join(','));

  console.log(`\nbreaker test: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.error('failures:', failures.join('\n  '));
    if (on.log) console.error('=== ON GATEWAY LOG ===\n' + on.log.slice(-2000));
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });