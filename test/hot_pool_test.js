'use strict';
// ================= Hot restart in multi-instance pool mode =================
//// One master + worker hosting default (main port) + a second instance on its own compat port.
//// Swapping the worker must keep both ports listening and both in-flight streams intact.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const P1 = Number(process.env.P1 || 39031), P2 = Number(process.env.P2 || 39032), UP = Number(process.env.UP_PORT || 39033);
const CHUNKS = 30, DELAY = 60;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-hotpool-'));
const cfgDir = path.join(dir, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });
const chans = [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + UP, apiKey: 'sk-up', models: ['hot-model'], default: true }];
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: P1 }, panel: { openBrowser: false }, modelSync: { enable: false }, channels: chans }));
fs.writeFileSync(path.join(cfgDir, 'config.second.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: P2 }, panel: { openBrowser: false }, modelSync: { enable: false }, channels: chans }));
fs.writeFileSync(path.join(cfgDir, 'config.example.json'), '{}');

const results = [];
const check = (n, ok, x) => { results.push(ok); console.log((ok ? '  ✓ ' : '  ✗ ') + n + (x ? '  ' + x : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const portOpen = p => new Promise(res => { const s = require('net').connect(p, '127.0.0.1'); const f = v => { try { s.destroy(); } catch (_) {} res(v); }; s.setTimeout(800); s.on('connect', () => f(true)); s.on('error', () => f(false)); s.on('timeout', () => f(false)); });

function stream(port, tag) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const body = JSON.stringify({ model: 'hot-model', stream: true, messages: [{ role: 'user', content: 'go' }] });
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.on('data', c => { text += c.toString('utf8'); });
      res.on('end', () => resolve({ tag, ok: (text.match(/"content":"#\d+"/g) || []).length >= CHUNKS, status: res.statusCode, ms: Date.now() - t0 }));
      res.on('error', e => resolve({ tag, ok: false, err: e.message }));
    });
    req.on('error', e => resolve({ tag, ok: false, err: e.message }));
    req.end(body);
  });
}

(async () => {
  const up = spawn(process.execPath, [path.join(__dirname, 'hot_fake_upstream.js')], { env: { ...process.env, UP_PORT: String(UP), CHUNKS: String(CHUNKS), DELAY: String(DELAY) }, stdio: 'ignore' });
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js'), path.join(cfgDir, 'config.json')], { env: { ...process.env, AGW_HOT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; gw.stdout.on('data', d => logs.push(d.toString())); gw.stderr.on('data', d => logs.push(d.toString()));

  let up1 = false, up2 = false;
  for (let i = 0; i < 60; i++) { up1 = await portOpen(P1); up2 = await portOpen(P2); if (up1 && up2) break; await sleep(250); }
  check('主端口 + 实例端口都监听', up1 && up2, P1 + '/' + P2);

  const wid = path.join(cfgDir, '.run', 'worker.pid');
  const before = fs.existsSync(wid) ? fs.readFileSync(wid, 'utf8').trim() : '';

  const a = stream(P1, 'main-port');
  const b = stream(P2, 'inst-port');
  await sleep(500);
  process.kill(gw.pid, 'SIGUSR2');
  const c = stream(P1, 'main-during');
  const d = stream(P2, 'inst-during');
  const [ra, rb, rc, rd] = await Promise.all([a, b, c, d]);

  let after = '';
  for (let i = 0; i < 40; i++) { await sleep(250); after = fs.existsSync(wid) ? fs.readFileSync(wid, 'utf8').trim() : ''; if (after && after !== before) break; }
  check('worker 换血', after !== before, before + ' → ' + after);
  check('主端口在途流不断', ra.ok, ra.ms + 'ms');
  check('实例端口在途流不断', rb.ok, rb.ms + 'ms');
  check('换血期间主端口新请求成功', rc.ok, rc.ms + 'ms');
  check('换血期间实例端口新请求成功', rd.ok, rd.ms + 'ms');
  check('换血后端口仍在监听', (await portOpen(P1)) && (await portOpen(P2)));

  try { gw.kill('SIGTERM'); } catch (_) {}
  try { up.kill('SIGKILL'); } catch (_) {}
  await sleep(1200); try { gw.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  const bad = results.filter(x => !x).length;
  console.log('\nhot pool test: ' + (results.length - bad) + ' passed, ' + bad + ' failed');
  if (bad) { console.log('--- log ---\n' + logs.join('').slice(-2500)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('crash:', e); process.exit(1); });
