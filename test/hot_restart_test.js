'use strict';
// ================= Hot restart test: in-flight SSE survives a worker swap =================
//// Proves: (1) a streaming response keeps delivering while the worker is replaced,
//// (2) new requests right after the swap land on the new worker,
//// (3) the old worker exits only after the stream finishes (no truncation).
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GW_PORT = Number(process.env.GW_PORT || 39021);
const UP_PORT = Number(process.env.UP_PORT || 39022);
const CHUNKS = 40, DELAY = 50;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-hot-'));
const cfgDir = path.join(dir, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  listen: { host: '127.0.0.1', port: GW_PORT },
  panel: { openBrowser: false },
  modelSync: { enable: false },
  channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + UP_PORT, apiKey: 'sk-up', models: ['hot-model'], default: true }],
}));
fs.writeFileSync(path.join(cfgDir, 'config.example.json'), '{}');

const results = [];
const check = (name, ok, extra) => { results.push({ name, ok, extra }); console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function portOpen(port) {
  return new Promise(resolve => {
    const s = require('net').connect(port, '127.0.0.1');
    const f = v => { try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(800); s.on('connect', () => f(true)); s.on('error', () => f(false)); s.on('timeout', () => f(false));
  });
}

function streamOnce(tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const body = JSON.stringify({ model: 'hot-model', stream: true, messages: [{ role: 'user', content: 'go' }] });
    const req = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.on('data', c => { text += c.toString('utf8'); });
      res.on('end', () => {
        const n = (text.match(/"content":"#\d+"/g) || []).length;
        resolve({ tag, ok: n >= CHUNKS, chunks: n, done: /\[DONE\]/.test(text), status: res.statusCode, ms: Date.now() - t0 });
      });
      res.on('error', e => resolve({ tag, ok: false, chunks: 0, err: e.message, ms: Date.now() - t0 }));
    });
    req.on('error', e => resolve({ tag, ok: false, chunks: 0, err: e.message, ms: Date.now() - t0 }));
    req.end(body);
  });
}

(async () => {
  const up = spawn(process.execPath, [path.join(__dirname, 'hot_fake_upstream.js')], { env: { ...process.env, UP_PORT: String(UP_PORT), CHUNKS: String(CHUNKS), DELAY: String(DELAY) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js'), path.join(cfgDir, 'config.json')], {
    env: { ...process.env, AGW_HOT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLog = [];
  gw.stdout.on('data', d => gwLog.push(d.toString()));
  gw.stderr.on('data', d => gwLog.push(d.toString()));

  let ok = false;
  for (let i = 0; i < 60; i++) { if (await portOpen(GW_PORT)) { ok = true; break; } await sleep(250); }
  check('网关热模式启动并监听', ok, 'port ' + GW_PORT);
  const workerPidFile = path.join(cfgDir, '.run', 'worker.pid');

  const inflight = streamOnce('inflight');
  await sleep(600);
  const pidBefore = fs.existsSync(workerPidFile) ? fs.readFileSync(workerPidFile, 'utf8').trim() : '';
  const masterPid = gw.pid;
  process.kill(masterPid, 'SIGUSR2');
  await sleep(300);
  const during = await streamOnce('during');
  const res1 = await inflight;

  let pidAfter = '';
  for (let i = 0; i < 40; i++) { await sleep(250); pidAfter = fs.existsSync(workerPidFile) ? fs.readFileSync(workerPidFile, 'utf8').trim() : ''; if (pidAfter && pidAfter !== pidBefore) break; }
  check('worker 已换血', pidAfter !== pidBefore, pidBefore + ' → ' + pidAfter);
  check('master 未换 (端口句柄稳定)', gw.exitCode === null && gw.pid === masterPid, 'master pid ' + masterPid);
  check('重启期间的在途流完整送达', res1.ok && res1.done, res1.chunks + '/' + CHUNKS + ' chunks, ' + res1.ms + 'ms');
  check('重启期间发起的新请求成功', during.ok, during.chunks + ' chunks, ' + during.ms + 'ms');

  const after = await streamOnce('after');
  check('换血后新请求成功', after.ok, after.chunks + ' chunks, ' + after.ms + 'ms');

  await sleep(1200);
  const oldAlive = pidBefore ? (() => { try { process.kill(Number(pidBefore), 0); return true; } catch (_) { return false; } })() : false;
  check('旧 worker 已排水退出', !oldAlive, 'old ' + pidBefore);
  check('新 worker 存活', (() => { try { process.kill(Number(pidAfter), 0); return true; } catch (_) { return false; } })());
  check('master 仍存活', (() => { try { process.kill(masterPid, 0); return true; } catch (_) { return false; } })());

  try { gw.kill('SIGTERM'); } catch (_) {}
  try { up.kill('SIGKILL'); } catch (_) {}
  await sleep(1200);
  try { gw.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}


  const failed = results.filter(r => !r.ok);
  console.log('\nhot restart test: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  if (failed.length) { console.log('--- gateway log ---\n' + gwLog.join('').slice(-3000)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('test crash:', e); process.exit(1); });
