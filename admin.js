'use strict';
/**
 * OpenAGW admin surface, served under the secret prefix /<sid>/admin/ (surface.js strips it):
 *   /<sid>/admin/<token>  one-time link (agw web login) -> login page
 *   /<sid>/admin/login    admin card key + second factor -> session cookie
 *   /<sid>/admin/         M3 panel under m3/ (+ static assets), session required
 *   /<sid>/admin/api/*    JSON API: session cookie, local admin token, webToken or admin card key
 * Without a cookie or token every admin endpoint answers 401 (unknown secret paths answer 404).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const crypto2 = require('crypto');
const https2 = require('https');
const panelAuth = require('./panel-auth');
const mdns = require('./mdns');
const { isEndpointHead } = require('./endpoints');
const { VERSION, utf8 } = require('./util');
const { normalizeOverride } = require('./override');
const logfile = require('./logfile');
const permissions = require('./permissions');
const ratelimit = require('./ratelimit');

// cloudflared tunnel global state
let tunnelProc = null, tunnelUrl = '', tunnelLog = [], tunnelTimer = null, tunnelNext = null;

// DIR prefers the current instance's config directory, falling back to ~/OpenAGW
let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}
let DIR = path.join(os.homedir(), 'OpenAGW');
function setDir(dir) { DIR = dir; }
const CORE = __dirname; // code root: static assets and scripts
const DATA = () => DIR; // data root: config*/ball*/log/.run/plugins-data (injected by gateway setDir)
const MRUN = () => path.join(DIR, '.run');
const MLOG = () => path.join(DIR, 'log');
let upstreamModelsFn = null;
function setUpstreamModels(fn) { upstreamModelsFn = fn; } // injected by gateway: ch -> Promise<model id array>
let syncFn = null;
function setSyncFn(fn) { syncFn = fn; } // injected by gateway: (instance?) -> Promise<sync summary>
//// channel balance lookup implementation: injected by gateway (cfg, ch, cb) -- uses the channel proxy/insecure; see gateway.js fetchChannelBalance
//// opts.cached: the same lookup behind the short client cache (used by the batched panel call)
//// opts.target: ch -> balanceTarget|null, so a batch can skip channels that have no balance endpoint at all
let BALANCE_FN = null, BALANCE_CACHED = null, BALANCE_TARGET = null;
function setBalanceFn(fn, opts) {
  BALANCE_FN = fn;
  BALANCE_CACHED = (opts && opts.cached) || null;
  BALANCE_TARGET = (opts && opts.target) || null;
}
// Multi-instance pool (single-process mode), injected by gateway; null = single-instance run
let POOL = null;
function setPool(p) { POOL = p; }
//// plugin manager: injected by gateway
let PLUGINS = null;
function setPlugins(p) { PLUGINS = p; }
// Instance name/path reserved-word validation: one shared set, imported (paths.js) so the panel
// and the router can never drift apart again.
const { INST_NAME_RE, RESERVED_PATHS } = require('./paths');
//// hot-reload an instance's config (pool mode); throws on failure
function hotReload(name) {
  if (!POOL) {
    // Single-instance mode: the live config must pick up the keys written to disk
    try {
      const c = loadCfg(name);
      const stateMod = require("./state");
      if (c && stateMod.CUR_CFG && (stateMod.CUR_CFG._name || "default") === name) {
        stateMod.CUR_CFG.apiKeys = c.apiKeys || [];

        stateMod.CUR_CFG.adminExpireAt = c.adminExpireAt;
        stateMod.CUR_CFG.adminAuth = c.adminAuth;
        stateMod.CUR_CFG.webToken = c.webToken;
        stateMod.CUR_CFG.requiredPlugins = c.requiredPlugins;
        stateMod.CUR_CFG.plugins = c.plugins;
        stateMod.CUR_CFG.channels = c.channels;
        stateMod.CUR_CFG.proxies = c.proxies;
        stateMod.CUR_CFG.serverInfo = c.serverInfo;
        stateMod.CUR_CFG.layout = c.layout;
      }
    } catch (_) {}
    return false;
  }
  try { POOL.reload(name); } catch (_) {}
  return true;
}
function syncKeysLive(name) {
  // single-instance mode: the live cfg object serves traffic; key changes must apply in memory too
  if (POOL) return;
  try {
    const stateMod = require("./state");
    const live = stateMod.CUR_CFG;
    if (live && (live._name || "default") === name) {
      const disk = loadCfg(name);
      if (disk) live.apiKeys = disk.apiKeys || [];
    }
  } catch (_) {}
}

function cfgFile(name) {
  return name === 'default' ? path.join(DATA(), 'config.json') : path.join(DATA(), `config.${name}.json`);
}
function listInstances() {
  const out = [];
  if (fs.existsSync(path.join(DATA(), 'config.json'))) out.push('default');
  try {
    for (const f of fs.readdirSync(DATA())) {
      const m = /^config\.(.+)\.json$/.exec(f);
      if (m && m[1] !== 'example') out.push(m[1]);
    }
  } catch (_) {}
  return out;
}
/* ---- Derived key cache (performance / never caches plaintext) ----
 * Background: configs are AGWENC1-encrypted on disk. Decryption cost is 100% scrypt key derivation (~51.7ms measured),
 *       AES-GCM decryption itself takes ~0.015ms. loadCfg is called repeatedly on the hot path, and scryptSync
 *       is synchronous -> it would monopolize the event loop and freeze concurrent AI forwarding.
 * Scheme: cache only the 32-byte scrypt-derived key; no plaintext is ever kept in memory.
 *       even on a hit it really decrypts every time (read the latest file -> AES-GCM -> JSON.parse), so the content is always current,
 *       hence no "stale cache" problem and no content/mtime comparisons needed.
 * Invalidation signature = first 16 hex chars of sha256(passphrase) + the file's salt:
 *       - file re-encrypted (salt changed) -> signature changes -> re-derive
 *       - crypt.js changepass -> the signature changes -> re-derive
 *       - if the signature is ever wrong -> AES-GCM auth fails loudly; wrong data is never returned silently
 * Memory: 27 files x 32 bytes = 864 bytes (vs ~106KB for caching plaintext).
 */
const _keyCache = new Map();
function cfgCacheClear() { _keyCache.clear(); }
function _passSig(pass) {
  return crypto2.createHash('sha256').update(String(pass)).digest('hex').slice(0, 16);
}
function loadCfg(name) {
  const f = cfgFile(name);
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  let plain = raw;
  if (crypt && crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) throw new Error('配置已加密但找不到密钥(.agwkey/AGW_CRYPT_PASS), 可用 node crypt.js test 检查');
    const b = Buffer.from(raw.slice(crypt.MAGIC.length), 'base64');
    const salt = b.subarray(0, 16);
    const sig = _passSig(pass) + ':' + Buffer.from(salt).toString('hex');
    let e = _keyCache.get(f);
    if (!e || e.sig !== sig) {
      e = { sig, key: crypt.deriveKey(pass, salt) };
      _keyCache.set(f, e);
    }
    // AES-GCM decrypt with the cached derived key (ciphertext layout: salt[16] | iv[12] | tag[16] | ct)
    const iv = b.subarray(16, 28), tag = b.subarray(28, 44), ct = b.subarray(44);
    const d = crypto2.createDecipheriv('aes-256-gcm', e.key, iv);
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  const c = JSON.parse(plain);
  c._configFile = f;
  c._name = name;
  return c;
}
/* Custom privacy-filter rules: accepts an array or newline text; keeps only compilable regexes (max 50) */
function normalizeRedactExtra(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\r?\n/) : []);
  const out = [];
  for (const x of arr) {
    const p = String(x == null ? '' : x).trim();
    if (!p || p.length > 500) continue;
    try { new RegExp(p); } catch (_) { continue; }
    out.push(p);
    if (out.length >= 50) break;
  }
  return out;
}
function maskRedactCfg(c) {
  const r = (c && c.redact) || {};
  return {
    enable: r.enable !== false,
    response: !!r.response,
    extra: Array.isArray(r.extra) ? r.extra.filter(x => typeof x === 'string') : [],
  };
}
function saveCfg(name, cfg) {
  const f = cfgFile(name);
  // Internal runtime fields (_configFile/_name) must never be persisted into config.json.
  const clean = { ...cfg };
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
  // Legacy multi-user data must never be written back (removed 2026-10).
  delete clean.users;
  delete clean.registration;
  // The 5-minute old-token grace was a full admin window for anyone holding the old token; it is gone.
  delete clean.webTokenPrev;
  delete clean.webTokenPrevUntil;
  const plain = JSON.stringify(clean, null, 2) + '\n';
  let text = plain;
if (crypt) { const pass = crypt.loadPass(); if (pass) text = crypt.encryptText(plain, pass); } // with a passphrase, everything is encrypted on write (fresh salt each time)
  fs.writeFileSync(f, text, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch (_) {}
_keyCache.delete(f); // salt changed; force re-derivation on next read (~51ms each)
}
/* Log tail (rewritten 2026-11-09): the panel used to readFileSync() the whole log and split it.
 * gateway.log is append-only for the life of the process, so after a few weeks it reaches hundreds of
 * MB -- one "logs" refresh then allocated Buffer + string + one string per line of that size and took
 * the gateway down with it on a phone. Read a bounded window off the end instead: memory follows the
 * window, not the file. */
const LOG_MAX_LINES = 2000;         // hard cap on ?lines=; the panel only ever asks for 80..400
const LOG_TAIL_WINDOW = 512 * 1024; // bytes read from the end at most
function readLog(name, lines) {
// Single-process mode: all instances share one gateway.log
  const f = path.join(MLOG(), POOL ? 'gateway.log' : `${name}.log`);
  // Writes are batched by logfile.js; flush first or the panel shows a stale window (up to one buffer)
  try { logfile.flush(); } catch (_) {}
  if (!fs.existsSync(f)) return '(无日志)';
  const want = Math.min(Math.max(1, parseInt(lines, 10) || 50), LOG_MAX_LINES);
  let fd = -1;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    // a log line averages well under 512 bytes; the window never grows with the file
    // 64 KB floor: one abnormal stack-trace/JSON line must not fall outside a tiny window
    const win = Math.max(0, Math.min(size, Math.max(64 * 1024, Math.min(LOG_TAIL_WINDOW, want * 512))));
    const start = size - win;
    const buf = Buffer.allocUnsafe(win);
    let got = 0;
    while (got < win) {
      const n = fs.readSync(fd, buf, got, win - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let txt = buf.toString('utf8', 0, got);
    // starting mid-file: drop the first (possibly half) line
    // starting mid-file: drop the first (possibly half) line; a window that is entirely one
    // over-long line has no newline to cut at, so keep it rather than returning nothing
    if (start > 0) { const nl = txt.indexOf('\n'); txt = nl >= 0 ? txt.slice(nl + 1) : txt; }
    const arr = txt.split('\n');
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr.slice(Math.max(0, arr.length - want)).join('\n');
  } catch (e) {
    return '(读取日志失败: ' + e.message + ')';
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch (_) {} }
  }
}
function pidRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
function getInstanceStatus(name) {
  const pf = path.join(MRUN(), `${name}.pid`);
  let pid = 0, running = false;
  if (fs.existsSync(pf)) {
    pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10) || 0;
    running = pidRunning(pid);
  }
  return { name, pid, running };
}

//// run an agw.sh command (non-blocking, returns a promise)
function runAgw(args) {
  return new Promise(resolve => {
    execFile('bash', [path.join(CORE, 'agw.sh'), ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

// Auto-restart after saving config (300ms so the response flushes first; agw.sh restart is a hot worker swap)
function scheduleRestart(cfg, name) {
  setTimeout(() => {
    if (name === currentName(cfg)) {
      try {
        const tmpScript = path.join(os.tmpdir() || CORE, '.agw-self-restart.sh');
        const agwPath = path.join(CORE, 'agw.sh');
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" restart >> "' + path.join(MLOG(), name + '.log') + '" 2>&1\nrm -f "' + tmpScript + '"\n');
        fs.chmodSync(tmpScript, 0o755);
        const cp = exec('setsid bash "' + tmpScript + '" </dev/null >/dev/null 2>&1 &', { stdio: 'ignore' }, () => {});
        try { cp.unref(); } catch (_) {}
      } catch (_) {}
    } else {
      try { runAgw(['restart', name]); } catch (_) {}
    }
  }, 300);
}

//// admin auth
/* ---- TOTP (RFC 6238, SHA1, 30s window, 6 digits) ---- */
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s || '').toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(val >> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
function totpCode(secretB32, offsetStep = 0) {
  try {
    const key = base32Decode(secretB32);
    if (!key.length) return null;
    const counter = Math.floor(Date.now() / 1000 / 30) + offsetStep;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto2.createHmac('sha1', key).update(buf).digest();
    const o = h[h.length - 1] & 0xf;
    const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1000000;
    return String(code).padStart(6, '0');
  } catch (_) { return null; }
}
function totpVerify(secretB32, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (const off of [-1, 0, 1]) if (totpCode(secretB32, off) === c) return true;
  return false;
}

//// admin auth: panel session cookie / runtime admin token / optional webToken
// Session cookie name is port-scoped: cookies are not isolated per port, and several gateways may run
// side by side on 127.0.0.1 -- a fixed name would let one login overwrite another instance's session.
function sessCookieName(cfg) {
  const port = Number((cfg && cfg.listen && cfg.listen.port) || 0);
  return port ? 'agwSID_' + port : 'agwSID';
}
function panelStateOf(cfg) {
  try { return panelAuth.read(cfg, cfg._name || currentName(cfg)); } catch (_) { return null; }
}
// Admin-role card keys are what the WebUI login page asks for. With none configured the
// gateway is a local/keyless setup: the one-time link alone opens the panel, as before.
function adminKeysOf(cfg) {
  return (cfg.apiKeys || []).filter(k => k && k.role === 'admin' && k.enable !== false);
}
function needsPanelLogin(cfg) {
  const aa = cfg.adminAuth || {};
  return adminKeysOf(cfg).length > 0 || !!(aa.secondKey || aa.totpSecret);
}

/* The browser session entry behind the current request's cookie.
 * Entries: {exp, panelSid} legacy, {exp, panelSid, pending:true} right after a one-time link,
 * {exp, panelSid, login:true} after the login page (admin card key + second factor). */
function readSessEnt(cfg, req) {
  const h = (req && req.headers) || {};
  const panelState = panelStateOf(cfg);
  const map = cfg._webSess || panelAuth.sessionsOf(cfg, cfg._name || currentName(cfg));
  if (!map) return null;
  const ck = String(h.cookie || '');
  const names = [sessCookieName(cfg)];
  if (sessCookieName(cfg) !== 'agwSID') names.push('agwSID');
  for (const nm of names) {
    const m = ck.match(new RegExp('(?:^|;\\s*)' + nm + '=([A-Za-z0-9_-]{16,})'));
    if (!m) continue;
    const ent = map.get ? map.get(m[1]) : map[m[1]];
    if (typeof ent === 'number') {
      if (ent > Date.now()) return { sid: m[1], exp: ent };
      continue;
    }
    if (ent && Number(ent.exp) > Date.now()) {
      if (!ent.panelSid || (panelState && ent.panelSid === panelState.sid)) {
        const out = {};
        for (const k of Object.keys(ent)) out[k] = ent[k];
        out.sid = m[1];
        return out;
      }
    }
  }
  return null;
}

// The WebUI page itself: a session is required, and on an instance that has admin cards (or a
// second factor) the session must be one the login page issued.
function panelSessionOk(cfg, req) {
  const ent = readSessEnt(cfg, req);
  if (!ent) return false;
  if (ent.login === true) return true;
  return !needsPanelLogin(cfg);
}

function checkAdminAuth(cfg, req, query, opts = {}) {
// Panel session expiry: clears all sessions at the deadline and persists the reset
  if (cfg.adminExpireAt > 0 && Date.now() >= cfg.adminExpireAt) {
    cfg.adminExpireAt = 0;
    if (cfg._webSess) cfg._webSess.clear();
    if (cfg._webSessPend) cfg._webSessPend.clear();
    try { panelAuth.revoke(cfg, cfg._name || currentName(cfg)); } catch (_) {}
    try { const nm = cfg._name || currentName(cfg); const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = 0; saveCfg(nm, disk); } } catch (_) {}
  }
  const h = (req && req.headers) || {};
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const supplied = [bearer, h['x-agw-token'], query && query.get('key')].filter(Boolean);
  const panelState = panelStateOf(cfg);
  let mainOk = false;
  let sess = null;

// Optional long-lived API token (kept for scripts; the panel itself only accepts a login session)
  if (!opts.panel) {
    if (cfg.webToken && supplied.includes(cfg.webToken)) mainOk = true;
    if (!mainOk && cfg.webToken && (h.cookie || '').includes(`agwWeb=${cfg.webToken}`)) mainOk = true;
    if (!mainOk && panelState && panelState.adminToken && supplied.includes(panelState.adminToken)) mainOk = true;
// ---- Admin API keys (apiKeys with role "admin"): accepted as Bearer / x-agw-token / ?key= ----
    if (!mainOk) {
      const adminTok = bearer || h['x-agw-token'] || (query && query.get('key')) || '';
      if (adminTok) {
        const adminKey = (cfg.apiKeys || []).find(k => k.key === adminTok && k.role === 'admin' && k.enable !== false);
        if (adminKey) mainOk = true;
      }
    }
  }

// Browser session cookie: the one-time link (keyless setups) or the login page issued it
  if (!mainOk) {
    sess = readSessEnt(cfg, req);
    if (sess) mainOk = true;
  }

  if (!mainOk) return false;

// A card / 2FA instance only trusts a session that went through the login page. Token callers
// are exempt: they carry their own second factor as headers on every call.
  if (sess && needsPanelLogin(cfg) && sess.login !== true) return false;
  if (opts.panel) return true;

// ---- Second factor (the login page already validated it for its session) ----
  const aa = cfg.adminAuth || {};
  if (!aa.secondKey && !aa.totpSecret) return true;
  if (sess && sess.login === true) return true;
  if (aa.secondKey && (h['x-admin-key2'] === aa.secondKey || (query && query.get('adminKey2') === aa.secondKey))) return true;
  if (aa.totpSecret && totpVerify(aa.totpSecret, h['x-totp'] || (query && query.get('totp')))) return true;
  return false;
}

function jsonRes(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
  res.end(body);
}
function textRes(res, status, text, ct, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': ct || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' }, extra || {}));
  res.end(text);
}

// Merge rules for the three balance-passthrough fields (one convention, reused by config save and single-channel save):
//   key absent from the body (undefined) -> inherit the old value; explicit empty string/null -> clear (never stores "")
const BALANCE_KEYS = ['balanceUrl', 'balancePath', 'balanceUnit', 'warnBelow'];
function mergeBalanceFields(out, prev) {
  for (const k of BALANCE_KEYS) {
    if (out[k] === undefined) { if (prev && prev[k] !== undefined) out[k] = prev[k]; }
    else if (out[k] === '' || out[k] === null) delete out[k];
  }
  return out;
}

function normalizeChannelPath(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return null;
  if (s.charAt(0) !== '/') s = '/' + s;
  return s;
}

// Extract masked channel info from the config (the key never leaves)
function maskedChannels(cfg, reveal) {
  return (cfg.channels || []).map(c => ({
    name: c.name, type: c.type, baseUrl: c.baseUrl, path: normalizeChannelPath(c.path),
    proxy: c.proxy || null, models: c.models, modelMap: c.modelMap,
    default: c.default, hasKey: !!(c.apiKey && c.apiKey.length),
    useResponses: c.useResponses === undefined ? undefined : !!c.useResponses, delayMs: c.delayMs || 0, probe: !!c.probe,
    insecure: !!c.insecure, addUsage: c.addUsage !== false, anthropicVersion: c.anthropicVersion || null,
    lockAt: c.lockAt || null, lockUntil: c.lockUntil || null,
// Balance passthrough config (non-sensitive, panel-editable; default = built-in presets)
    balanceUrl: c.balanceUrl || null, balancePath: c.balancePath || null, balanceUnit: c.balanceUnit || null,
    warnBelow: c.warnBelow || null,
    // gateway-side parameter override (non-sensitive, panel-editable)
    paramOverride: c.paramOverride || null,
    keyPrefix: c.apiKey ? c.apiKey.slice(0, 4) + '***' : '',
    apiKey: reveal ? (c.apiKey || '') : undefined,
  }));
}

//// current instance name (config.json -> 'default', config.xxx.json -> 'xxx')
function currentName(cfg) {
  if (!cfg._configFile) return 'default';
  const base = path.basename(cfg._configFile, '.json');
  if (base === 'config') return 'default';
  return base.replace(/^config\./, '');
}

//// proxy over local loopback to the target instance for JSON (cross-instance stats/requests)
//// always go through /admin/api/<path> (with the target's webToken or local panel admin token)
function proxyInstance(targetName, adminPath) {
  return new Promise(resolve => {
    const tc = loadCfg(targetName);
    if (!tc) return resolve(null);
    // when the target instance has TLS on (including same-port pure HTTPS), the local loopback must use https
    const tcTls = tc.tls || {};
    const main = loadCfg('default');
    const mainPort = Number((main && main.listen || {}).port) || 16384;
    // A TLS instance has no listener of its own: it lives behind the main port's HTTPS
    const useTls = !!tcTls.enable;
    const viaMain = targetName !== 'default' && (useTls || Number((tc.listen || {}).port || 16384) === mainPort);
    const port = viaMain ? mainPort : ((tc.listen || {}).port || 16384);
    const mod = (viaMain ? !!((main || {}).tls && main.tls.enable) : useTls) ? https2 : http;
const tlsOpt = mod === https2 ? { rejectUnauthorized: false } : {}; // loopback targets are signed by the private CA
    const targetPanel = panelAuth.read(tc, targetName);
    const webToken = (targetPanel && targetPanel.adminToken) || tc.webToken || '';
    // The target process accepts admin calls only under its secret panel prefix; the sid lives in the
    // shared state file, so a sibling process on the same data dir answers the same URL.
    let prefix = '';
    try { prefix = '/' + panelAuth.ensure(tc, targetName).sid; } catch (_) {}
    const tryAdmin = () => {
      const opts = Object.assign({ host: '127.0.0.1', port, path: prefix + '/admin/api/' + adminPath, method: 'GET', timeout: 5000 }, tlsOpt);
      if (webToken) opts.headers = { 'x-agw-token': webToken };
      const r = mod.request(opts, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
          if (resp.statusCode === 200) { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }
          else resolve(null);
        });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
      r.end();
    };
    tryAdmin();
  });
}

/* ====================== Handle admin requests ====================== */
// cfg = current instance config, req, res, u = URL object, p = pathname, bodyStr = request body
/* ====================== Floating ball config whitelist ======================
 * The APP-side floating ball's look/labels are written by POST /admin/api/ball/<inst> into ball.<inst>.json,
 * The APP polls GET /admin/api/ball/<inst> every 60s and does nothing at all when the hash is unchanged.
 * Anything outside the whitelist gets 400: better to error than to carry keys the APP does not recognize and silently ignores.
 */
const BALL = (() => {
  const NUM = {
    sizeDp: [40, 88], gaugeWidth: [60, 200], panelDp: [240, 340],
    shape: [0, 3], pill: [0, 2], chip: [0, 3], rowsMask: [0, 63],
    dimSec: [1, 30], dimAlpha: [10, 100], balanceWarnBelow: [0, 1000000],
    scale: [0.8, 1.3]
  };
  const FLAG = ['snap', 'dim', 'blur', 'lock', 'balanceRow', 'pinExpanded'];
  const STR = { rowsOrder: /^[0-9,]{0,40}$/, iconUri: /^.{0,300}$/ };
  const COLOR = ['gaugeColor', 'bg'];
  // structured ball UI description: rings / ringStyle / rows / bubble / on / radial
  const OBJ_KEYS = ['ringStyle', 'bubble', 'radial', 'perform', 'noti'];
  const TONES = ['ok', 'warn', 'danger', 'info', 'muted', 'primary'];
  const ALL = () => [].concat(Object.keys(NUM), FLAG, Object.keys(STR), COLOR, ['phrases'], OBJ_KEYS);

  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v, lo, hi) => typeof v === 'string' && v.length >= lo && v.length <= hi;
  const actOk = a => isObj(a) && isStr(a.type, 1, 24);

/** content_* group = one panel row: {order, label, data, text} */
  function contentGroup(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (v.label !== undefined) {
      if (!isStr(v.label, 1, 24)) return { error: k + '.label 需为 1..24 字符串' };
      o.label = v.label;
    }
    if (v.data !== undefined) {
      if (!isStr(v.data, 1, 64)) return { error: k + '.data 需为 1..64 字符串' };
      o.data = v.data;
    }
    if (v.text !== undefined) {
      if (!isStr(v.text, 0, 200)) return { error: k + '.text 需为 ≤200 字符串' };
      o.text = v.text;
    }
    return { value: o };
  }

/** radial_* group = one button */
  function radialItem(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (!isStr(v.label, 1, 8)) return { error: k + '.label 必填 (1..8 字)' };
    o.label = v.label;
    if (v.tone !== undefined) {
      if (!TONES.includes(v.tone)) return { error: k + '.tone 只能是 ' + TONES.join('/') };
      o.tone = v.tone;
    }
    if (!actOk(v.do)) return { error: k + '.do 需形如 {type:"..."}' };
    o.do = v.do;
    return { value: o };
  }

/** touch_* group = one gesture */
  function touchItem(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (!['click', 'double', 'long', 'long_hold'].includes(v.on)) {
      return { error: k + '.on 只能是 click/double/long/long_hold' };
    }
    o.on = v.on;
    if (v.on === 'long_hold') {
      const n = Number(v.hold);
      if (!(n >= 100 && n <= 2000)) return { error: k + '.hold 需在 100..2000 毫秒' };
      o.hold = n;
      return { value: o };
    }
    if (!(actOk(v.do) || (Array.isArray(v.do) && v.do.length && v.do.every(actOk)))) {
      return { error: k + '.do 需动作对象或动作数组' };
    }
    o.do = v.do;
    return { value: o };
  }

/** chain_* group = one chained rule: condition like when, do is an action array, delay is the inter-segment wait */
  function chainGroup(k, v) {
    const base = whenCond(k, v);
    if (base.error) return base;
    if (!Array.isArray(v.do) || !v.do.length || v.do.length > 8) return { error: k + '.do 必须是 1..8 条动作的数组' };
    if (!v.do.every(actOk)) return { error: k + '.do 每项需形如 {type:"..."}' };
    const o = base.value;
    o.do = v.do;
    if (v.delay !== undefined) {
      const n = Number(v.delay);
      if (!(n >= 0 && n <= 60)) return { error: k + '.delay 需在 0..60 秒' };
      o.delay = n;
    }
    return { value: o };
  }

/** when_* group = one event rule: {order, on, lt/gt/eq/match, do, cooldown} */
  const EV_ACTS = ['expand', 'collapse', 'toggle', 'menu', 'reload', 'open', 'copy', 'toast',
    'mute', 'intent', 'sequence', 'bubble', 'notify'];
  function whenCond(k, v) {
    if (!isObj(v)) return { error: k + ' 必须是对象' };
    const o = {};
    if (!isStr(v.on, 1, 24)) return { error: k + '.on 必填 (事件名, 1..24)' };
    o.on = v.on;
    if (v.order !== undefined) {
      const n = Number(v.order);
      if (!Number.isFinite(n) || n < 0 || n > 99) return { error: k + '.order 需在 0..99' };
      o.order = n;
    }
    if (v.field !== undefined) {
      if (!isStr(v.field, 1, 16)) return { error: k + '.field 需为字符串' };
      o.field = v.field;
    }
    for (const nk of ['lt', 'gt']) {
      if (v[nk] === undefined) continue;
      const n = Number(v[nk]);
      if (!Number.isFinite(n)) return { error: k + '.' + nk + ' 必须是数字' };
      o[nk] = n;
    }
    for (const sk of ['eq', 'match']) {
      if (v[sk] === undefined) continue;
      if (!isStr(v[sk], 1, 64)) return { error: k + '.' + sk + ' 需为 1..64 字符串' };
      o[sk] = v[sk];
    }
    if (v.cooldown !== undefined) {
      const n = Number(v.cooldown);
      if (!Number.isFinite(n) || n < 0 || n > 86400) return { error: k + '.cooldown 需在 0..86400 秒' };
      o.cooldown = n;
    }
    if (v.label !== undefined) {
      if (!isStr(v.label, 1, 24)) return { error: k + '.label 需为 1..24 字符串' };
      o.label = v.label;
    }
    return { value: o };
  }

/** when_* = condition + single action */
  function whenGroup(k, v) {
    const r = whenCond(k, v);
    if (r.error) return r;
    if (!isObj(v.do)) return { error: k + '.do 必须是动作对象' };
    if (!EV_ACTS.includes(v.do.type)) return { error: k + '.do.type 只允许 ' + EV_ACTS.join('/') };
    const o = r.value;
    o.do = v.do;
    return { value: o };
  }

/** ring_* group = one ring: {order, data, color} */
  function ringGroup(name, v) {
    if (!isObj(v)) return { error: name + ' 必须是对象' };
    if (!Number.isFinite(Number(v.order))) return { error: name + '.order 必须是数字' };
    if (!isStr(v.data, 1, 80)) return { error: name + '.data 需 1..80 字符' };
    if (v.color !== undefined) {
      const okHex = typeof v.color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.color);
      if (!okHex && !TONES.includes(v.color)) return { error: name + '.color 需语义色或 #RRGGBB' };
    }
    return { value: { order: Number(v.order), data: v.data, color: v.color || 'primary' } };
  }

/** New four groups: perform / thing / bubble / content / touch */
  function structured2(k, v) {
    if (k === 'perform') {
      if (!isObj(v)) return { error: 'perform 必须是对象' };
      const R = { zoom: [0.5, 2], roll: [0, 3600], side: [0, 3600], dark: [0, 3600], lock: [0, 1] };
      for (const n of Object.keys(R)) {
        if (v[n] !== undefined && !(Number(v[n]) >= R[n][0] && Number(v[n]) <= R[n][1]))
          return { error: 'perform.' + n + ' 需在 ' + R[n][0] + '..' + R[n][1] };
      }
      if (v.alpha !== undefined) {
        const okNum = Number.isFinite(Number(v.alpha)) && Number(v.alpha) >= 0 && Number(v.alpha) <= 100;
        const okHex = typeof v.alpha === 'string' && /^#([0-9a-fA-F]{2}|[0-9a-fA-F]{8})$/.test(v.alpha);
        if (!okNum && !okHex) return { error: 'perform.alpha 需 0..100 或 #RRGGBBAA' };
      }
      if (v.icon !== undefined && !isStr(v.icon, 1, 300)) return { error: 'perform.icon 需 1..300 字符' };
      return { value: v };
    }
    if (k === 'bubble' || k === 'content') {
      if (!isObj(v)) return { error: k + ' 必须是对象' };
      if (v.order !== undefined && !Number.isFinite(Number(v.order))) return { error: k + '.order 必须是数字' };
      if (v.data !== undefined && !isStr(v.data, 1, 80)) return { error: k + '.data 需 1..80 字符' };
      if (v.text !== undefined) {
        const arr = Array.isArray(v.text);
        if (arr ? !v.text.every(t => isStr(t, 0, 160)) : !isStr(v.text, 0, 160))
          return { error: k + '.text 需字符串或字符串数组（每条 ≤160）' };
      }
      return { value: v };
    }
    if (k === 'thing') {
      if (!isObj(v)) return { error: 'thing 必须是对象' };
      for (const key of ['click', 'double', 'long', 'context_warn', 'balance_warn']) {
        if (v[key] === undefined) continue;
        const list = Array.isArray(v[key]) ? v[key] : [v[key]];
        if (list.length > 8) return { error: 'thing.' + key + ' 最多 8 个动作' };
        for (const a of list) if (!actOk(a)) return { error: 'thing.' + key + ' 的动作需形如 {type:"..."}' };
      }
      if (v.long_hold !== undefined && !(Number(v.long_hold) >= 100 && Number(v.long_hold) <= 2000))
        return { error: 'thing.long_hold 需在 100..2000 ms' };
      return { value: v };
    }
    if (k === 'touch') {
      const list = Array.isArray(v) ? v : null;
      if (!list) return { error: 'touch 必须是字符串数组（声明可用的手势名）' };
      if (list.length > 12) return { error: 'touch 最多 12 项' };
      for (const t of list) if (!isStr(t, 1, 24)) return { error: 'touch 每项需 1..24 字符' };
      return { value: list };
    }
    return { error: '未知组 ' + k };
  }

  function structured(k, v) {
    if (k === 'perform') return structured2('perform', v);
    if (k === 'ringStyle') {
      if (!isObj(v)) return { error: 'ringStyle 必须是对象' };
      if (v.mode !== undefined && !['ring', 'bars'].includes(v.mode)) return { error: 'ringStyle.mode 只能是 ring/bars' };
      if (v.side !== undefined && !['left', 'right'].includes(v.side)) return { error: 'ringStyle.side 只能是 left/right' };
      for (const n of ['stroke', 'gap']) {
        if (v[n] !== undefined && !(Number(v[n]) >= 0.5 && Number(v[n]) <= 8)) return { error: 'ringStyle.' + n + ' 需在 0.5..8' };
      }
      return { value: v };
    }
    if (k === 'bubble') {
      if (!isObj(v)) return { error: 'bubble 必须是对象' };
      const o = {};
      if (v.order !== undefined) o.order = Number(v.order);
      if (v.data !== undefined) { if (!isStr(v.data, 1, 64)) return { error: 'bubble.data 需 1..64 字符' }; o.data = v.data; }
      if (v.text !== undefined) {
        if (!(isStr(v.text, 0, 200) || (Array.isArray(v.text) && v.text.length <= 4 && v.text.every(x => isStr(x, 0, 120))))) {
          return { error: 'bubble.text 需字符串或 ≤4 条字符串数组' };
        }
        o.text = v.text;
      }
      return { value: o };
    }
    if (k === 'radial') {
      if (!isObj(v)) return { error: 'radial 必须是对象' };
      const o = {};
      if (v.radius !== undefined) {
        const n = Number(v.radius);
        if (!(n >= 40 && n <= 160)) return { error: 'radial.radius 需在 40..160' };
        o.radius = n;
      }
      return { value: o };
    }
    if (k === 'noti') {
      if (!isObj(v)) return { error: 'noti 必须是对象' };
      const o = {};
      if (v.name !== undefined) { if (!isStr(v.name, 1, 24)) return { error: 'noti.name 需 1..24 字符' }; o.name = v.name; }
      if (v.text !== undefined) { if (!isStr(v.text, 0, 200)) return { error: 'noti.text 需 ≤200 字符' }; o.text = v.text; }
      if (v.time !== undefined) { if (!isStr(v.time, 0, 32)) return { error: 'noti.time 需 ≤32 字符' }; o.time = v.time; }
      if (v.silence !== undefined) { o.silence = Number(v.silence) ? 1 : 0; }
      return { value: o };
    }
    return { error: '未知键 ' + k };
  }

/** ring_* orders must be unique */
  function orderClash(obj, skipKey) {
    const seen = new Map();
    for (const k of Object.keys(obj)) {
      if (k === skipKey) continue;
      if (!/^ring_/.test(k)) continue;
      const o = obj[k] && obj[k].order;
      if (o === undefined) continue;
      if (seen.has(o)) return 'order=' + o + ' 在 ' + seen.get(o) + ' 与 ' + k + ' 重复';
      seen.set(o, k);
    }
    return null;
  }

  function validate(src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return { error: 'look 必须是对象' };
    const out = {};
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (k in NUM) {
        const n = Number(v), lo = NUM[k][0], hi = NUM[k][1];
        if (!Number.isFinite(n) || n < lo || n > hi) return { error: k + ' 需在 ' + lo + '..' + hi };
        out[k] = n;
      } else if (FLAG.includes(k)) {
        if (typeof v !== 'boolean') return { error: k + ' 必须是布尔' };
        out[k] = v;
      } else if (k in STR) {
        if (typeof v !== 'string' || !STR[k].test(v)) return { error: k + ' 格式不合法' };
        out[k] = v;
      } else if (COLOR.includes(k)) {
        const okHex = typeof v === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
        if (!okHex && v !== 0 && v !== '0') return { error: k + ' 需为 "#RRGGBB" / "#AARRGGBB" / 0' };
        out[k] = v;
      } else if (k === 'phrases') {
        if (!Array.isArray(v) || v.length > 40) return { error: 'phrases 必须是 ≤40 条的数组' };
        if (!v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 40)) return { error: 'phrases 每条 1..40 字符' };
        out[k] = v;
      } else if (/^ring_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = ringGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^content_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = contentGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^radial_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = radialItem(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^touch_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = touchItem(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^chain_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = chainGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (/^when_[a-zA-Z0-9_]{1,16}$/.test(k)) {
        const r = whenGroup(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else if (k === 'when') {
        if (!Array.isArray(v) || v.length > 12) return { error: 'when 必须是 ≤12 条的数组' };
        const arr = [];
        for (let i = 0; i < v.length; i++) {
          const r = whenGroup('when[' + i + ']', v[i]);
          if (r.error) return { error: r.error };
          arr.push(r.value);
        }
        out[k] = arr;
      } else if (OBJ_KEYS.includes(k)) {
        const r = structured(k, v);
        if (r.error) return { error: r.error };
        out[k] = r.value;
      } else {
        return { error: '未知键 ' + k, allowed: ALL() };
      }
    }
    return { value: out };
  }
  const hashOf = o => require('crypto').createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);
  return { validate, keys: ALL, hashOf, orderClash };
})();

// ---- announcements: panel notices, stored in <DIR>/announcements.json (newest first) ----
// Gateway-level content (not per-channel config): every panel page/instance of this data dir shares one file.
function loadAnnouncements() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA(), 'announcements.json'), 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch (_) { return []; }
}
function saveAnnouncements(items) {
  fs.writeFileSync(path.join(DATA(), 'announcements.json'), JSON.stringify({ items }, null, 2));
}

async function handleAdmin(cfg, req, res, u, p, bodyStr) {
// The secret sid is part of the URL prefix (/<sid>/admin/...): surface.js stripped it and
// recorded it on the request, so every redirect here rebuilds the same shape.
  const inst = cfg._name || currentName(cfg);
  const panelState = panelStateOf(cfg);
  const sid = (req && req._panelSid) || (panelState && panelState.sid) || '';
  const base = sid ? '/' + sid + '/admin' : '';
  const method = req.method;
  const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };
  const htmlErr = (status, title, msg) => textRes(res, status,
    '<!doctype html><meta charset="utf-8"><title>' + title + '</title>'
    + '<body style="font-family:system-ui,sans-serif;background:#141218;color:#e6e1e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
    + '<div style="max-width:560px;padding:24px;line-height:1.8">' + msg + '</div></body>',
    'text/html; charset=utf-8', noStore);

// ---- session helpers: prune stale entries, cap the map, persist on every change ----
  const sessMapOf = () => panelAuth.sessionsOf(cfg, inst) || (cfg._webSess = cfg._webSess || new Map());
  const delSess = (map, k) => { if (map.delete) map.delete(k); else delete map[k]; };
  const issueWebSess = (login) => {
    const now = Date.now();
    const map = sessMapOf();
    for (const [k, v] of (map.entries ? map : Object.entries(map))) {
      const exp = typeof v === 'number' ? v : Number(v && v.exp) || 0;
      const stale = v && typeof v === 'object' && v.panelSid && (!panelState || v.panelSid !== panelState.sid);
      if (exp <= now || stale) delSess(map, k);
    }
    if ((map.size != null ? map.size : Object.keys(map).length) >= 64) delSess(map, map.keys ? map.keys().next().value : Object.keys(map)[0]);
    const raw = crypto2.randomBytes(32).toString('base64url');
    const ent = { exp: now + (login ? 7 * 864e5 : 15 * 60e3), panelSid: panelState ? panelState.sid : '' };
    if (login) ent.login = true; else ent.pending = true;
    if (map.set) map.set(raw, ent); else map[raw] = ent;
    try { panelAuth.sessionsSave(cfg, inst); } catch (_) {}
    const secure = !!(req.socket && req.socket.encrypted) || ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
    return `${sessCookieName(cfg)}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${login ? 604800 : 900}${secure ? '; Secure' : ''}`;
  };
  const upgradeSess = (ent) => {
    const map = sessMapOf();
    const cur = map.get ? map.get(ent.sid) : map[ent.sid];
    if (!cur) return false;
    const next = Object.assign({}, typeof cur === 'object' ? cur : {}, { exp: Date.now() + 7 * 864e5, panelSid: panelState ? panelState.sid : '', login: true });
    delete next.pending; delete next.tries;
    if (map.set) map.set(ent.sid, next); else map[ent.sid] = next;
    try { panelAuth.sessionsSave(cfg, inst); } catch (_) {}
    return true;
  };

// ---- 0) bare /admin (compat ports only; the main port gates before this): normalise the slash ----
  if (p === '/admin') {
    if (method !== 'GET' && method !== 'HEAD') return textRes(res, 405, '不支持的方法: ' + method + ' ' + p);
    if (!sid) return htmlErr(404, '404', 'not found');
    const ent = readSessEnt(cfg, req);
    if (ent && ent.login === true) { res.writeHead(302, { Location: base + '/', ...noStore }); return res.end(); }
    if (ent && ent.pending) { res.writeHead(302, { Location: base + '/login', ...noStore }); return res.end(); }
    return htmlErr(401, '401', '没有有效会话。请在服务器执行 <code>agw web login</code> 取得一次性登录链接。');
  }

// ---- 1) login-info (matched before the one-time token shape: "login-info" fits it too) ----
  if (p === '/admin/login-info') {
    if (method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET', Allow: 'GET' });
    const ent = readSessEnt(cfg, req);
    if (!ent) return jsonRes(res, 401, { error: '需要先通过一次性登录链接进入' });
    const aa = cfg.adminAuth || {};
    return jsonRes(res, 200, { ok: true, keyRequired: adminKeysOf(cfg).length > 0, secondKey: !!aa.secondKey, totp: !!aa.totpSecret, login: ent.login === true });
  }

// ---- 2) login page /admin/login: admin card key + second factor -> session cookie ----
  if (p === '/admin/login' || p === '/admin/login/') {
    const ent = readSessEnt(cfg, req);
    if (method === 'GET' || method === 'HEAD') {
      if (!sid) return htmlErr(404, '404', 'not found');
      if (ent && ent.login === true) { res.writeHead(302, { Location: base + '/', ...noStore }); return res.end(); }
      if (!ent) return htmlErr(401, '401', '登录链接已失效。请在服务器重新执行 <code>agw web login</code>。');
      const f = path.join(CORE, 'm3', 'login.html');
      if (!fs.existsSync(f)) return textRes(res, 404, '登录页缺失: m3/login.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStore, 'Referrer-Policy': 'no-referrer' });
      return res.end(fs.readFileSync(f));
    }
    if (method !== 'POST') return textRes(res, 405, '不支持的方法: ' + method + ' ' + p, null, noStore);
    if (!sid) return jsonRes(res, 404, { error: 'not found' });
    if (!ent) return jsonRes(res, 401, { error: '登录链接已失效, 请重新执行 agw web login' });
    if (ent.login === true) return jsonRes(res, 200, { ok: true, redirect: base + '/' });
    let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
    const aa = cfg.adminAuth || {};
    const keys = adminKeysOf(cfg);
    const keyOk = keys.length === 0 || keys.some(k => panelAuth.safeEqual(k.key, String(j.key || '')));
    const secondOk = (!aa.secondKey && !aa.totpSecret)
      || (!!aa.secondKey && panelAuth.safeEqual(aa.secondKey, String(j.secondKey || '')))
      || (!!aa.totpSecret && totpVerify(aa.totpSecret, String(j.totp || '')));
    if (!keyOk || !secondOk) {
      const map = sessMapOf();
      const cur = map.get ? map.get(ent.sid) : map[ent.sid];
      const tries = (Number(cur && cur.tries) || 0) + 1;
      if (cur && tries >= 5) {
        delSess(map, ent.sid);
        try { panelAuth.sessionsSave(cfg, inst); } catch (_) {}
        return jsonRes(res, 401, { error: '尝试次数过多, 请重新执行 agw web login 获取登录链接' });
      }
      if (cur && typeof cur === 'object') { cur.tries = tries; try { panelAuth.sessionsSave(cfg, inst); } catch (_) {} }
      return jsonRes(res, 401, { error: keys.length ? '管理员卡密或二次验证不正确' : '二次验证不正确' });
    }
    upgradeSess(ent);
    return jsonRes(res, 200, { ok: true, redirect: base + '/' });
  }

// ---- 3) one-time login link /admin/<token> (issued by agw web login) ----
  const om = (method === 'GET' || method === 'HEAD') && p.match(/^\/admin\/([A-Za-z0-9_-]{8,256})\/?$/);
  if (om) {
    if (!sid) return htmlErr(404, '404', 'not found');
    const okLink = panelAuth.verify(cfg, inst, sid, om[1]);
    if (!okLink) {
      const ent = readSessEnt(cfg, req);
      if (ent && ent.login === true) { res.writeHead(302, { Location: base + '/', ...noStore }); return res.end(); }
      if (ent && ent.pending) { res.writeHead(302, { Location: base + '/login', ...noStore }); return res.end(); }
      return htmlErr(401, '401', '登录链接无效或已被使用。请在服务器重新执行 <code>agw web login</code>。');
    }
// One-time link consumed. Card-key instances go through the login page; keyless ones get the
// session directly, exactly like before this change.
    if (needsPanelLogin(cfg)) res.writeHead(302, { Location: base + '/login', ...noStore, 'Set-Cookie': issueWebSess(false) });
    else res.writeHead(302, { Location: base + '/', ...noStore, 'Set-Cookie': issueWebSess(true) });
    return res.end();
  }

// ---- 4) /admin/api/* -- JSON API: cookie session / admin token / webToken / admin card key ----
  if (p.startsWith('/admin/api/')) {
  if (!checkAdminAuth(cfg, req, u.searchParams)) {
    return jsonRes(res, 401, { error: '认证失败' });
  }

  const api = p.slice('/admin/api/'.length);

// POST /admin/api/web-token/rotate -- rotate the long-lived API token.
// Only the *current* webToken may rotate: a leaked/old token must never be able to mint a new one.
// A lost response is recovered out of band (agw web login / CLI), never by keeping the old token alive.
  if (api === 'web-token/rotate') {
    if (req.method !== 'POST') return jsonRes(res, 405, { error: '只支持 POST', Allow: 'POST' });
    const hh = req.headers || {};
    const bearer2 = String(hh.authorization || '').startsWith('Bearer ') ? String(hh.authorization).slice(7).trim() : '';
    const supplied2 = [bearer2, hh['x-agw-token'], u.searchParams && u.searchParams.get('key')].filter(Boolean);
    if (!cfg.webToken || !supplied2.includes(cfg.webToken)) {
      return jsonRes(res, 401, { error: '轮换需要当前 webToken（x-agw-token），不接受旧 token / 面板会话' });
    }
    const nm = cfg._name || currentName(cfg);
    const newToken = require('crypto').randomBytes(24).toString('base64url');
    try {
      const disk = loadCfg(nm);
      if (!disk) return jsonRes(res, 404, { error: '实例不存在' });
      disk.webToken = newToken;
      delete disk.webTokenPrev;
      delete disk.webTokenPrevUntil;
      saveCfg(nm, disk);
    } catch (e) {
      return jsonRes(res, 500, { error: '轮换失败: ' + e.message });
    }
    cfg.webToken = newToken;
    delete cfg.webTokenPrev;
    delete cfg.webTokenPrevUntil;
    return jsonRes(res, 200, { ok: true, webToken: newToken });
  }

// POST /admin/api/web-expired -- log out every panel session (agw admin expire)
  if (api === 'web-expired') {
    let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
    const sid = String(j.sid || '');
    if (sid) {
      if (cfg._webSess) cfg._webSess.delete(sid);
      if (cfg._webSessPend) cfg._webSessPend.delete(sid);
      return jsonRes(res, 200, { ok: true, sid });
    }
    if (cfg._webSess) cfg._webSess.clear();
    if (cfg._webSessPend) cfg._webSessPend.clear();
    try { panelAuth.revoke(cfg, cfg._name || currentName(cfg)); } catch (_) {}
    return jsonRes(res, 200, { ok: true, cleared: true });
  }
// POST /admin/api/admin-expire {at|sid|0} -- schedule/immediate panel-session logout (agw admin expire -t/-w/-d)
  if (api === 'admin-expire') {
    let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
    if (j.sid) {
      if (cfg._webSess) cfg._webSess.delete(String(j.sid));
      if (cfg._webSessPend) cfg._webSessPend.delete(String(j.sid));
      return jsonRes(res, 200, { ok: true, sid: String(j.sid) });
    }
    const nm = cfg._name || currentName(cfg);
    const at = Number(j.at) || 0;
    if (cfg._expTimer) { clearTimeout(cfg._expTimer); cfg._expTimer = null; }
    if (!at) {
      cfg.adminExpireAt = 0;
      try { const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = 0; saveCfg(nm, disk); } } catch (_) {}
      return jsonRes(res, 200, { ok: true, at: 0 });
    }
    const fire = () => {
      cfg.adminExpireAt = 0;
      if (cfg._webSess) cfg._webSess.clear();
      if (cfg._webSessPend) cfg._webSessPend.clear();
      try { panelAuth.revoke(cfg, cfg._name || currentName(cfg)); } catch (_) {}
      try { const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = 0; saveCfg(nm, disk); } } catch (_) {}
    };
    cfg.adminExpireAt = at;
    if (at <= Date.now()) fire();
    else cfg._expTimer = setTimeout(fire, at - Date.now());
    try { const disk = loadCfg(nm); if (disk) { disk.adminExpireAt = at; saveCfg(nm, disk); } } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    return jsonRes(res, 200, { ok: true, at });
  }
// POST /admin/api/web-session -- retired: agw web login now writes the login state directly to disk
  if (api === 'web-session') {
    return jsonRes(res, 410, { error: 'web-session 已停用, 请使用 agw web login' });
  }

// GET /admin/api/web-sessions -- panel session overview (active sessions / scheduled logout)
  if (api === 'web-sessions') {
    if (req.method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET' });
    const now = Date.now();
    const panelState = panelStateOf(cfg);
    const dump = (m) => {
      const out = [];
      if (m) for (const [sid, v] of m) {
        const exp = typeof v === 'number' ? v : Number(v && v.exp) || 0;
        const stale = v && v.panelSid && (!panelState || v.panelSid !== panelState.sid);
        if (exp > now && !stale) out.push({ sid, exp });
        else m.delete(sid);
      }
      return out.sort((x, y) => y.exp - x.exp);
    };
    return jsonRes(res, 200, {
      ok: true, now,
      sessions: dump(cfg._webSess),
      pending: [],
      adminExpireAt: Number(cfg.adminExpireAt) || 0,
    });
  }

// GET  /admin/api/announcements        -- list (newest first)
// POST /admin/api/announcements        -- create, or update when {id} is present
// POST /admin/api/announcements-delete -- remove one {id}
  if (api === 'announcements' || api === 'announcements-delete') {
    if (api === 'announcements' && req.method === 'GET') {
      const items = loadAnnouncements().sort((a, b) => (b.at || 0) - (a.at || 0));
      return jsonRes(res, 200, { ok: true, items });
    }
    if (req.method !== 'POST') return jsonRes(res, 405, { error: '只支持 POST', Allow: 'POST' });
    let j = {}; try { j = JSON.parse(bodyStr || '{}'); } catch (_) {}
    try {
      if (api === 'announcements-delete') {
        const id = String(j.id || '');
        const before = loadAnnouncements();
        const items = before.filter(a => a.id !== id);
        if (items.length === before.length) return jsonRes(res, 404, { error: '公告不存在' });
        saveAnnouncements(items);
        return jsonRes(res, 200, { ok: true });
      }
      const title = String(j.title || '').trim();
      if (!title) return jsonRes(res, 400, { error: '标题不能为空' });
      const body = String(j.body || '').slice(0, 4000);
      // publish time: {at} = ms epoch or a parseable datetime string; absent -> now (create) / unchanged (update)
      const parseAt = (def) => {
        if (j.at == null || j.at === '') return def;
        const t = typeof j.at === 'number' ? j.at : Date.parse(String(j.at));
        if (!Number.isFinite(t)) { jsonRes(res, 400, { error: '发布时间格式无法识别' }); return null; }
        return t;
      };
      const items = loadAnnouncements();
      if (j.id) {
        const it = items.find(a => a.id === String(j.id));
        if (!it) return jsonRes(res, 404, { error: '公告不存在' });
        const at = parseAt(it.at); if (at === null) return;
        it.title = title; it.body = body; it.at = at;
      } else {
        const at = parseAt(Date.now()); if (at === null) return;
        items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, body, at });
      }
      saveAnnouncements(items);
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      return jsonRes(res, 500, { error: '保存失败: ' + e.message });
    }
  }

// GET /admin/api/mdu -- Material You wallpaper primary color (color-bridge)
  // bridge contract: outputs #RRGGBB / {"primary":"#RRGGBB"} / {"tokens":{"primary":"#RRGGBB"}}
  // source order: (1) config.mduCmd or env AGW_MDU_CMD (2) DIR/mdu.json (periodically written by the bridge)
// commands come from this instance's config; only an authenticated admin can trigger them (2.5s timeout)
  if (api === 'mdu') {
    if (req.method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET' });
    const pickHex = (v) => {
      const m = String(v == null ? '' : v).match(/#?([0-9a-f]{6})\b/i);
      return m ? '#' + m[1].toUpperCase() : '';
    };
    const parseHex = (raw) => {
      let j = null; try { j = JSON.parse(raw); } catch (_) {}
      if (j && typeof j === 'object') {
        const hex = pickHex(j.primary || (j.tokens && j.tokens.primary) || (j.colors && j.colors.primary));
        if (hex) return hex;
      }
      return pickHex(raw);
    };
    const mduFile = path.join(DATA(), 'mdu.json');
    const fromFile = () => {
      try { return fs.existsSync(mduFile) ? parseHex(fs.readFileSync(mduFile, 'utf8')) : ''; } catch (_) { return ''; }
    };
    const reply = (hex, source) => jsonRes(res, 200, { ok: true, tokens: { primary: hex }, source });
    const fail = (hint) => jsonRes(res, 503, { ok: false, error: '取色桥不可用: ' + hint });
    const cmd = String(cfg.mduCmd || process.env.AGW_MDU_CMD || '').trim();
    if (!cmd) {
      const hex = fromFile();
      if (hex) return reply(hex, 'file');
      return fail('未配置 mduCmd(或 AGW_MDU_CMD), 也没有 ' + mduFile);
    }
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('sh', ['-c', cmd], { timeout: 2500, maxBuffer: 64 * 1024 },
          (e, so) => (e ? reject(e) : resolve(String(so || ''))));
      });
      const hex = parseHex(out) || fromFile();
      if (hex) return reply(hex, 'cmd');
      return fail('命令输出里没有 #RRGGBB: ' + String(out).trim().slice(0, 120));
    } catch (e) {
      const hex = fromFile();
      if (hex) return reply(hex, 'file');
      return fail(e.message);
    }
  }

// ===== SDUI pages (hand-written JSON; get rendering working before data sources) =====
  // GET /admin/api/ui            → { pages: ["demo","requests"] }
// GET /admin/api/ui/<name>     -> returns DIR/ui/<name>.json verbatim
  // filename whitelist [a-z0-9_-]{1,32}: rejects every traversal attempt
  if (api === 'ui' || api.startsWith('ui/')) {
    if (req.method !== 'GET') return jsonRes(res, 405, { error: '只支持 GET' });
    const dir = path.join(CORE, 'ui');
    if (api === 'ui') {
      let pages = [];
      try {
        pages = fs.readdirSync(dir).filter(f => /^[a-z0-9_-]{1,32}\.json$/.test(f)).map(f => f.slice(0, -5)).sort();
      } catch (e) {}
      return jsonRes(res, 200, { ok: 1, pages, dir });
    }
    const name = decodeURIComponent(api.slice('ui/'.length));
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) return jsonRes(res, 400, { error: '页面名只允许 a-z0-9_-' });
    const f = path.join(dir, name + '.json');
    if (!fs.existsSync(f)) return jsonRes(res, 404, { error: '页面不存在: ' + name + ' (找 ' + f + ')' });
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return jsonRes(res, 500, { error: 'JSON 解析失败: ' + e.message }); }
    return jsonRes(res, 200, j);
  }

// ===== Floating-ball appearance/label hot config =====
  // GET  /admin/api/ball/<inst> → { ok, inst, hash, look:{...}, src:[...] }
// POST /admin/api/ball/<inst> -> writes ball.<inst>.json after whitelist validation; {clear:true} deletes the file
  // files live under DIR and are read per request: edits apply instantly, no gateway restart, no app rebuild
// POST /admin/api/ball-trigger -> deliver an event to the APP immediately (via rish am broadcast)
  if (api === 'ball-trigger') {
    if (req.method !== 'POST') return jsonRes(res, 405, { error: '只支持 POST' });
    let b = {};
    try { b = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'body 必须是 JSON' }); }
    const on = String(b.on || '');
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(on)) return jsonRes(res, 400, { error: '事件名只能是 1..24 位字母数字下划线' });
    const q = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
    let cmd = 'am broadcast -n com.aigateway.app/.overlay.EventReceiver -a com.aigateway.app.EVENT --es k ' + q(on);
    for (const k of ['pct', 'temp', 'vol', 'ssid', 'pkg', 'title', 'text', 'time', 'silence', 'charging']) {
      if (b[k] === undefined || b[k] === null || b[k] === '') continue;
      cmd += ' --es ' + k + ' ' + q(String(b[k]).slice(0, 200));
    }
    const rish = path.join(os.homedir(), 'Shizuku', 'rish');
    if (!fs.existsSync(rish)) return jsonRes(res, 500, { error: '找不到 ' + rish });
    return execFile(rish, ['-c', cmd], { timeout: 8000 }, (err, so, se) => {
      if (err) return jsonRes(res, 500, { error: '广播失败: ' + String(se || err.message).slice(0, 200) });
      return jsonRes(res, 200, { ok: 1, on });
    });
  }

  if (/^ball\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('ball/'.length));
    const fInst = path.join(DATA(), 'ball.' + name + '.json');
    const fGlob = path.join(DATA(), 'ball.json');
    const readBall = f => {
      try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; }
    };
    if (req.method === 'GET') {
      const parts = [fGlob, fInst].map(readBall).filter(o => o && typeof o === 'object');
      const look = Object.assign({}, ...parts);
      return jsonRes(res, 200, {
        ok: 1, inst: name, hash: BALL.hashOf(look), look,
        src: [fGlob, fInst].filter(f => fs.existsSync(f)).map(f => path.basename(f))
      });
    }
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      if (!loadCfg(name)) return jsonRes(res, 404, { error: '实例不存在: ' + name });
      if (data.clear) {
        try { fs.unlinkSync(fInst); } catch (e) {}
        return jsonRes(res, 200, { ok: 1, cleared: true, inst: name });
      }
      const r = BALL.validate(data.look !== undefined ? data.look : data);
      if (r.error) return jsonRes(res, 400, { error: r.error, allowed: BALL.keys() });
      const clash = BALL.orderClash(r.value);
      if (clash) return jsonRes(res, 400, { error: 'ring order 冲突: ' + clash });
      fs.writeFileSync(fInst, JSON.stringify(r.value, null, 2));
      return jsonRes(res, 200, { ok: 1, inst: name, saved: r.value, file: path.basename(fInst) });
    }
    return jsonRes(res, 405, { error: '只支持 GET/POST' });
  }


// GET /admin/api/instances -- status of all instances
  if (req.method === 'GET' && api === 'instances') {
    const insts = listInstances().map(name => {
      let port = 0, tlsOn = false, chCount = 0, running = false, disabled = false, loadError = false, pid = 0;
// order matters: in single-process mode the pool already holds in-memory configs — read those directly,
//    loadCfg would decrypt every config file (~1.8s) and scryptSync would block the event loop, slowing forwarding
      const inst = POOL ? POOL.instances.get(name) : null;
      if (inst) {
        running = !inst._disabled;
        pid = process.pid;
        port = inst.listen.port; tlsOn = !!(inst.tls && inst.tls.enable);
        chCount = inst.channels.length; disabled = !!inst._disabled;
      } else if (POOL) {
        // not in the pool (not started / failed to load) -> read the file as fallback, keeping the display identical to before the change
        loadError = true; pid = process.pid;
        try { const c = loadCfg(name); port = (c.listen || {}).port || 16384; tlsOn = !!(c.tls && c.tls.enable); chCount = (c.channels || []).length; disabled = !!c.disabled; } catch (_) {}
      } else {
        try { const c = loadCfg(name); port = (c.listen || {}).port || 16384; tlsOn = !!(c.tls && c.tls.enable); chCount = (c.channels || []).length; disabled = !!c.disabled; } catch (_) { loadError = true; }
        const st = getInstanceStatus(name);
        running = st.running; pid = st.pid;
      }
      const mainOnly = tlsOn && name !== 'default';
      return { name, pid, running, disabled, loadError, port, tlsOn, chCount,
        mainOnly,
        pathPrefix: name === 'default' ? '' : ('/' + name) };
    });
    const out = { instances: insts, current: currentName(cfg) };
    if (POOL) { out.multi = true; out.mainPort = POOL.mainPort; }
    return jsonRes(res, 200, out);
  }

// ===== Plugin management =====
// GET /admin/api/plugins/:inst -- installed plugin list + status + recommended plugins
  if (req.method === 'GET' && /^plugins\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('plugins/'.length));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    return jsonRes(res, 200, { plugins: PLUGINS.listForInstance(name, c), requiredPlugins: c.requiredPlugins || [] });
  }

// POST /admin/api/plugins-install/:inst -- {url|localPath, sha256?} install a plugin (.tar.gz)
  if (req.method === 'POST' && api.startsWith('plugins-install/')) {
    const name = decodeURIComponent(api.slice('plugins-install/'.length));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    try {
      let result;
      if (data.localPath) result = PLUGINS.installPackage(fs.readFileSync(data.localPath), data.sha256);
      else if (data.url) result = await PLUGINS.installFromUrl(data.url, data.sha256);
      else return jsonRes(res, 400, { error: '需要 url 或 localPath（.tar.gz 插件包）' });
      c.plugins = Array.isArray(c.plugins) ? c.plugins : [];
      if (!c.plugins.find(p => p.id === result.id)) c.plugins.push({ id: result.id, enable: true, version: result.manifest.version || '?', config: {} });
      saveCfg(name, c); hotReload(name);
      return jsonRes(res, 200, { ok: true, id: result.id, name: result.manifest.name, version: result.manifest.version, sha256: result.sha256 });
    } catch (e) { return jsonRes(res, 400, { error: e.message }); }
  }

// POST /admin/api/plugins-remove/:inst -- {id, keepData?} uninstall
  if (req.method === 'POST' && api.startsWith('plugins-remove/')) {
    const name = decodeURIComponent(api.slice('plugins-remove/'.length));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    if (!data.id) return jsonRes(res, 400, { error: '缺少插件 id' });
    PLUGINS.removePlugin(data.id, !!data.keepData);
    c.plugins = (c.plugins || []).filter(p => p.id !== data.id);
    saveCfg(name, c); hotReload(name);
    return jsonRes(res, 200, { ok: true });
  }

// POST /admin/api/plugins-enable/:inst -- {id, enable} enable/disable
  if (req.method === 'POST' && api.startsWith('plugins-enable/')) {
    const name = decodeURIComponent(api.slice('plugins-enable/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    let pc = (c.plugins || []).find(p => p.id === data.id);
    if (!pc) {
      // plugins dropped into plugins/ manually but never registered: auto-register, then set the enabled state
      if (!PLUGINS || !PLUGINS.installed.has(data.id)) return jsonRes(res, 404, { error: '插件未安装: ' + data.id });
      c.plugins = Array.isArray(c.plugins) ? c.plugins : [];
      pc = { id: data.id, enable: false, version: (PLUGINS.installed.get(data.id).manifest.version || '?'), config: {} };
      c.plugins.push(pc);
    }
    pc.enable = !!data.enable;
    saveCfg(name, c); hotReload(name);
    return jsonRes(res, 200, { ok: true, enable: pc.enable });
  }

// GET/POST /admin/api/plugins-config/:inst/:id -- read/write plugin settings
  if (api.startsWith('plugins-config/')) {
    const rest = api.slice('plugins-config/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return jsonRes(res, 400, { error: '路径应为 plugins-config/:inst/:id' });
    const name = decodeURIComponent(rest.slice(0, slash));
    const pid = decodeURIComponent(rest.slice(slash + 1));
    if (!PLUGINS) return jsonRes(res, 500, { error: '插件系统未初始化' });
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    if (req.method === 'GET') {
      const sc = PLUGINS.configSchema(name, pid, c);
      if (!sc) return jsonRes(res, 404, { error: '插件未安装: ' + pid });
      return jsonRes(res, 200, { id: pid, schema: sc.schema, config: sc.config });
    }
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      const pc = (c.plugins || []).find(p => p.id === pid);
      if (!pc) return jsonRes(res, 404, { error: '插件未安装: ' + pid });
      pc.config = (data && typeof data.config === 'object' && data.config) ? data.config : {};
      saveCfg(name, c); hotReload(name);
      return jsonRes(res, 200, { ok: true });
    }
    return jsonRes(res, 405, { error: 'Method Not Allowed' });
  }

// POST /admin/api/plugins-required/:inst -- {requiredPlugins:[{id,name,...}]} set the first-login recommendations
  if (req.method === 'POST' && api.startsWith('plugins-required/')) {
    const name = decodeURIComponent(api.slice('plugins-required/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    c.requiredPlugins = Array.isArray(data.requiredPlugins) ? data.requiredPlugins : [];
    saveCfg(name, c); hotReload(name);
    return jsonRes(res, 200, { ok: true, requiredPlugins: c.requiredPlugins });
  }

// GET /admin/api/plugins-index?url=<indexUrl> -- fetch a custom index's plugin list (browse)
  if (req.method === 'GET' && api === 'plugins-index') {
    const indexUrl = u.searchParams && u.searchParams.get('url');
    if (!indexUrl) return jsonRes(res, 400, { error: '缺少 url 参数' });
    try {
      const { downloadBuf } = require('./plugins.js');
      const buf = await downloadBuf(indexUrl, 2 * 1024 * 1024);
      const idx = JSON.parse(buf.toString('utf8'));
      return jsonRes(res, 200, { name: idx.name || '', plugins: idx.plugins || [] });
    } catch (e) { return jsonRes(res, 400, { error: '索引拉取失败: ' + e.message }); }
  }

// GET /admin/api/config/:name -- read an instance's config (with ?reveal=1 secrets come back in plaintext for panel editing)
  if (req.method === 'GET' && api.startsWith('config/')) {
    const name = decodeURIComponent(api.slice('config/'.length));
    const reveal = !!(u.searchParams && u.searchParams.get('reveal') === '1');
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    return jsonRes(res, 200, {
      name, port: (c.listen || {}).port || 16384, host: (c.listen || {}).host || '0.0.0.0',

      webToken: reveal ? (c.webToken || '') : (c.webToken ? '(已设)' : ''),
      panel: { openBrowser: !(c.panel && c.panel.openBrowser === false) },
      tls: c.tls || { enable: false },
      redact: maskRedactCfg(c),
      replace: c.replace || { out: [], inc: [] },
      record: c.record || { enable: false, server: '' },
      log: c.log || logfile.DEF,
      probe: c.probe || { enable: false, intervalMin: 10, mode: 'models' },
      keyLength: c.keyLength || 24,
      modelSync: c.modelSync || { enable: true, intervalHours: 24 },
      proxies: c.proxies || {},
      channels: maskedChannels(c, reveal),
      forceChannel: c.forceChannel || null,
      paramOverride: c.paramOverride || null,
    });
  }

// POST /admin/api/config/:name -- save config (wholesale replace of channels/port etc.)
  if (req.method === 'POST' && api.startsWith('config/')) {
    const name = decodeURIComponent(api.slice('config/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
// Only some fields are editable; apiKey keeps its value (the client sends only a keyPrefix, never the secret)
    if (data.port != null) { c.listen = c.listen || {}; c.listen.port = Number(data.port); }
    if (data.host != null) { c.listen = c.listen || {}; c.listen.host = data.host; }

    if (data.webToken !== undefined) {
      const nextToken = String(data.webToken || '');
      const oldToken = String(c.webToken || '');
      if (nextToken !== oldToken) {
        if (nextToken && oldToken) {
          delete c.webTokenPrev;
          delete c.webTokenPrevUntil;
        } else {
          delete c.webTokenPrev;
          delete c.webTokenPrevUntil;
        }
        c.webToken = nextToken;
      }
    }
    if (data.panel !== undefined && data.panel && typeof data.panel === 'object') {
      c.panel = { ...(c.panel || {}), openBrowser: data.panel.openBrowser !== false };
    }
    if (data.tls !== undefined) {
      c.tls = (data.tls && typeof data.tls === 'object') ? data.tls : { enable: false };
      if (c.tls.enable) delete c.tls.port;
    }
    if (data.redact !== undefined && data.redact && typeof data.redact === 'object') {
// merge, don't replace: a panel that sends only {enable} must not wipe the extra rules
      const next = Object.assign({}, c.redact || {}, data.redact);
      next.enable = next.enable !== false;
      next.response = !!next.response;
      next.extra = normalizeRedactExtra(next.extra);
      c.redact = next;
    }
    if (data.replace !== undefined && data.replace && typeof data.replace === 'object') {
      const rp = data.replace;
      c.replace = {
        out: Array.isArray(rp.out) ? rp.out.filter(r => r && r.re).map(r => ({ re: String(r.re), to: String(r.to == null ? '' : r.to), ci: !!r.ci })) : [],
        inc: Array.isArray(rp.inc) ? rp.inc.filter(r => r && r.re).map(r => ({ re: String(r.re), to: String(r.to == null ? '' : r.to), ci: !!r.ci })) : [],
      };
    }
    if (data.modelSync !== undefined && data.modelSync && typeof data.modelSync === 'object') {
      c.modelSync = {
        enable: data.modelSync.enable !== false,
        intervalHours: Math.max(1, Number(data.modelSync.intervalHours) || 24),
        intervalMin: Number(data.modelSync.intervalMin) > 0 ? Number(data.modelSync.intervalMin) : null,
      };
    }
// Key card length (8-128)
    if (data.keyLength !== undefined) c.keyLength = Math.min(128, Math.max(8, Number(data.keyLength) || 24));
    // success-rate probe config
    if (data.probe !== undefined && data.probe && typeof data.probe === 'object') {
      c.probe = {
        enable: !!data.probe.enable,
        intervalMin: Math.max(1, Number(data.probe.intervalMin) || 10),
        mode: data.probe.mode === 'chat' ? 'chat' : 'models',
      };
    }
// Request recording: enable switch + collector server address (empty = local JSONL file)
    if (data.record !== undefined && data.record && typeof data.record === 'object') {
      c.record = {
        enable: !!data.record.enable,
        server: String(data.record.server || '').trim(),
        maxChars: Number(data.record.maxChars) > 0 ? Number(data.record.maxChars) : 200000,
      };
    }
// Gateway log file: buffered writes + a size cap (logfile.js), applied to the live writer at once
    if (data.log !== undefined && data.log && typeof data.log === 'object') {
      c.log = logfile.normalize(data.log);
      try { logfile.configure(c.log); } catch (_) {}
    }
    if (data.proxies !== undefined) c.proxies = data.proxies;
// Parameter override (instance level): empty/absent-clears; otherwise a non-empty object
    if (data.paramOverride !== undefined) {
      const raw = data.paramOverride;
      const isEmpty = raw === null || raw === '' || (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.keys(raw).length);
      if (isEmpty) delete c.paramOverride;
      else {
        const ov = normalizeOverride(raw, '实例 paramOverride');
        if (!ov) return jsonRes(res, 400, { error: '参数覆写必须是非空 JSON 对象' });
        c.paramOverride = ov;
      }
    }
    if (Array.isArray(data.channels)) {
// Preserve apiKey: a submitted channel with hasKey but no apiKey inherits the old value
      const oldMap = {};
      const oldChans = {};
      for (const ch of (c.channels || [])) { oldMap[ch.name] = ch.apiKey; oldChans[ch.name] = ch; }
      c.channels = data.channels.map(ch => {
        const out = { ...ch };
        if (!out.apiKey && oldMap[out.name] !== undefined) out.apiKey = oldMap[out.name];
        if (!out.apiKey) out.apiKey = '';
        mergeBalanceFields(out, oldChans[out.name]);
        if (out.path === undefined) { if (oldChans[out.name] && oldChans[out.name].path !== undefined) out.path = oldChans[out.name].path; }
        out.path = normalizeChannelPath(out.path);
        if (!out.path) delete out.path;
        return out;
      });
    }
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) {
      try { hotReload(name); return jsonRes(res, 200, { ok: true, hotReload: true }); }
      catch (e) { return jsonRes(res, 200, { ok: true, hotReload: false, warn: '配置已保存但热重载失败: ' + e.message }); }
    }
    jsonRes(res, 200, { ok: true, restarting: true });
    scheduleRestart(cfg, name);
    return;
  }

// POST /admin/api/instance-create/:name -- create an instance (writes config.<name>.json; effective immediately in pool mode)
  if (req.method === 'POST' && api.startsWith('instance-create/')) {
    const name = decodeURIComponent(api.slice('instance-create/'.length));
    if (!INST_NAME_RE.test(name)) return jsonRes(res, 400, { error: '实例名只能含字母/数字/中划线/下划线, 最长32字符' });
    if (RESERVED_PATHS.has(name) || name === 'example') return jsonRes(res, 400, { error: '实例名 ' + name + ' 是保留字(与 API 路径冲突), 请换一个' });
    if (isEndpointHead(name)) return jsonRes(res, 400, { error: '实例名 ' + name + ' 与 API 端点首段同名(裸 /' + name + '/... 会被当作实例前缀, 该端点就走不到了), 请换一个' });
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 请直接编辑' });
    if (fs.existsSync(cfgFile(name))) return jsonRes(res, 409, { error: '实例 ' + name + ' 已存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const port = Number(data.port);
    if (!port || port < 1024 || port > 65535) return jsonRes(res, 400, { error: 'HTTP 端口范围 1024-65535' });
    const tls = (data.tls && typeof data.tls === 'object') ? data.tls : { enable: false };
    if (tls.enable) {
      if (!tls.cert || !tls.key) return jsonRes(res, 400, { error: '启用 HTTPS 需要证书路径(tls.cert/tls.key)' });
      delete tls.port;
    }
    const cfg = {
      listen: { port, host: data.host || '0.0.0.0' },
      tls,
      webToken: typeof data.webToken === 'string' ? data.webToken : '',

      channels: Array.isArray(data.channels) ? data.channels : [], proxies: {}, modelMap: {}, models: [],
      routing: { maxRetry: 2, timeoutSec: 120, cooldownSec: 30 },
    };
    try { saveCfg(name, cfg); } catch (e) { return jsonRes(res, 500, { error: '创建失败: ' + e.message }); }
    if (POOL) {
      try { hotReload(name); } catch (e) { return jsonRes(res, 500, { error: '实例已创建但加载失败: ' + e.message }); }
      return jsonRes(res, 200, { ok: true, hotReload: true, url: '/' + name + '/v1' });
    }
    return jsonRes(res, 200, { ok: true });
  }

// POST /admin/api/channel/:name -- add/edit a single channel
  if (req.method === 'POST' && api.startsWith('channel/')) {
    const name = decodeURIComponent(api.slice('channel/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let ch;
    try { ch = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    if (!ch.name) return jsonRes(res, 400, { error: '需要渠道名' });
    // rename support: oldName present and different from the new name = rename the channel (atomic replace, apiKey kept)
    const oldName = ch.oldName ? String(ch.oldName) : '';
    delete ch.oldName;
let prevCh = null; // the previous channel object: inherits fields absent from the body (the balance trio)
    if (oldName && oldName !== ch.name) {
      if ((c.channels || []).some(x => x.name === ch.name)) return jsonRes(res, 409, { error: '渠道名 ' + ch.name + ' 已被占用' });
      const target = (c.channels || []).find(x => x.name === oldName);
      if (!target) return jsonRes(res, 404, { error: '原渠道不存在: ' + oldName });
      prevCh = target;
      if (!ch.apiKey || ch.apiKey.includes('***')) ch.apiKey = target.apiKey || '';
      if (ch.default) { for (const x of c.channels) x.default = false; }
      c.channels = (c.channels || []).filter(x => x.name !== oldName);
      c.channels.push(ch);
    } else {
// When editing (same name exists) without a submitted apiKey, keep the old one
      const existing = (c.channels || []).find(x => x.name === ch.name);
      prevCh = existing || null;
      if (existing && (!ch.apiKey || ch.apiKey.includes('***'))) ch.apiKey = existing.apiKey;
      if (ch.default) { for (const x of (c.channels || [])) x.default = false; }
      c.channels = (c.channels || []).filter(x => x.name !== ch.name);
      if (!ch.apiKey) ch.apiKey = '';
      c.channels.push(ch);
    }
// Balance passthrough three fields: omitted by panel/App (undefined) = inherit, explicit empty string = clear -- prevents "one channel edit wipes the balance config"
    mergeBalanceFields(ch, prevCh);
// Channel path lock follows the same rule: omitted = inherit, explicit empty = clear
    if (ch.path === undefined) { if (prevCh && prevCh.path !== undefined) ch.path = prevCh.path; }
    else if (ch.path === '' || ch.path === null) delete ch.path;
    else {
      if (/^https?:\/\//i.test(String(ch.path).trim())) return jsonRes(res, 400, { error: 'path 必须是路径, 不能是完整 URL' });
      ch.path = normalizeChannelPath(ch.path);
      if (!ch.path) delete ch.path;
    }
    ch.path = normalizeChannelPath(ch.path);
    if (!ch.path) delete ch.path;
// Parameter override follows the path rule: omitted = inherit, explicit empty = clear
    if (ch.paramOverride === undefined) {
      if (prevCh && prevCh.paramOverride !== undefined) ch.paramOverride = prevCh.paramOverride;
    } else if (ch.paramOverride === null || ch.paramOverride === '' || (typeof ch.paramOverride === 'object' && !Array.isArray(ch.paramOverride) && !Object.keys(ch.paramOverride).length)) {
      delete ch.paramOverride;
    } else {
      const ov = normalizeOverride(ch.paramOverride, '渠道 "' + ch.name + '" paramOverride');
      if (!ov) return jsonRes(res, 400, { error: '参数覆写必须是非空 JSON 对象' });
      ch.paramOverride = ov;
    }
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) {
      try { hotReload(name); return jsonRes(res, 200, { ok: true, hotReload: true }); }
      catch (e) { return jsonRes(res, 200, { ok: true, hotReload: false, warn: '已保存但热重载失败: ' + e.message }); }
    }
    jsonRes(res, 200, { ok: true, restarting: true });
    scheduleRestart(cfg, name);
    return;
  }

// GET/POST /admin/api/route-once/:name -- one-shot routing: affects only the next request, never persisted, self-clearing after use
  if (api.startsWith('route-once/')) {
    const name = decodeURIComponent(api.slice('route-once/'.length));
    const live = POOL ? POOL.instances.get(name) : (name === currentName(cfg) ? cfg : null);
    if (!live) return jsonRes(res, 404, { error: '实例未在运行: ' + name });
    if (req.method === 'GET') return jsonRes(res, 200, { ok: true, channel: live._onceChannel || null });
    let b;
    try { b = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const ch = b.channel ? String(b.channel) : null;
    if (ch && !(live.channels || []).some(x => x.name === ch)) return jsonRes(res, 404, { error: '渠道不存在: ' + ch });
    live._onceChannel = ch;
    return jsonRes(res, 200, { ok: true, channel: ch });
  }

// GET/POST /admin/api/route/:name -- manual routing (persistent): pin to a channel; empty channel = back to auto
  if (api.startsWith('route/')) {
    const name = decodeURIComponent(api.slice('route/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    if (req.method === 'GET') return jsonRes(res, 200, { ok: true, channel: c.forceChannel || null });
    let b;
    try { b = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const ch = b.channel ? String(b.channel) : null;
    if (ch && !(c.channels || []).some(x => x.name === ch)) return jsonRes(res, 404, { error: '渠道不存在: ' + ch });
    if (ch) c.forceChannel = ch; else delete c.forceChannel;
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    const live = POOL ? POOL.instances.get(name) : null;
    if (live) {
      if (ch) live.forceChannel = ch; else delete live.forceChannel;
      return jsonRes(res, 200, { ok: true, channel: ch, applied: 'live' });
    }
    if (POOL) {
      try { hotReload(name); return jsonRes(res, 200, { ok: true, channel: ch, applied: 'reload' }); }
      catch (e) { return jsonRes(res, 200, { ok: true, channel: ch, warn: '已保存但热重载失败: ' + e.message }); }
    }
    jsonRes(res, 200, { ok: true, channel: ch, applied: 'saved' });
    return;
  }

// DELETE /admin/api/channel/:name/:chname -- delete a channel
  if (req.method === 'DELETE' && api.startsWith('channel/')) {
    const parts = api.slice('channel/'.length).split('/');
    const name = decodeURIComponent(parts[0]);
    const chname = decodeURIComponent(parts.slice(1).join('/'));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const before = (c.channels || []).length;
    c.channels = (c.channels || []).filter(x => x.name !== chname);
    if (c.channels.length < before) {
      saveCfg(name, c);
      if (POOL) {
        try { hotReload(name); return jsonRes(res, 200, { ok: true, hotReload: true }); }
        catch (e) { return jsonRes(res, 200, { ok: true, hotReload: false, warn: '已保存但热重载失败: ' + e.message }); }
      }
      jsonRes(res, 200, { ok: true, restarting: true });
      scheduleRestart(cfg, name);
      return;
    }
    return jsonRes(res, 404, { error: '渠道不存在' });
  }

// DELETE /admin/api/instance/:name -- delete an instance (stops the process first, then removes config/log/pid; default and the panel host cannot be deleted)
  if (req.method === 'DELETE' && api.startsWith('instance/')) {
    const name = decodeURIComponent(api.slice('instance/'.length));
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return jsonRes(res, 400, { error: '实例名非法' });
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 不能删除' });
    if (name === currentName(cfg)) return jsonRes(res, 400, { error: '不能删除承载面板的实例' });
    if (!fs.existsSync(cfgFile(name))) return jsonRes(res, 404, { error: '实例不存在' });
    if (POOL) { try { POOL.removeInst(name); } catch (_) {} }
    else { await runAgw(['stop', name]); } // 旧多进程模式: 运行中先停止
    try { fs.unlinkSync(cfgFile(name)); } catch (e) { return jsonRes(res, 500, { error: '删除配置失败: ' + e.message }); }
cfgCacheClear(); // file deleted; clear the cache to avoid leftovers
    try { fs.unlinkSync(path.join(MLOG(), name + '.log')); } catch (e) {}
    try { fs.unlinkSync(path.join(MRUN(), name + '.pid')); } catch (e) {}
    return jsonRes(res, 200, { ok: true });
  }

// ============ Admin second-factor config ============
// GET /admin/api/admin-auth/:inst -- second-factor status (never returns the secret itself)
  if (req.method === 'GET' && api.startsWith('admin-auth/')) {
    const name = decodeURIComponent(api.slice('admin-auth/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const aa = c.adminAuth || {};
    return jsonRes(res, 200, {
      hasWebToken: !!c.webToken,
      secondKeySet: !!aa.secondKey,
      totpEnabled: !!aa.totpSecret,
profile: c.adminProfile || {},       // admin profile (agw admin profile)
expireAt: c.adminExpireAt || 0,      // panel session expiry (agw admin expire)
    });
  }

// POST /admin/api/admin-auth/:inst -- configure {secondKey?, totpAction?: 'enable'|'disable'}
  if (req.method === 'POST' && api.startsWith('admin-auth/')) {
    const name = decodeURIComponent(api.slice('admin-auth/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    c.adminAuth = c.adminAuth && typeof c.adminAuth === 'object' ? c.adminAuth : {};
    if (data.secondKey !== undefined) c.adminAuth.secondKey = String(data.secondKey || '');
    let newTotp = null;
    if (data.totpAction === 'enable') {
      newTotp = base32Encode(crypto2.randomBytes(20));
      c.adminAuth.totpSecret = newTotp;
    } else if (data.totpAction === 'disable') {
      delete c.adminAuth.totpSecret;
    }
    if (!c.adminAuth.secondKey && !c.adminAuth.totpSecret) delete c.adminAuth;
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) { try { hotReload(name); } catch (_) {} }
    const out = { ok: true, secondKeySet: !!((c.adminAuth || {}).secondKey), totpEnabled: !!((c.adminAuth || {}).totpSecret) };
    if (newTotp) {
      out.totpSecret = newTotp;
      out.otpauthUrl = 'otpauth://totp/OpenAGW-' + encodeURIComponent(name) + '?secret=' + newTotp + '&issuer=OpenAGW';
    }
    return jsonRes(res, 200, out);
  }

// ============ Key card management ============
// User-management fields: list inputs are trimmed, bounded and keep only non-empty strings;
// limits are whole positive numbers, 0/absent = unlimited.
function cardList(v) { return permissions.list(v).slice(0, 200); }
function cardLimit(v, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
}
// GET /admin/api/keys/:inst -- key card list (fully visible to admins, including usage)
  if (req.method === 'GET' && api.startsWith('keys/')) {
    const name = decodeURIComponent(api.slice('keys/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    // in-pool usage counts come from memory (disk lags)
    const live = POOL && POOL.instances.get(name);
    const liveMap = {};
    if (live && Array.isArray(live.apiKeys)) for (const k of live.apiKeys) liveMap[k.key] = k.usedTokens || 0;
    const keys = (c.apiKeys || []).map(k => {
      const rl = ratelimit.snapshot(k);
      return ({
        key: k.key, name: k.name || '', enable: k.enable !== false,
        role: k.role === 'admin' ? 'admin' : 'user',
        quotaTokens: Number(k.quotaTokens) || 0,
        usedTokens: liveMap[k.key] !== undefined ? liveMap[k.key] : (Number(k.usedTokens) || 0),
        rpm: Number(k.rpm) || 0, tpm: Number(k.tpm) || 0,
        rpmUsed: rl.rpmUsed, tpmUsed: rl.tpmUsed,
        models: k.models || [], channels: k.channels || [], branches: k.branches || [],
        redact: k.redact == null ? null : !!k.redact,
        expiresAt: k.expiresAt || '', note: k.note || '', createdAt: k.createdAt || '',
      });
    });
    return jsonRes(res, 200, { keys });
  }

// POST /admin/api/keys/:inst -- issue a card {name, role, quotaTokens, rpm, tpm, models, channels, branches, expiresAt, note} -> returns the full key
  if (req.method === 'POST' && /^keys\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('keys/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const klen = Math.min(128, Math.max(8, Number(c.keyLength) || 24));
    const key = 'sk-' + crypto2.randomBytes(Math.ceil(klen * 3 / 4) + 2).toString('base64url').slice(0, klen);
    c.apiKeys = Array.isArray(c.apiKeys) ? c.apiKeys : [];
    const nk = {
      key,
      name: String(data.name || '').trim().slice(0, 64),
      enable: true,
      role: data.role === 'admin' ? 'admin' : 'user',
      quotaTokens: Math.max(0, Number(data.quotaTokens) || 0),
      usedTokens: 0,
      rpm: cardLimit(data.rpm, 1000000), tpm: cardLimit(data.tpm, 1000000000),
      models: cardList(data.models), channels: cardList(data.channels), branches: cardList(data.branches),
      expiresAt: String(data.expiresAt || '').trim(),
      note: String(data.note || '').trim().slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    c.apiKeys.push(nk);
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (POOL) { try { hotReload(name); } catch (_) {} }
    syncKeysLive(name);
    return jsonRes(res, 200, { ok: true, key: nk });
  }

// POST /admin/api/keys-update/:inst -- edit a card {key, enable?, role?, quotaTokens?, addQuota?, resetUsage?, rpm?, tpm?, resetRate?, name?, models?, channels?, branches?, expiresAt?, note?}
  if (req.method === 'POST' && api.startsWith('keys-update/')) {
    const name = decodeURIComponent(api.slice('keys-update/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const k = (c.apiKeys || []).find(x => x.key === data.key);
    if (!k) return jsonRes(res, 404, { error: '卡密不存在' });
    if (data.enable !== undefined) k.enable = !!data.enable;
    if (data.role === 'admin' || data.role === 'user') k.role = data.role;
    if (data.quotaTokens !== undefined) k.quotaTokens = Math.max(0, Number(data.quotaTokens) || 0);
    if (data.name !== undefined) k.name = String(data.name).trim().slice(0, 64);
/* Rate limits: editing either limit starts a fresh window, so raising a limit takes effect at once
 * instead of waiting out the old one-minute counter. */
    let limitsChanged = false;
    if (data.rpm !== undefined) { const v = cardLimit(data.rpm, 1000000); if (v !== (Number(k.rpm) || 0)) limitsChanged = true; k.rpm = v; }
    if (data.tpm !== undefined) { const v = cardLimit(data.tpm, 1000000000); if (v !== (Number(k.tpm) || 0)) limitsChanged = true; k.tpm = v; }
    if (data.models !== undefined) k.models = cardList(data.models);
    if (data.channels !== undefined) k.channels = cardList(data.channels);
    if (data.branches !== undefined) k.branches = cardList(data.branches);
    if (data.redact !== undefined) k.redact = (data.redact == null) ? null : !!data.redact;
    if (data.expiresAt !== undefined) k.expiresAt = String(data.expiresAt || '').trim();
    if (data.note !== undefined) k.note = String(data.note).trim().slice(0, 200);
// In-memory adjustments (usage/quota); memory wins over disk
    const live = POOL && POOL.instances.get(name);
    const lk = live && (live.apiKeys || []).find(x => x.key === data.key);
    if (data.resetUsage) { k.usedTokens = 0; if (lk) lk.usedTokens = 0; }
    if (data.addQuota) { k.quotaTokens = (Number(k.quotaTokens) || 0) + Math.max(0, Number(data.addQuota) || 0); }
    try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
    if (limitsChanged || data.resetRate) { try { ratelimit.reset(k.key); } catch (_) {} }
    if (POOL) { try { hotReload(name); } catch (_) {} }
    syncKeysLive(name);
    return jsonRes(res, 200, { ok: true, hotReload: !!POOL });
  }

// DELETE /admin/api/keys/:inst/:key -- delete a key card
  if (req.method === 'DELETE' && api.startsWith('keys/')) {
    const rest = api.slice('keys/'.length);
    const idx = rest.indexOf('/');
    if (idx > 0) {
      const name = decodeURIComponent(rest.slice(0, idx));
      const key = decodeURIComponent(rest.slice(idx + 1));
      const c = loadCfg(name);
      if (!c) return jsonRes(res, 404, { error: '实例不存在' });
      const before = (c.apiKeys || []).length;
      c.apiKeys = (c.apiKeys || []).filter(x => x.key !== key);
      if (c.apiKeys.length < before) {
        try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
        try { ratelimit.drop(key); } catch (_) {}
        if (POOL) { try { hotReload(name); } catch (_) {} }
        syncKeysLive(name);
        return jsonRes(res, 200, { ok: true });
      }
      return jsonRes(res, 404, { error: '卡密不存在' });
    }
  }

// ============ Channel balance proxy lookup ============
// Implementation injected by gateway.js (setBalanceFn): uses the channel proxy/insecure/timeouts; presets + channel-level balanceUrl/balancePath/balanceUnit overrides

// GET /admin/api/balances/:inst -- every channel's balance in one request (panel provider cards).
// Channels without a balance endpoint are reported as noTarget instead of failing the call, and
// successes ride the same short cache the client balance endpoints use (cfg.balanceCacheSec).
  if (req.method === 'GET' && api.startsWith('balances/')) {
    const name = decodeURIComponent(api.slice('balances/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const lookup = BALANCE_CACHED || BALANCE_FN;
    if (!lookup) return jsonRes(res, 500, { error: '余额查询未就绪(网关未注入实现, 请重启网关)' });
    const chs = (c.channels || []).filter(x => !x._disabled);
    if (!chs.length) return jsonRes(res, 200, { ok: true, items: [] });
    const items = new Array(chs.length);
    let left = chs.length, sent = false;
    const finish = () => { if (!sent) { sent = true; jsonRes(res, 200, { ok: true, items }); } };
    chs.forEach((ch, i) => {
      const hit = () => { if (--left === 0) finish(); };
      if (BALANCE_TARGET && !BALANCE_TARGET(ch)) { items[i] = { channel: ch.name, ok: false, noTarget: true }; return hit(); }
      try {
        lookup(c, ch, (r) => {
          items[i] = r && r.ok
            ? { channel: ch.name, ok: true, balance: r.balance, unit: r.unit || '', url: r.url }
            : { channel: ch.name, ok: false, error: (r && r.error) || '余额查询失败' };
          hit();
        });
      } catch (e) { items[i] = { channel: ch.name, ok: false, error: e.message }; hit(); }
    });
    return;
  }
// GET /admin/api/balance/:inst/:ch -- proxy-lookup a channel balance (uses the channel apiKey)
  if (req.method === 'GET' && api.startsWith('balance/')) {
    const rest = api.slice('balance/'.length);
    const idx = rest.indexOf('/');
    if (idx < 0) return jsonRes(res, 400, { error: '路径应为 balance/<实例>/<渠道>' });
    const name = decodeURIComponent(rest.slice(0, idx));
    const chName = decodeURIComponent(rest.slice(idx + 1));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    const ch = (c.channels || []).find(x => x.name === chName);
    if (!ch) return jsonRes(res, 404, { error: '渠道不存在' });
    if (!BALANCE_FN) return jsonRes(res, 500, { error: '余额查询未就绪(网关未注入实现, 请重启网关)' });
    return BALANCE_FN(c, ch, (r) => {
      if (r && r.ok) return jsonRes(res, 200, { ok: true, channel: ch.name, balance: r.balance, unit: r.unit || '', url: r.url, ...(Array.isArray(r.amounts) && r.amounts.length > 1 ? { amounts: r.amounts } : {}) });
      jsonRes(res, (r && r.status) || 502, { error: (r && r.error) || '余额查询失败', ...(r && r.raw ? { raw: r.raw } : {}) });
    });
  }

// ============ cloudflared public tunnel (free temporary domain) ============
  if (api === 'tunnel' || api.startsWith('tunnel?')) {
    const mainPort = () => (POOL && POOL.mainPort) || (cfg.listen && cfg.listen.port) || 16384;
    const doStart = () => {
      if (tunnelProc) return { ok: true, url: tunnelUrl, running: true, already: true };
      tunnelUrl = ''; tunnelLog = [];
      try {
        const { spawn } = require('child_process');
        const originTls = !!(cfg.tls && cfg.tls.enable);
        const origin = (originTls ? 'https://127.0.0.1:' : 'http://127.0.0.1:') + mainPort();
        const cfArgs = ['tunnel', '--url', origin, '--no-autoupdate'];
        if (originTls) cfArgs.push('--no-tls-verify');
        tunnelProc = spawn('cloudflared', cfArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { tunnelProc = null; return { error: 'cloudflared 启动失败(未安装?): ' + e.message }; }
      const u8c = utf8();
      let lineBuf = '';
      const onData = (buf) => {
        lineBuf += u8c(buf);
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop();
        for (const line of lines) {
          tunnelLog.push(line.trim().slice(0, 300)); if (tunnelLog.length > 60) tunnelLog.shift();
          const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (m && !tunnelUrl) tunnelUrl = m[0];
        }
      };
      tunnelProc.stdout.on('data', onData);
      tunnelProc.stderr.on('data', onData);
      tunnelProc.on('exit', () => { tunnelProc = null; tunnelUrl = ''; });
      tunnelProc.on('error', (e) => { tunnelLog.push('spawn error: ' + e.message); tunnelProc = null; });
      return { ok: true, starting: true };
    };
    const doStop = () => {
      if (tunnelProc) { try { tunnelProc.kill('SIGTERM'); } catch (_) {} tunnelProc = null; }
      tunnelUrl = '';
      return { ok: true };
    };
    if (req.method === 'GET') {
      return jsonRes(res, 200, { running: !!tunnelProc, url: tunnelUrl, log: tunnelLog.slice(-12), next: tunnelNext });
    }
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      if (data.action === 'cancel') {
        if (tunnelTimer) clearTimeout(tunnelTimer);
        tunnelTimer = null; tunnelNext = null;
        return jsonRes(res, 200, { ok: true, cancelled: true });
      }
      if (data.action !== 'start' && data.action !== 'stop') return jsonRes(res, 400, { error: 'action 应为 start/stop/cancel' });
      const at = Number(data.at) || 0;
      if (at > Date.now()) {
        if (tunnelTimer) clearTimeout(tunnelTimer);
        tunnelNext = { action: data.action, at };
        tunnelTimer = setTimeout(() => {
          tunnelTimer = null; tunnelNext = null;
          try { data.action === 'start' ? doStart() : doStop(); }
          catch (e) { tunnelLog.push('scheduled ' + data.action + ' 失败: ' + e.message); }
        }, at - Date.now());
        return jsonRes(res, 200, { ok: true, scheduled: data.action, at });
      }
      const r = data.action === 'start' ? doStart() : doStop();
      return jsonRes(res, r.error ? 500 : 200, r);
    }
  }

// POST /admin/api/probe/:inst -- run a probe round immediately on channels with probe enabled
  if (req.method === 'POST' && /^probe\/[^/]+$/.test(api)) {
    const name = decodeURIComponent(api.slice('probe/'.length));
    const tc = POOL && POOL.instances.get(name);
    if (!tc) return jsonRes(res, 404, { error: '实例未在运行: ' + name });
    if (!tc.probe || !tc.probe.enable) return jsonRes(res, 400, { error: '该实例未开启探测 (配置 probe.enable)' });
    const gw = require('./gateway.js');
    if (gw.probeRound) gw.probeRound(tc);
    return jsonRes(res, 200, { ok: true, probe: tc._stats.probe || {}, debug: (tc.channels || []).map(c => ({ name: c.name, probe: !!c.probe })) });
  }

// POST /admin/api/instance-rename/:name -- rename an instance (hot in single-process mode; body {newName})
  if (req.method === 'POST' && api.startsWith('instance-rename/')) {
    const name = decodeURIComponent(api.slice('instance-rename/'.length));
    let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const newName = String(data.newName || '').trim();
    if (name === 'default') return jsonRes(res, 400, { error: 'default 是主实例, 不能改名' });
    if (!INST_NAME_RE.test(newName)) return jsonRes(res, 400, { error: '新实例名只能含字母/数字/中划线/下划线, 最长32字符' });
    if (RESERVED_PATHS.has(newName)) return jsonRes(res, 400, { error: '「' + newName + '」是保留名(与 API 路径冲突), 不能用作实例名' });
    if (isEndpointHead(newName)) return jsonRes(res, 400, { error: '「' + newName + '」与 API 端点首段同名(裸 /' + newName + '/... 会被当作实例前缀), 不能用作实例名' });
    if (newName === name) return jsonRes(res, 400, { error: '新旧名称相同' });
    if (!fs.existsSync(cfgFile(name))) return jsonRes(res, 404, { error: '实例不存在: ' + name });
    if (fs.existsSync(cfgFile(newName))) return jsonRes(res, 409, { error: '实例名已存在: ' + newName });
// 1) rename the config file (content untouched; works for encrypted files too)
    try { fs.renameSync(cfgFile(name), cfgFile(newName)); }
    catch (e) { return jsonRes(res, 500, { error: '重命名配置文件失败: ' + e.message }); }
cfgCacheClear(); // the file name changed -> cache keys are stale; clear to avoid cross-contamination
// 2) also rename log/pid/key-usage files (best effort)
    try { fs.renameSync(path.join(MLOG(), name + '.log'), path.join(MLOG(), newName + '.log')); } catch (_) {}
    try { fs.renameSync(path.join(MRUN(), name + '.pid'), path.join(MRUN(), newName + '.pid')); } catch (_) {}
    try { fs.renameSync(path.join(MLOG(), 'keyusage-' + name + '.json'), path.join(MLOG(), 'keyusage-' + newName + '.json')); } catch (_) {}
    // logfile.js keeps an fd open: repoint the writer at the renamed file, otherwise it would keep
    // appending to the old inode and the panel would read a file nobody writes to
    try {
      const st = logfile.stats();
      const oldLog = path.join(MLOG(), name + '.log');
      if (st.enabled && st.file === oldLog) logfile.install(path.join(MLOG(), newName + '.log'), st);
    } catch (_) {}
// 3) single-process mode: hot rename inside the pool (effective immediately; old port closed, new port listening)
    if (POOL) {
      try { POOL.renameInst(name, newName); }
catch (e) { /* cold-load when not in the pool */ try { POOL.reload(newName); } catch (_) {} }
      return jsonRes(res, 200, { ok: true, hotReload: true, name: newName, url: '/' + newName + '/v1' });
    }
    jsonRes(res, 200, { ok: true, name: newName, restarting: true });
    scheduleRestart(cfg, newName);
    return;
  }

// POST /admin/api/sync-models[?instance=X] -- sync channel model lists immediately for the given instance (default = the hosting instance)
  if (req.method === 'POST' && api === 'sync-models') {
    if (!syncFn) return jsonRes(res, 501, { error: '网关未提供同步能力' });
    let inst = (u.searchParams && u.searchParams.get('instance')) || '';
    if (!inst && bodyStr) { try { const bj = JSON.parse(bodyStr); inst = bj.instance || ''; } catch (_) {} }
    if (inst && POOL && !POOL.instances.has(inst)) return jsonRes(res, 404, { error: '实例不存在: ' + inst });
    try {
      const r = await syncFn(inst || undefined);
      return jsonRes(res, 200, Object.assign({ ok: true }, r));
    } catch (e) { return jsonRes(res, 502, { error: e.message }); }
  }

// POST /admin/api/channel-models/:inst -- fetch a channel's upstream model list (server-side fetch: avoids browser CORS, uses the real apiKey and channel proxy)
  if (req.method === 'POST' && api.startsWith('channel-models/')) {
    const inst = decodeURIComponent(api.slice('channel-models/'.length));
    const c = loadCfg(inst);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    let data;
    try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
    const ch = data.name ? (c.channels || []).find(x => x.name === data.name) : null;
    const type = data.type || (ch && ch.type) || 'openai';
    const baseUrl = String(data.baseUrl || (ch && ch.baseUrl) || '').trim();
    const apiKey = String(data.apiKey || (ch && ch.apiKey) || '').trim();
    const proxy = String(data.proxy || (ch && ch.proxy) || '-');
    if (!baseUrl) return jsonRes(res, 400, { error: 'Base URL 为空, 无法拉取模型列表' });
    if (!upstreamModelsFn) return jsonRes(res, 501, { error: '当前网关版本未提供拉取能力, 请升级 gateway.js' });
    upstreamModelsFn({ type, baseUrl, apiKey, proxy, anthropicVersion: ch && ch.anthropicVersion })
      .then(models => jsonRes(res, 200, { models }))
      .catch(e => jsonRes(res, 502, { error: e.message }));
    return;
  }

  // POST /admin/api/action/:name/:action — start/stop/restart
  if (req.method === 'POST' && api.startsWith('action/')) {
    const parts = api.slice('action/'.length).split('/');
    const name = decodeURIComponent(parts[0]);
    const action = parts[1];
    if (!['start', 'stop', 'restart'].includes(action)) return jsonRes(res, 400, { error: '未知操作' });
// ===== Single-process multi-instance mode: start/stop = hot load/detach, instant, no setsid restart script =====
    if (POOL) {
      if (action === 'stop' && name === 'default') return jsonRes(res, 400, { error: 'default 是主实例(主端口所在), 不能停止; 要全停用 shutdown-all' });
      if (action === 'stop') {
        if (!POOL.instances.has(name)) return jsonRes(res, 404, { error: '实例未在运行: ' + name });
        POOL.removeInst(name);
        return jsonRes(res, 200, { ok: true, hot: true, output: '实例 ' + name + ' 已从池中摘除(配置保留, start 可恢复)' });
      }
// both start and restart (re)load
      const c = POOL.reload(name);
      if (!c) return jsonRes(res, 404, { error: '实例配置不存在: ' + name });
      return jsonRes(res, 200, { ok: true, hot: true, output: (action === 'start' ? '已加载' : '已热重载') + '实例 ' + name + ' (' + c.channels.length + ' 渠道)' });
    }
    // the target is this very instance: stop/restart would kill our own process (response cut off + start may never run)
// -> reply to the client first, then run stop/start in a fully detached setsid child (leaves the parent's process group; survives the parent's death)
    if (name === currentName(cfg) && (action === 'stop' || action === 'restart')) {
      jsonRes(res, 200, { ok: true, output: action + ' ' + name + ' (自我' + (action==='restart'?'重启':'停止') + ', 稍候生效, 请刷新页面)', self: true });
// Write a temp script: setsid + nohup so it escapes the process group and finishes even if the parent dies
      const tmpScript = path.join(os.tmpdir() || CORE, '.agw-self-' + action + '.sh');
      const agwPath = path.join(CORE, 'agw.sh');
      if (action === 'restart') {
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nsleep 1\nbash "' + agwPath + '" start ' + name + ' >> "' + path.join(MLOG(), name + '.log') + '" 2>&1\nrm -f "' + tmpScript + '"\n');
      } else {
        fs.writeFileSync(tmpScript, '#!/bin/bash\nsleep 1\nbash "' + agwPath + '" stop ' + name + ' 2>/dev/null\nrm -f "' + tmpScript + '"\n');
      }
      fs.chmodSync(tmpScript, 0o755);
// setsid opens a new session, stdio ignored, unref -- the script keeps running after the parent is killed
      const cp = exec('setsid bash "' + tmpScript + '" </dev/null >/dev/null 2>&1 &', { stdio: 'ignore' }, () => {});
      try { cp.unref(); } catch (e) {}
      return;
    }
    const r = await runAgw([action, name]);
    return jsonRes(res, 200, { ok: r.ok, output: (r.stdout + r.stderr).trim() });
  }

// POST /admin/api/shutdown-all -- shut down all instances (including itself; the panel dies with it)
  // process.kill each instance pid directly (others first, itself last), no bash child (so a dying parent cannot interrupt the children)
  if (req.method === 'POST' && api === 'shutdown-all') {
// Single-process mode: one process hosts all instances; shutdown = this process exits
    if (POOL) {
      jsonRes(res, 200, { ok: true, message: '单进程模式: 正在关闭网关进程(所有实例随之停止)...' });
      setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch (e) {} }, 500);
      return;
    }
    jsonRes(res, 200, { ok: true, message: '正在关闭所有实例...' });
    const myPid = process.pid;
    setTimeout(() => {
      for (const name of listInstances()) {
if (name === currentName(cfg)) continue; // kill ourselves last
        try {
          const pid = parseInt(fs.readFileSync(path.join(MRUN(), name + '.pid'), 'utf8').trim(), 10);
          if (pid && pid !== myPid) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
        } catch (e) {}
      }
// kill ourselves after 1s (leaves other instances time to exit gracefully)
      setTimeout(() => { try { process.kill(myPid, 'SIGTERM'); } catch (e) {} }, 1000);
    }, 500);
    return;
  }

// GET/POST /admin/api/log-cfg/:name -- gateway log file settings + the live writer's state
// Kept separate from POST /config so moving a slider never re-loads the instance.
  if (api.startsWith('log-cfg/')) {
    const name = decodeURIComponent(api.slice('log-cfg/'.length));
    const c = loadCfg(name);
    if (!c) return jsonRes(res, 404, { error: '实例不存在' });
    if (req.method === 'POST') {
      let data; try { data = JSON.parse(bodyStr || '{}'); } catch (e) { return jsonRes(res, 400, { error: 'JSON 无效' }); }
      const next = logfile.normalize(data);
      c.log = next;
      try { saveCfg(name, c); } catch (e) { return jsonRes(res, 500, { error: '保存失败: ' + e.message }); }
      try { logfile.configure(next); } catch (_) {}
      return jsonRes(res, 200, Object.assign({ ok: true, saved: next }, logfile.stats()));
    }
    return jsonRes(res, 200, Object.assign({ ok: true, saved: c.log || logfile.DEF }, logfile.stats()));
  }

// GET /admin/api/logs/:name -- read logs
  if (req.method === 'GET' && api.startsWith('logs/')) {
    const name = decodeURIComponent(api.slice('logs/'.length));
    const lines = parseInt(u.searchParams.get('lines') || '50', 10) || 50;
    return textRes(res, 200, readLog(name, lines), 'text/plain; charset=utf-8');
  }

  function inflightOf(c) {
    const m = c && c._stats && c._stats._inflight;
    if (!m || !m.size) return 0;
    const now = Date.now();
    let n = 0;
for (const [, t] of m) if (now - t < 120000) n++;   // unsettled for 2 minutes counts as dirty
    return n;
  }

// Instance dashboard fields (for CLI commands like agw inst/admin; the old /status was removed)
function dashOf(c) {
  return {
    version: VERSION, listen: c.listen,
    channels: (c.channels || []).map(ch => ({ name: ch.name, type: ch.type, models: (ch.models || []).length })),
    probe: Object.fromEntries(Object.entries(c._stats.probe || {}).map(([k, v]) => [k, { rate: v.total ? Math.round(v.ok / v.total * 100) : null, total: v.total, lastOk: v.lastOk, lastErr: v.lastErr }])),
    breaker: Object.fromEntries(Object.entries(c._breakerState || {}).map(([k, v]) => [k, { broken: !!(v.until > Date.now()), until: v.until || 0, fails: (v.fails || []).length }])),
  };
}

// GET /admin/api/mdns -- the name actually on the air (a LAN name clash renames it at runtime)
  if (req.method === 'GET' && api === 'mdns') {
    let m = {};
    try { const c = loadCfg('default'); m = (c && c.mdns) || {}; } catch (_) {}
    const h = mdns.current();
    return jsonRes(res, 200, {
      enable: !!m.enable,
      name: h ? h.name : (m.name || 'openagw'),
      host: h ? h.host : String(m.name || 'openagw') + '.local',
      url: h ? h.url : '',
      instance: h ? h.instance : '',
      service: h ? h.service : '',
      state: h ? h.state : 'off',
      ips: h ? h.ips : [],
      conflicts: h ? h.conflictsSeen : 0,
    });
  }

// GET /admin/api/stats?instance=X -- live instance stats (cross-instance local proxy supported)
  if (req.method === 'GET' && api === 'stats') {
    const inst = u.searchParams.get('instance') || currentName(cfg);
    if (inst === currentName(cfg)) {
      return jsonRes(res, 200, Object.assign(dashOf(cfg), {
        requests: cfg._stats.requests, inflight: inflightOf(cfg), errors: cfg._stats.errors,
        byChannel: cfg._stats.byChannel, byKey: cfg._stats.byKey || {}, byModel: cfg._stats.byModel || {}, daily: cfg._stats.daily || {},
        hourly: cfg._stats.hourly || {}, minutely: cfg._stats.minutely || {}, startedAt: cfg._stats.startedAt,
        uptime: Math.round(process.uptime()),
      }));
    }
// Single-process mode: read the pool directly, no HTTP loopback
    if (POOL) {
      const tc = POOL.instances.get(inst);
      if (!tc) return jsonRes(res, 404, { error: '实例未在运行: ' + inst });
      return jsonRes(res, 200, Object.assign(dashOf(tc), { requests: tc._stats.requests, inflight: inflightOf(tc), errors: tc._stats.errors, retries: tc._stats.retries || 0, onceChannel: tc._onceChannel || null, byChannel: tc._stats.byChannel, byKey: tc._stats.byKey || {}, byModel: tc._stats.byModel || {}, daily: tc._stats.daily || {}, hourly: tc._stats.hourly || {}, minutely: tc._stats.minutely || {}, startedAt: tc._stats.startedAt, uptime: Math.round(process.uptime()) }));
    }
    const j = await proxyInstance(inst, 'stats');
    if (!j) return jsonRes(res, 404, { error: '无法获取实例 ' + inst + ' 的统计(可能未运行或无可用管理令牌)' });
    const st = j.stats ? j.stats : j;
    return jsonRes(res, 200, Object.assign({ requests: st.requests || 0, errors: st.errors || 0, byChannel: st.byChannel || {}, byModel: st.byModel || {}, daily: st.daily || {}, hourly: st.hourly || {}, minutely: st.minutely || {}, startedAt: j.startedAt, uptime: j.uptime || 0 }, { version: j.version, listen: j.listen, channels: j.channels, probe: j.probe }));
  }

// GET /admin/api/stats-all -- every instance in one shot (the app's stats tab)
  if (req.method === 'GET' && api === 'stats-all') {
    const instances = [];
    const collect = (name, tc) => {
      const st = tc._stats || {};
      const byChannel = st.byChannel || {};
      let inputTokens = 0, outputTokens = 0;
      for (const v of Object.values(byChannel)) {
        inputTokens += Number(v && v.inputTokens) || 0;
        outputTokens += Number(v && v.outputTokens) || 0;
      }
      return {
        name,
        requests: st.requests || 0,
        errors: st.errors || 0,
        inputTokens, outputTokens,
        byChannel,
        byModel: st.byModel || {},
        startedAt: st.startedAt || '',
        disabled: !!tc._disabled,
      };
    };
    if (POOL) {
      for (const [name, tc] of POOL.instances) instances.push(collect(name, tc));
    } else {
      instances.push(collect(currentName(cfg), cfg));
    }
    const totals = { instances: instances.length, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
    const byModel = {};
    for (const it of instances) {
      totals.requests += it.requests; totals.errors += it.errors;
      totals.inputTokens += it.inputTokens; totals.outputTokens += it.outputTokens;
      for (const [m, v] of Object.entries(it.byModel)) {
        const bm = byModel[m] = byModel[m] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        bm.requests += Number(v.requests) || 0;
        bm.inputTokens += Number(v.inputTokens) || 0;
        bm.outputTokens += Number(v.outputTokens) || 0;
      }
    }
    return jsonRes(res, 200, { ok: true, uptime: Math.round(process.uptime()), totals, byModel, instances });
  }

// GET /admin/api/requests/:name -- request log (ring buffer, cross-instance proxy supported)
  if (req.method === 'GET' && api.startsWith('requests/')) {
    const inst = decodeURIComponent(api.slice('requests/'.length));
    if (inst === currentName(cfg)) {
      return jsonRes(res, 200, cfg._stats.recent || []);
    }
// Single-process mode: read the pool directly
    if (POOL) {
      const tc = POOL.instances.get(inst);
      if (!tc) return jsonRes(res, 200, []);
      return jsonRes(res, 200, tc._stats.recent || []);
    }
    const j = await proxyInstance(inst, 'requests/' + inst);
    if (!j) return jsonRes(res, 200, []);
    return jsonRes(res, 200, Array.isArray(j) ? j : (j.recent || []));
  }

// GET /admin/api/record-body/:name?id=req_xxx -- look up a request/response body by id in the local JSONL record file
  if (req.method === 'GET' && api.startsWith('record-body/')) {
    const name = decodeURIComponent(api.slice('record-body/'.length));
    const id = (u.searchParams && u.searchParams.get('id')) || '';
    if (!id) return jsonRes(res, 400, { error: '缺少 id 参数' });
    const f = path.join(MLOG(), 'requests-' + name + '.jsonl');
    if (!fs.existsSync(f)) return jsonRes(res, 404, { error: '没有记录文件 (该实例未开启本地记录, 或记录正发往远程服务器)' });
    const needle = '"id":"' + id + '"';
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (ln && ln.indexOf(needle) !== -1) {
        try { return jsonRes(res, 200, { ok: true, record: JSON.parse(ln) }); }
        catch (_) { return jsonRes(res, 500, { error: '记录解析失败' }); }
      }
    }
    return jsonRes(res, 404, { error: '找不到该请求的正文记录 (该请求发生时可能未开启记录, 或记录文件已轮转)' });
  }

  return jsonRes(res, 404, { error: '未知 API: ' + api });
  }

// ---- 5) panel page + static assets: a session is required (no cookie or token -> 401) ----
  if (p === '/admin/' || p === '/admin/index.html') {
    if (method !== 'GET' && method !== 'HEAD') return textRes(res, 405, '不支持的方法: ' + method + ' ' + p, null, noStore);
    if (!panelSessionOk(cfg, req)) return htmlErr(401, '401', '需要登录。请使用 <code>agw web login</code> 生成的完整链接进入并完成登录。');
    const f = path.join(CORE, 'm3', 'index.html');
    if (!fs.existsSync(f)) return textRes(res, 404, 'M3 面板未找到, 请把 index.html 放到 ' + path.join(CORE, 'm3'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStore });
    return res.end(fs.readFileSync(f));
  }
/* /admin/<static> -- panel JS / vendor bundle / fonts. Session required: the browser sends the
 * cookie on every same-origin subresource; the login page itself is self-contained, so nothing
 * under /admin/ needs to be public. Extension whitelist + m3 containment still apply. */
  if (p.startsWith('/admin/')) {
    if (method !== 'GET' && method !== 'HEAD') return textRes(res, 405, '不支持的方法: ' + method + ' ' + p, null, noStore);
    if (!panelSessionOk(cfg, req)) return htmlErr(401, '401', '需要登录。');
    let rel;
    try { rel = decodeURIComponent(p.slice('/admin/'.length)); } catch (e) { rel = ''; }
    const root = path.join(CORE, 'm3');
    const f = path.join(root, rel);
    const extWl = ['.js', '.mjs', '.css', '.json', '.map', '.woff2', '.woff', '.ttf', '.svg', '.png', '.webp', '.html', '.ico', '.txt'];
    if (rel && !rel.includes('\0') && f.startsWith(root + path.sep)
        && extWl.includes(path.extname(rel).toLowerCase())
        && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const isApp = rel === 'app.js' || rel === 'app.css'; // 面板本体: 不缓存, 改完刷新即生效
      const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.map': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
        '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
      let buf = fs.readFileSync(f);
      const hdr = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
// The panel itself is never cached; vendor assets cache for a day (large and content-named)
        'Cache-Control': (ext === '.html' || isApp) ? 'no-store, no-cache, must-revalidate' : 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*', 'Vary': 'Accept-Encoding',
      };
      if (isApp) { hdr['Pragma'] = 'no-cache'; hdr['Expires'] = '0'; }
      // text assets >1KB when the client supports it -> gzip (the 288KB component bundle shrinks to ~56KB)
      if (buf.length > 1024 && ['.js', '.mjs', '.css', '.json', '.map'].includes(ext)
          && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        buf = zlib.gzipSync(buf, { level: 9 });
        hdr['Content-Encoding'] = 'gzip';
      }
      hdr['Content-Length'] = buf.length;
      res.writeHead(200, hdr);
      return res.end(buf);
    }
    // missing file / traversal attempt: explicit 404, never a hanging response
    return textRes(res, 404, '面板资源不存在: ' + rel, null, noStore);
  }
  return null;
}

module.exports = { handleAdmin, checkAdminAuth, adminKeysOf, needsPanelLogin, panelSessionOk, readSessEnt, setDir, setUpstreamModels, setSyncFn, setBalanceFn, setPool, setPlugins, saveCfg, totpCode, totpVerify, base32Encode };
