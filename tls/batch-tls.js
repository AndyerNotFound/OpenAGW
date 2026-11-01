#!/usr/bin/env node
'use strict';
/*
 * Turn TLS on/off for all instances in bulk.
 *
 * Policy (2026-10-30): one entry per instance, never a plaintext twin.
 *   default  -> serves HTTPS on its listen.port (single port, no HTTP twin)
 *   others   -> with TLS on they stop listening on their own port and are reachable only through
 *               the main port's HTTPS + /<name>/; without TLS they keep their own plaintext port
 *   a broken certificate fails closed (the instance is not exposed in plaintext)
 *
 * Usage:
 *   node tls/batch-tls.js --dry-run          preview the plan only
 *   node tls/batch-tls.js                    enable TLS everywhere (the old --pure shape)
 *   node tls/batch-tls.js --off              turn off everywhere
 *   node tls/batch-tls.js --only A,B         process only the given instances
 *   node tls/batch-tls.js --no-restart       write config only, no restart
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const crypt = require(path.join(ROOT, 'crypt.js'));
const CA = path.join(ROOT, 'tls', 'ca.pem');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const OFF = flag('off');
const PURE = flag('pure');
const DRY = flag('dry-run');
const ONLY = opt('only', '') ? String(opt('only', '')).split(',').map(s => s.trim()).filter(Boolean) : null;

const instName = (f) => f === 'config.json' ? 'default' : f.slice('config.'.length, -'.json'.length);
const cfgPath = (name) => path.join(ROOT, 'data', name === 'default' ? 'config.json' : `config.${name}.json`);

function readCfg(name) {
  const f = cfgPath(name);
  const raw = fs.readFileSync(f, 'utf8');
  const enc = crypt.isEncText(raw);
  const pass = enc ? crypt.loadPass() : null;
  if (enc && !pass) throw new Error('Config is encrypted but no passphrase found');
  return { cfg: JSON.parse(enc ? crypt.decryptText(raw, pass) : raw), enc, pass, file: f };
}

function writeCfg(cfg, enc, pass, file) {
  const text = JSON.stringify(cfg, null, 2) + '\n';
  const payload = enc ? crypt.encryptText(text, pass) : text;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  const back = fs.readFileSync(tmp, 'utf8');
  if ((enc ? crypt.decryptText(back, pass) : back) !== text) { fs.unlinkSync(tmp); throw new Error('Read-back verification failed'); }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

function httpsHealth(port, path = '/health') {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 6000, ca: fs.readFileSync(CA), servername: 'localhost' },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

const isPure = (t) => !!(t && t.enable);
const isDual = (t) => !!(t && t.enable && t.port != null);

(async () => {
  const names = fs.readdirSync(path.join(ROOT, 'data')).filter(f => /^config(\..+)?\.json$/.test(f)).map(instName).sort();
  const targets = ONLY ? names.filter(n => ONLY.includes(n)) : names;

  const used = new Set();
  for (const n of names) {
    const { cfg } = readCfg(n);
    const hp = Number((cfg.listen || {}).port || 0);
    if (hp) used.add(hp);
  }

  const rows = [];
  for (const n of targets) {
    const { cfg } = readCfg(n);
    const hp = Number((cfg.listen || {}).port || 0);
    const t = cfg.tls || {};

    if (OFF) { rows.push({ n, hp, tp: '-', state: isPure(t) || isDual(t) ? 'off' : 'already off' }); continue; }

    if (isPure(t)) { rows.push({ n, hp, tp: n === 'default' ? hp : '-', state: 'already on (skipped)' }); continue; }
    rows.push({ n, hp, tp: n === 'default' ? hp : '-', state: isDual(t) ? 'dual→single-port' : 'newly on' });
  }

  const W = Math.max(...rows.map(r => r.n.length), 8);
  console.log(`${OFF ? 'Disable' : 'Enable single-port HTTPS'} plan${DRY ? ' (dry-run, nothing written)' : ''}`);
  console.log('Instance'.padEnd(W) + '  own port   HTTPS entry  state');
  for (const r of rows) {
    const entry = OFF ? '-' : (r.n === 'default' ? 'https:' + r.hp : (r.state.includes('跳过') ? '-' : '/主端口/' + r.n + '/'));
    console.log(r.n.padEnd(W) + '  ' + String(r.hp).padEnd(9) + ' ' + String(entry).padEnd(10) + ' ' + (r.error || r.state));
  }
  if (rows.some(r => r.error)) { console.error('✗ Some instances could not get a port; nothing was changed'); process.exit(1); }
  if (DRY) return;

  let changed = 0;
  for (const r of rows) {
    if (r.state.includes('跳过')) continue;
    const { cfg, enc, pass, file } = readCfg(r.n);
    cfg.tls = OFF ? { enable: false } : { enable: true, cert: 'cert.pem', key: 'key.pem' };
    writeCfg(cfg, enc, pass, file);
    changed++;
  }
  console.log(`✓ 已更新 ${changed} 个实例配置（加密配置仍保持加密）`);
  if (!OFF) console.log('  ⚠ default 之外开 TLS 的实例不再监听自身端口, 只能经主端口 HTTPS + /实例名/ 访问');

  if (flag('no-restart')) { console.log('  未重启，执行：agw.sh restart'); return; }

  const { execSync } = require('child_process');
  console.log('• 重启网关…');
  try { execSync(`bash ${path.join(ROOT, 'agw.sh')} restart`, { stdio: 'ignore', timeout: 120000 }); } catch (e) {}
  await new Promise(r => setTimeout(r, 5000));

  if (OFF) { console.log('✓ 已全部关闭'); return; }
  const defRow = rows.find(r => r.n === 'default');
  const mainPort = defRow ? defRow.hp : 0;
  let ok = 0; const fail = [];
  for (const r of rows) {
    const hp = r.hp;
    const path = r.n === 'default' ? '/health' : '/' + r.n + '/v1/models';
    const port = mainPort || hp;
    const code = await httpsHealth(port, path);
    if (code === 200 || code === 401) ok++; else fail.push(`${r.n}:${port}${path}(${code})`);
  }
  console.log(`✓ HTTPS 自检: ${ok}/${rows.length} 通过 (经主端口 ${mainPort})`);
  if (fail.length) { console.log('✗ 失败: ' + fail.join(', ')); process.exitCode = 1; }
})();
