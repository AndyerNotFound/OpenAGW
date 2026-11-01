'use strict';
// ================= TLS fail-closed test =================
//// Two guarantees:
////  1. an instance with TLS on but a broken/missing certificate is NOT exposed in plaintext (no silent downgrade)
////  2. when the main instance has no TLS, a TLS instance is unreachable (refused, not served in plaintext)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

const MAIN = 39081, BAD = 39082;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-tlsfc-'));
const cfgDir = path.join(dir, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', path.join(cfgDir, 'key.pem'), '-out', path.join(cfgDir, 'cert.pem')], { stdio: 'ignore' });

const chan = [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:39089', apiKey: 'sk-x', models: ['m'], default: true }];
const base = { panel: { openBrowser: false }, modelSync: { enable: false }, channels: chan };
// main instance stays plaintext; the second instance claims TLS but points at a certificate that does not exist
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ ...base, listen: { host: '127.0.0.1', port: MAIN } }));
fs.writeFileSync(path.join(cfgDir, 'config.bad.json'), JSON.stringify({ ...base, listen: { host: '127.0.0.1', port: BAD }, tls: { enable: true, cert: 'missing.pem', key: 'missing.key' } }));
fs.writeFileSync(path.join(cfgDir, 'config.example.json'), '{}');

const results = [];
const check = (n, ok, x) => { results.push(ok); console.log((ok ? '  ✓ ' : '  ✗ ') + n + (x ? '  ' + x : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tcp = p => new Promise(res => { const s = net.connect(p, '127.0.0.1'); const f = v => { try { s.destroy(); } catch (_) {} res(v); }; s.setTimeout(900); s.on('connect', () => f(true)); s.on('error', () => f(false)); s.on('timeout', () => f(false)); });
function get(port, p) {
  return new Promise(res => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000 },
      x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ code: x.statusCode, body: d })); });
    r.on('error', e => res({ code: 0, err: e.message })); r.on('timeout', () => { r.destroy(); res({ code: 0, err: 'timeout' }); }); r.end();
  });
}

(async () => {
  const gw = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js'), path.join(cfgDir, 'config.json')],
    { env: { ...process.env, AGW_HOT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; gw.stdout.on('data', d => logs.push(d.toString())); gw.stderr.on('data', d => logs.push(d.toString()));
  let up = false;
  for (let i = 0; i < 60; i++) { up = await tcp(MAIN); if (up) break; await sleep(250); }
  check('主端口(明文)已监听', up, String(MAIN));

  check('证书损坏的 TLS 实例未监听自身端口(不回退明文)', !(await tcp(BAD)), String(BAD));

  const viaMain = await get(MAIN, '/bad/v1/models');
  check('主端口为明文时 TLS 实例被拒绝', viaMain.code >= 400 && /TLS/.test(viaMain.body || ''), 'HTTP ' + viaMain.code + ' ' + String(viaMain.body || '').slice(0, 90));

  const mainOk = await get(MAIN, '/v1/models');
  check('主实例本身仍正常(明文)', mainOk.code === 200, 'HTTP ' + mainOk.code);

  try { gw.kill('SIGTERM'); } catch (_) {}
  await sleep(1200); try { gw.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  const bad = results.filter(x => !x).length;
  console.log('\ntls fail-closed test: ' + (results.length - bad) + ' passed, ' + bad + ' failed');
  if (bad) { console.log('--- log ---\n' + logs.join('').slice(-2000)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('crash:', e); process.exit(1); });
