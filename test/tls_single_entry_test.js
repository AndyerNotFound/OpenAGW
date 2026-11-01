'use strict';
// ================= TLS single-entry policy test =================
//// Proves: an instance with TLS on never listens on its own port and is reachable only through
//  the main port's HTTPS + /<name>/; the main port with TLS on serves HTTPS only (no plaintext twin);
//  a plaintext instance keeps its compat port. Certificates are generated on the fly.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const https = require('https');
const http = require('http');

const MAIN = 39071, TLSI = 39072, PLAIN = 39073;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-tls-'));
const cfgDir = path.join(dir, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });

// self-signed cert for 127.0.0.1 (instance configs point at ./cert.pem relative to their dir)
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', path.join(cfgDir, 'key.pem'), '-out', path.join(cfgDir, 'cert.pem')], { stdio: 'ignore' });

const chan = [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:39079', apiKey: 'sk-x', models: ['m'], default: true }];
const base = { panel: { openBrowser: false }, modelSync: { enable: false }, channels: chan };
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ ...base, listen: { host: '127.0.0.1', port: MAIN }, tls: { enable: true, cert: 'cert.pem', key: 'key.pem' } }));
fs.writeFileSync(path.join(cfgDir, 'config.tlsi.json'), JSON.stringify({ ...base, listen: { host: '127.0.0.1', port: TLSI }, tls: { enable: true, cert: 'cert.pem', key: 'key.pem' } }));
fs.writeFileSync(path.join(cfgDir, 'config.plain.json'), JSON.stringify({ ...base, listen: { host: '127.0.0.1', port: PLAIN } }));
fs.writeFileSync(path.join(cfgDir, 'config.example.json'), '{}');

const results = [];
const check = (n, ok, x) => { results.push(ok); console.log((ok ? '  ✓ ' : '  ✗ ') + n + (x ? '  ' + x : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tcp(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    const f = v => { try { s.destroy(); } catch (_) {} res(v); };
    s.setTimeout(900); s.on('connect', () => f(true)); s.on('error', () => f(false)); s.on('timeout', () => f(false));
  });
}
function reqTls(port, p) {
  return new Promise(res => {
    const r = https.request({ host: '127.0.0.1', port, path: p, method: 'GET', rejectUnauthorized: false, timeout: 5000 },
      x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ code: x.statusCode, body: d })); });
    r.on('error', e => res({ code: 0, err: e.message })); r.on('timeout', () => { r.destroy(); res({ code: 0, err: 'timeout' }); }); r.end();
  });
}
function reqPlain(port, p) {
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
  check('主端口已监听', up, String(MAIN));

  check('TLS 实例自身端口未监听', !(await tcp(TLSI)), String(TLSI));
  check('明文实例自身端口仍在监听', await tcp(PLAIN), String(PLAIN));

  const tlsPath = await reqTls(MAIN, '/tlsi/v1/models');
  check('TLS 实例经主端口 https 的 /实例名/ 可访问', tlsPath.code === 200, 'HTTP ' + tlsPath.code);
  const tlsAuth = await reqTls(MAIN, '/tlsi/admin/api/instances');
  check('TLS 实例面板 API 经前缀可达(未带凭据=401)', tlsAuth.code === 401 || tlsAuth.code === 403, 'HTTP ' + tlsAuth.code);

  const plainOnMain = await reqPlain(MAIN, '/v1/models');
  check('主端口不再接受明文(HTTPS 单端口)', plainOnMain.code === 0 || plainOnMain.code >= 400, plainOnMain.err ? 'plaintext rejected (' + plainOnMain.err + ')' : 'HTTP ' + plainOnMain.code);

  const plainPort = await reqPlain(PLAIN, '/v1/models');
  check('明文实例自身端口可用', plainPort.code === 200, 'HTTP ' + plainPort.code);

  try { gw.kill('SIGTERM'); } catch (_) {}
  await sleep(1200); try { gw.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  const bad = results.filter(x => !x).length;
  console.log('\ntls single-entry test: ' + (results.length - bad) + ' passed, ' + bad + ' failed');
  if (bad) { console.log('--- log ---\n' + logs.join('').slice(-2500)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('crash:', e); process.exit(1); });
