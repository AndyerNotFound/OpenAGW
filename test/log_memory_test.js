'use strict';
/* Log reading must not scale with the log file (2026-11-09).
 *
 * Before: /admin/api/logs did fs.readFileSync(whole file) + split('\n'). gateway.log is append-only
 * for the life of the process, so a gateway left running for weeks had a log big enough that one
 * panel refresh (or `agw logs`) allocated Buffer + string + one JS string per line of that size --
 * on a phone that is a straight OOM. After: a bounded tail window is read off the end.
 *
 * The assertions look at bytes actually read, not just RSS, so the test cannot pass by luck when
 * V8 happens to have spare memory.
 * Run: node test/log_memory_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }

function request(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function writeBigLog(file, tailLines) {
  const fd = fs.openSync(file, 'w');
  try {
    const line = '2026-11-09 12:00:00 [req] req00112233445566 model=deepseek-chat ch=relay in=100 out=200 ttfb=10 ms=900\n';
    const block = line.repeat(700);            // ~70 KB
    for (let i = 0; i < 480; i++) fs.writeSync(fd, block);   // ~32 MB
    const tail = [];
    for (let i = 0; i < tailLines; i++) {
      const l = 'TAIL-' + i + ' ' + '-'.repeat(80);
      tail.push(l);
      fs.writeSync(fd, l + '\n');
    }
    return tail;
  } finally { fs.closeSync(fd); }
}

function rotateCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-rot-'));
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'agw.sh'), path.join(dir, 'agw.sh'));
    fs.mkdirSync(path.join(dir, 'data', 'log'), { recursive: true });
    const f = path.join(dir, 'data', 'log', 'gateway.log');
    const fd = fs.openSync(f, 'w');
    const line = 'line ' + '-'.repeat(90) + '\n';
    for (let i = 0; i < 100000; i++) fs.writeSync(fd, line);   // ~10 MB
    fs.closeSync(fd);
    const before = fs.statSync(f).size;
    execFileSync('bash', [path.join(dir, 'agw.sh'), '__rotate'], { stdio: 'pipe', timeout: 30000 });
    const after = fs.statSync(f).size;
    ok(before > 9 * 1024 * 1024, 'rotation fixture is > 9 MB (got ' + before + ')');
    ok(after > 1024 * 1024 && after <= 2 * 1024 * 1024 + 256, 'rotation keeps ~2 MB (got ' + after + ')');
    const head = fs.readFileSync(f, 'utf8').slice(0, 16);
    ok(head.startsWith('line '), 'rotation starts on a whole line');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// A live gateway keeps writing through its own >> fd; swapping the file out from under it makes the
// panel go blind until a restart. The hidden __rotate command must refuse in that state.
async function rotateGuardCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-rotguard-'));
  let child = null;
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'agw.sh'), path.join(dir, 'agw.sh'));
    fs.mkdirSync(path.join(dir, 'data', 'log'), { recursive: true });
    const f = path.join(dir, 'data', 'log', 'gateway.log');
    const fd = fs.openSync(f, 'w');
    for (let i = 0; i < 100000; i++) fs.writeSync(fd, 'line ' + '-'.repeat(90) + '\n');
    fs.closeSync(fd);
    const before = fs.statSync(f).size;

    // pretend to be this directory's gateway: proc_is_gw matches the command line for
    // "$DIR/gateway.js". A script with that exact path (Termux's coreutils rejects exec -a) gives the
    // matching command line while it sleeps.
    fs.writeFileSync(path.join(dir, 'gateway.js'), 'sleep 20\n');
    child = spawn('bash', [path.join(dir, 'gateway.js')], { cwd: dir, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 300));

    let rc = 0, stderr = '';
    try { execFileSync('bash', [path.join(dir, 'agw.sh'), '__rotate'], { stdio: 'pipe', timeout: 20000 }); }
    catch (e) { rc = e.status; stderr = String(e.stderr || ''); }
    ok(rc === 1, 'rotate refuses while a gateway process is alive (rc=' + rc + ')');
    ok(fs.statSync(f).size === before, 'log is untouched when rotation is refused (size ' + fs.statSync(f).size + ')');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-logmem-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: 'log-token',
    panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    channels: [],
    apiKeys: [],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });

  const logDir = path.join(dir, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'default.log');
  const tail = writeBigLog(logFile, 60);
  const size = fs.statSync(logFile).size;

  // ---- instrument: how much of the log is actually read? ----
  const realReadSync = fs.readSync;
  const realReadFileSync = fs.readFileSync;
  let readBytes = 0, wholeFileReads = 0;
  fs.readSync = function (fd, buf, off, len, pos) {
    const n = realReadSync.call(fs, fd, buf, off, len, pos);
    if (n > 0) readBytes += n;
    return n;
  };
  fs.readFileSync = function (p, ...a) {
    if (typeof p === 'string' && p === logFile) {
      wholeFileReads++;
      try { readBytes += fs.statSync(p).size; } catch (_) {}
    }
    return realReadFileSync.call(fs, p, ...a);
  };
  try {
    readBytes = 0;
    const r = await request(started.port, '/admin/api/logs/default?lines=50', { 'x-agw-token': 'log-token' });
    ok(r.status === 200, 'logs 200');
    ok(r.body === tail.slice(-50).join('\n'), 'returns exactly the last 50 lines');
    ok(wholeFileReads === 0, 'never reads the whole log file (got ' + wholeFileReads + ' readFileSync)');
    ok(readBytes > 0 && readBytes <= 600 * 1024, 'tail window is bounded (read ' + readBytes + ' bytes of ' + size + ')');

    readBytes = 0;
    const r2 = await request(started.port, '/admin/api/logs/default?lines=999999', { 'x-agw-token': 'log-token' });
    const got = r2.body ? r2.body.split('\n').length : 0;
    ok(r2.status === 200, 'oversized lines= still 200');
    ok(got <= 2000, 'lines= is capped at 2000 (got ' + got + ')');
    ok(readBytes <= 600 * 1024, 'capped request still reads a bounded window (got ' + readBytes + ' bytes)');
  } finally {
    fs.readSync = realReadSync;
    fs.readFileSync = realReadFileSync;
  }

  // ---- small log: behaviour must not change ----
  fs.writeFileSync(logFile, 'a\nb\nc\nd\ne\n');
  const r3 = await request(started.port, '/admin/api/logs/default?lines=3', { 'x-agw-token': 'log-token' });
  ok(r3.body === 'c\nd\ne', 'small log still returns the last N lines');

  if (started.server && started.server.close) started.server.close();
  rotateCase();
  await rotateGuardCase();

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
