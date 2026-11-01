#!/usr/bin/env node
'use strict';
/*
 * Periodic rotation of client keys (instance apiKey cards) -- zero-downtime edition.
 *
 * Why not rotate the gatewayKey:
 *   gatewayKey is a single-valued field: changing it invalidates every client at once, with no overlap window.
 *   apiKeys supports multiple entries + expiresAt, so a new key can ship while old keys stay valid through a grace period.
 *   to rotate a gatewayKey use --gateway <instance> --yes (clients break immediately; only do this in the night window).
 *
 * Goes through the admin HTTP API (gateway's internal saveCfg re-encrypts + hotReloads) instead of editing config.json directly,
 * so it never races the panel/gateway writes, and no process restart is needed.
 *
 * Usage:
 *   node ops/rotate-keys.js --list
 *   node ops/rotate-keys.js --dry-run
 *   node ops/rotate-keys.js --if-due          # rotate only when due (called by guard.sh)
 *   node ops/rotate-keys.js --now             # rotate now (writes only with --yes)
 *   node ops/rotate-keys.js --gateway qwen --yes   # replace an instance's gatewayKey immediately (destructive)
 * Options: --inst default  --rotate-days 90  --grace-days 14  --quiet
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const crypt = require(path.join(ROOT, 'crypt.js'));
const { utf8 } = require(path.join(ROOT, 'util.js'));
const STATE_FILE = path.join(ROOT, 'data', '.keyrotation.json');
const LOG_FILE = path.join(ROOT, 'data', 'log', 'keyrotation.log');
const CA_FILE = path.join(ROOT, 'tls', 'ca.pem');
const AUTO_PREFIX = 'auto-';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const QUIET = flag('quiet');

function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  if (!QUIET) console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function resolveInst(name) {
  const all = listInstances();
  if (all.includes(name)) return name;
  const hit = all.find(x => x.toLowerCase() === String(name).toLowerCase());
  if (hit) return hit;
  throw new Error(`Instance "${name}" not found. Available: ${all.join(', ')}`);
}

function cfgFileOf(inst) { return path.join(ROOT, 'data', inst === 'default' ? 'config.json' : `config.${inst}.json`); }

function loadCfg(inst) {
  const f = cfgFileOf(inst);
  if (!fs.existsSync(f)) return null;
  let raw = fs.readFileSync(f, 'utf8');
  if (crypt.isEncText(raw)) {
    const p = crypt.loadPass();
    if (!p) throw new Error('Config is encrypted but no passphrase found');
    raw = crypt.decryptText(raw, p);
  }
  const cfg = JSON.parse(raw);
  cfg._file = f;
  return cfg;
}

function listInstances() {
  return fs.readdirSync(path.join(ROOT, 'data'))
    .filter(f => /^config(\..+)?\.json$/.test(f))
    .map(f => f === 'config.json' ? 'default' : f.slice('config.'.length, -'.json'.length))
    .sort();
}

function loadState() {
  const def = {
    lastRotate: new Date().toISOString(),
    rotateDays: Number(opt('rotate-days', 90)),
    graceDays: Number(opt('grace-days', 14)),
    instances: [opt('inst', 'default')],
  };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...def, ...s };
  } catch (_) { return def; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch (_) {}
}

function api(inst, method, apiPath, body) {
  const cfg = loadCfg(inst);
  if (!cfg) return Promise.reject(new Error(`Instance ${inst} not found`));
  const port = Number((cfg.listen || {}).port || 16384);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.webToken) headers['x-agw-token'] = cfg.webToken;
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  if (payload) headers['Content-Length'] = payload.length;

  const useTls = (cfg.tls || (cfg.listen || {}).tls || {});
const viaHttps = useTls.enable && Number(useTls.port) === port; // TLS only when the instance itself is pure HTTPS
  const mod = viaHttps ? https : http;
  const opts = { host: '127.0.0.1', port, path: apiPath, method, headers, timeout: 15000 };
  if (viaHttps) { opts.ca = fs.readFileSync(CA_FILE); opts.servername = 'localhost'; }

  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const u8 = utf8();
      let buf = '';
      res.on('data', d => buf += u8(d));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 400) return reject(new Error(`${method} ${apiPath} → ${res.statusCode} ${buf.slice(0, 200)}`));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function isActive(k, now) {
  if (k.enable === false) return false;
  if (!k.expiresAt) return true;
  const t = new Date(k.expiresAt).getTime();
  return isNaN(t) ? true : t > now;
}

async function cmdList(state) {
  for (const inst of listInstances()) {
    let cfg;
    try { cfg = loadCfg(inst); } catch (e) { console.log(`${inst}: read failed ${e.message}`); continue; }
    const keys = (cfg.apiKeys || []);
    const auto = keys.filter(k => String(k.name || '').startsWith(AUTO_PREFIX));
    const active = keys.filter(k => isActive(k, Date.now()));
    const gw = cfg.gatewayKey ? `gatewayKey=set(${cfg.gatewayKey.length})` : 'gatewayKey=-';
    if (!keys.length && !cfg.gatewayKey) continue;
    console.log(
      inst.padEnd(32),
      String((cfg.listen || {}).port || '?').padEnd(6),
      gw.padEnd(20),
      `key: ${keys.length} (valid ${active.length}, auto ${auto.length})`
    );
  }
}

async function rotateInstance(inst, state, apply) {
  const cfg = loadCfg(inst);
  if (!cfg) { log(`Skipping ${inst}: config not found`); return null; }
  const now = Date.now();
  const list = await api(inst, 'GET', `/admin/api/keys/${encodeURIComponent(inst)}`);
  const keys = (list && list.keys) || [];
  const auto = keys.filter(k => String(k.name || '').startsWith(AUTO_PREFIX));
  const activeAuto = auto.filter(k => isActive(k, now) && k.expiresAt === '');

  if (activeAuto.length && !flag('now')) {
    log(`${inst}: already has a non-expiring auto key (${activeAuto.map(k => k.name).join(',')}); skipping`);
    return null;
  }

  const name = `${AUTO_PREFIX}${new Date().toISOString().slice(0, 10)}`;
  if (!apply) {
    log(`[dry-run] ${inst}: would create ${name} and set ${auto.filter(k => !k.expiresAt).length} old auto keys' expiresAt to +${state.graceDays} days`);
    return { inst, name, dryRun: true };
  }

  const created = await api(inst, 'POST', `/admin/api/keys/${encodeURIComponent(inst)}`, {
    name, note: 'auto rotation', quotaTokens: 0, expiresAt: '',
  });
  const newKey = created && created.key && created.key.key;
  if (!newKey) throw new Error(`${inst}: key creation failed (no key in response)`);

  const exp = new Date(now + state.graceDays * 86400e3).toISOString();
  let demoted = 0;
  for (const k of auto) {
    if (k.key === newKey) continue;
    if (k.expiresAt) continue;
    await api(inst, 'POST', `/admin/api/keys-update/${encodeURIComponent(inst)}`, { key: k.key, expiresAt: exp });
    demoted++;
  }

// Re-verify: the new key must actually pass gateway auth
  const port = Number((cfg.listen || {}).port || 16384);
  await verifyKey(inst, port, newKey, cfg);

  log(`${inst}: ✓ rotated → ${name}; ${demoted} old keys expire on ${exp.slice(0, 10)}`);
  const outFile = path.join(ROOT, 'data', `.current-key-${inst}`);
  fs.writeFileSync(outFile, newKey + '\n', { mode: 0o600 });
  try { fs.chmodSync(outFile, 0o600); } catch (_) {}
  log(`${inst}: 新 key 写入 ${outFile}（600）；请更新客户端后删除此文件`);
  if (!QUIET) console.log(`  ${newKey}`);
  return { inst, name, key: newKey };
}

function verifyKey(inst, port, key, cfg) {
  const useTls = (cfg.tls || {});
  const httpsPort = useTls.enable && Number(useTls.port);
  const mod = httpsPort ? https : http;
  const opts = { host: '127.0.0.1', port: httpsPort || port, path: '/v1/models', method: 'GET', timeout: 10000,
    headers: { Authorization: 'Bearer ' + key } };
  if (httpsPort) { opts.ca = fs.readFileSync(CA_FILE); opts.servername = 'localhost'; }
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const u8 = utf8();
      let b = ''; res.on('data', d => b += u8(d));
      res.on('end', () => res.statusCode === 200 ? resolve(true)
        : reject(new Error(`${inst}: 新 key 鉴权失败 ${res.statusCode} ${b.slice(0, 120)}`)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function rotateGateway(inst, apply) {
  const cfg = loadCfg(inst);
  if (!cfg) throw new Error(`实例 ${inst} 不存在`);
  if (!cfg.gatewayKey) { log(`${inst}: 未设置 gatewayKey，跳过`); return; }
  const next = 'sk-' + require('crypto').randomBytes(24).toString('base64url').slice(0, Math.min(64, Math.max(8, Number(cfg.keyLength) || 32)));
  if (!apply) { log(`[dry-run] ${inst}: 将把 gatewayKey 换成 ...${next.slice(-4)}（旧 key 立即失效）`); return; }
  await api(inst, 'POST', `/admin/api/config/${encodeURIComponent(inst)}`, { gatewayKey: next });
  log(`${inst}: ✓ gatewayKey 已更换（旧 key 立即失效）`);
  if (!QUIET) console.log(`  ${next}`);
}

process.on('unhandledRejection', (e) => { console.error('✗ ' + (e && e.message ? e.message : e)); process.exit(1); });

(async () => {
  const state = loadState();
  if (flag('list')) return cmdList(state);

  if (flag('gateway')) {
    const inst = resolveInst(opt('gateway'));
    if (!flag('yes') && !flag('dry-run')) { console.error('破坏性操作：加 --yes 才会执行（先 --dry-run 看影响）'); process.exit(2); }
    return rotateGateway(inst, !flag('dry-run'));
  }

  const due = flag('now') || (Date.now() - new Date(state.lastRotate).getTime()) >= state.rotateDays * 86400e3;
  if (!due && flag('if-due')) return;               // guard 的常态：不打印、不写日志
  if (!due && !flag('dry-run')) {
    const left = Math.ceil(state.rotateDays - (Date.now() - new Date(state.lastRotate).getTime()) / 86400e3);
    log(`未到期：还有 ${left} 天（上次 ${state.lastRotate.slice(0, 10)}，周期 ${state.rotateDays} 天）`);
    return;
  }

  const apply = !flag('dry-run') && (flag('now') ? flag('yes') : true);
  if (flag('now') && !flag('yes') && !flag('dry-run')) { console.error('--now 需要 --yes 确认（或先 --dry-run）'); process.exit(2); }

  for (const inst of state.instances) {
    try { await rotateInstance(inst, state, apply); }
    catch (e) { log(`${inst}: ✗ ${e.message}`); process.exitCode = 1; }
  }
  if (apply) { state.lastRotate = new Date().toISOString(); saveState(state); }
})();
