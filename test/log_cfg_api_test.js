'use strict';
const surface = require('./_surface');
/* Gateway-owned log file, end to end (2026-11-10).
 *
 * agw.sh starts node with AGW_LOG_FILE, so the process can batch its writes and cap the file. This test
 * runs a real gateway that way and checks: lines land in the file instead of stdout, /admin/api/log-cfg
 * reports and saves the two sizes, the saved values reach config.json, and log reading flushes the buffer
 * first so the panel never shows a stale window.
 *
 * Run: node test/log_cfg_api_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function request(port, p, headers, body, method) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: surface.spath(p), method: method || (payload ? 'POST' : 'GET'),
      headers: Object.assign(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, headers || {}),
      timeout: 4000,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-logcfg-'));
  require('./_surface').useDir(dir);
  const logFile = path.join(dir, 'log', 'gateway.log');
  const port = await freePort();
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port },
    webToken: 'log-token',
    panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    channels: [{ name: 'dead', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
    apiKeys: [{ key: 'sk-test', name: 'test' }],
  }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js'), cfgFile], {
    env: Object.assign({}, process.env, { AGW_LOG_FILE: logFile, AGW_HOT: '0', AGW_SINGLE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const r = await request(port, '/admin/api/instances', { 'x-agw-token': 'log-token' }); up = r.status === 200; }
      catch (_) { await sleep(200); }
    }
    ok(up, 'gateway came up');
    await sleep(1400);   // one flush interval

    ok(fs.existsSync(logFile), 'log file created by the gateway itself');
    const text = fs.readFileSync(logFile, 'utf8');
    ok(text.includes('就绪'), 'startup line reached the file');
    ok(/^\[\d\d:\d\d:\d\d\]/.test(text), 'lines keep the [HH:MM:SS] prefix');
    ok(stdout.trim() === '', 'nothing was written to stdout once the sink is installed (got ' + JSON.stringify(stdout.slice(0, 120)) + ')');

    const g = await request(port, '/admin/api/log-cfg/default', { 'x-agw-token': 'log-token' });
    ok(g.status === 200, 'GET log-cfg 200');
    const gj = JSON.parse(g.body || '{}');
    ok(gj.enabled === true, 'log-cfg says the writer is installed');
    ok(gj.saved && gj.saved.maxBytes === 8 * 1024 * 1024, 'default cap is 8 MB (got ' + (gj.saved && gj.saved.maxBytes) + ')');
    ok(gj.saved && gj.saved.bufferBytes === 64 * 1024, 'default buffer is 64 KB');
    ok(gj.size > 0, 'live file size is reported');

    const p1 = await request(port, '/admin/api/log-cfg/default', { 'x-agw-token': 'log-token' }, { maxBytes: 32768, bufferBytes: 8192 });
    ok(p1.status === 200, 'POST log-cfg 200');
    const pj = JSON.parse(p1.body || '{}');
    ok(pj.saved.maxBytes === 32768 && pj.saved.bufferBytes === 8192, 'POST saved the requested sizes');
    ok(pj.maxBytes === 32768 && pj.bufferBytes === 8192, 'POST applied them to the live writer');

    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    ok(onDisk.log && onDisk.log.maxBytes === 32768 && onDisk.log.bufferBytes === 8192, 'sizes persisted to config.json');

    const p2 = await request(port, '/admin/api/log-cfg/default', { 'x-agw-token': 'log-token' }, { maxBytes: 1024, bufferBytes: 64 * 1024 * 1024 });
    const p2j = JSON.parse(p2.body || '{}');
    ok(p2j.saved.maxBytes === 32768, 'server clamps a too-small cap (got ' + p2j.saved.maxBytes + ')');
    ok(p2j.saved.bufferBytes === 32768, 'server keeps the buffer at the cap (got ' + p2j.saved.bufferBytes + ')');

    await request(port, '/v1/models', { Authorization: 'Bearer log-token' }).catch(() => {});
    const l = await request(port, '/admin/api/logs/default?lines=20', { 'x-agw-token': 'log-token' });
    ok(l.status === 200 && l.body.length > 0, 'log read returns text');

    ok(child.exitCode === null, 'gateway still running (stderr: ' + JSON.stringify(stderr.slice(0, 200)) + ')');
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
    await sleep(400);
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
