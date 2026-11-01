#!/usr/bin/env node
'use strict';
/* agw -- ai-gateway unified CLI (jihuasheng.md spec)
 * Entry: ~/bin/agw -> ~/ai-gateway/agw.js
 * Reads config: file directly + crypt.js decryption (AGWENC1); writes config: hot-applied via the admin API (when the instance is running)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const crypt = require(path.join(__dirname, 'crypt.js'));
const panelAuth = require(path.join(__dirname, 'panel-auth.js'));
const { utf8 } = require(path.join(__dirname, 'util.js'));

const DIR = __dirname; // code root
const DATA_DIR = path.join(__dirname, 'data'); // data root: config*/ball*/.agwkey/log etc.
const HOME = os.homedir();
/* ===== i18n: default en, override via GW_LANG env or ~/.agwlang; zh-CN is the key language ===== */
const LANG_FILE = path.join(HOME, '.agwlang');
const LANGS = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'ru', 'es', 'fr', 'eo'];
const DEF_LANG = 'en';
function currentLang() {
  if (process.env.GW_LANG && LANGS.includes(process.env.GW_LANG)) return process.env.GW_LANG;
  try { const v = fs.readFileSync(LANG_FILE, 'utf8').trim(); if (LANGS.includes(v)) return v; } catch (_) {}
  return DEF_LANG;
}
let _t = null, _tn = null;
try {
  if (currentLang() !== 'zh-CN') {
    _t = JSON.parse(fs.readFileSync(path.join(__dirname, 'lang', currentLang() + '.json'), 'utf8'));
    _tn = {}; // normalized keys (trimmed + inner whitespace collapsed): for line-by-line matching of help blocks
    for (const k of Object.keys(_t)) _tn[k.trim().replace(/\s+/g, ' ')] = _t[k];
  }
} catch (_) { _t = null; }
function t(s) {
  if (!_t) return s;
  if (!s.includes('\n')) { const h = _t[s]; return h === undefined ? s : h; }
  return s.split('\n').map(line => {
    if (!line.trim()) return line;
    const h = _t[line];
    if (h !== undefined) return h;
    const n = line.trim().replace(/\s+/g, ' ');
    if (_tn[n] === undefined) return line;
    const indent = line.match(/^\s*/)[0];
    return indent + _tn[n];
  }).join('\n');
}
const BIN = path.join(HOME, 'bin');

/* ---------- tiny utils ---------- */
const C = process.stdout.isTTY ? {
  dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, grn: s => `\x1b[32m${s}\x1b[0m`,
  yel: s => `\x1b[33m${s}\x1b[0m`, cyn: s => `\x1b[36m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
} : { dim: s => s, red: s => s, grn: s => s, yel: s => s, cyn: s => s, bold: s => s };
let LOOPING = false; // inside a loop, die throws instead of exiting; the REPL catches and prints it
const die = m => { if (LOOPING) throw new Error(t(m)); console.error(C.red('✗ ' + t(m))); process.exit(1); };
const ok = m => console.log(C.grn('✓ ' + t(m)));
function parseNum(v) { // lenient numbers like "200k"
  if (v == null) return NaN;
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^([\d.]+)\s*(ki|mi|k|m|%)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const mult = { '': 1, k: 1e3, m: 1e6, ki: 1024, mi: 1048576, '%': 1 }[m[2] || ''];
  return n * mult;
}
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'k' : String(n);
function fmtTok(n) { n = Number(n) || 0; return n >= 1e8 ? (n / 1e8).toFixed(2) + 'Y' : n >= 1e4 ? (n / 1e4).toFixed(1) + 'W' : String(n); }
function fmtDur(ms) { return ms >= 60000 ? (ms / 60000).toFixed(1) + 'min' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; }
function humanTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 864e5) return fmtDur(diff) + ' ago';
  return iso.slice(0, 16).replace('T', ' ');
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function ask(q) {
  return new Promise(res => {
    process.stdout.write(q);
    let buf = ''; process.stdin.setRawMode && process.stdin.setRawMode(false);
    const u8in = utf8();
    const onData = d => { const s = u8in(d); if (s.includes('\n') || s === '\r' || s === '\n') { process.stdin.removeListener('data', onData); res(buf.trim()); } else buf += s; };
    process.stdin.on('data', onData);
  });
}
function confirm(q) { return ask(C.yel(q + ' (y/N) ')).then(a => /^y(es)?$/i.test(a)); }

/* ---------- config layer (encrypted-aware) ---------- */
const cfgRe = /^config(\..+)?\.json$/;
function listInsts() {
  try { return fs.readdirSync(DATA_DIR).filter(f => cfgRe.test(f) && f !== 'config.example.json').sort()
    .map(f => f === 'config.json' ? 'default' : f.replace(/^config\./, '').replace(/\.json$/, '')); }
  catch (e) { return []; }
}
function cfgPathOf(name) { return name === 'default' ? path.join(DATA_DIR, 'config.json') : path.join(DATA_DIR, `config.${name}.json`); }
function loadCfg(name) {
  const f = cfgPathOf(name);
  if (!fs.existsSync(f)) die(`instance not found: ${name} (have: ${listInsts().join(', ') || 'none'})`);
  const raw = fs.readFileSync(f, 'utf8');
  if (crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) die(`${f} is encrypted but no passphrase found (.agwkey / AGW_CRYPT_PASS)`);
    try { return JSON.parse(crypt.decryptText(raw, pass)); }
    catch (e) { die(`decrypt failed: ${e.message}`); }
  }
  try { return JSON.parse(raw); } catch (e) { die(`${f} broken JSON: ${e.message}`); }
}
function saveCfg(name, cfg) { // preserve the file's original encryption state (re-encrypt if it was ciphertext)
  const f = cfgPathOf(name);
  const raw = fs.readFileSync(f, 'utf8');
  const bak = f + '.agwbak';
  if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
  // Legacy multi-user data must never be written back (removed 2026-10).
  delete cfg.users;
  delete cfg.registration;
  let out = JSON.stringify(cfg, null, 2) + '\n';
  if (crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) die(`cannot preserve encryption (no passphrase): ${f}`);
    out = crypt.encryptText(out, pass);
  }
  fs.writeFileSync(f, out);
}
function needLive() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(DATA_DIR, '.run', 'main.pid'), 'utf8').trim()); } catch (_) {}
  if (pid) { try { process.kill(pid, 0); } catch (_) { die(`gateway not running (pid ${pid} is stale); run agw.sh start first`); } }
  else die('gateway not running (no .run/main.pid); run agw.sh start first');
  const c = loadCfg('default');
  const port = (c.listen || {}).port || 16384;
  const tls = !!(c.tls && c.tls.enable);
  return { port, tls, pid };
}
function instLive(name, tok) { // is the instance running in the pool (reading the pool port table regressed: no /health/<name> route, so use admin instances)
  return api('GET', '/admin/api/instances', null, tok).then(d => {
    const it = (d.instances || []).find(x => x.name === name);
    return it ? it : null;
  }).catch(() => null);
}
async function hotRestart(name, tok) { // restart a running instance to apply config changes; tok = explicit token (after token rotation the gateway still holds the old token in memory, so calls must use the old one)
  const it = await instLive(name, tok);
  if (it && it.running) { await api('POST', `/admin/api/action/${name}/restart`, null, tok); ok(t('实例 %s 已热重启生效').replace('%s', name)); }
  else console.log(C.dim('实例未在运行, 下次启动生效'));
}

/* ---------- admin api (loopback, adminKey from default cfg) ---------- */
function adminKey() {
  try {
    const c = loadCfg('default');
    const ps = panelAuth.read(c, 'default');
    return (ps && ps.adminToken) || c.webToken || '';
  } catch (_) { return ''; }
}
function api(method, p, body, tok) {
  return new Promise((resolve, reject) => {
    const st = needLive();
    const tls = !!st.tls;
    const opts = {
      host: '127.0.0.1', port: st.port, method,
      path: p, timeout: 30000,
      headers: { 'x-agw-token': tok || adminKey(), 'Content-Type': 'application/json' },
...(tls ? { rejectUnauthorized: false } : {}), // self-signed CA: local loopback
    };
    const mod = tls ? https : http;
    const req = mod.request(opts, res => {
      const u8a = utf8();
      let buf = ''; res.on('data', d => buf += u8a(d));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${p}: ${(j && j.error) || trunc(buf, 200)}`));
        resolve(j !== null ? j : buf);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时(30s)')); });
    req.on('error', reject);
if (body != null) req.write(JSON.stringify(body)); // no body for null/undefined (a GET with a body gets the connection cut early by servers)
    req.end();
  });
}

/* ---------- value formatters ---------- */
function onoff(v) { return v ? C.grn('on') : C.dim('off'); }
function msStr(ms) { return ms >= 1000 ? (ms / 1000) + 's' : ms + 'ms'; }
function maskKey(k) { return k ? k.slice(0, 6) + '…' + k.slice(-4) : '-'; }
function parseHostPort(s, defPort) {
  let host = s, port = defPort, tls = false;
  const m = String(s).match(/^(https?:\/\/)?\[?([^\]\/]+)\]?:(\d+)$/);
  if (m) { if (m[1] === 'https:') tls = true; host = m[2]; port = Number(m[3]); }
  else if (/^https:\/\//.test(s)) { tls = true; host = s.replace(/^https:\/\//, ''); }
  else if (/^http:\/\//.test(s)) host = s.replace(/^http:\/\//, '');
  return { host, port, tls };
}
function parseUserPass(s) { // user[:pass]@host[:port]
  let cred = '', hostPart = s;
  const at = s.lastIndexOf('@');
  if (at >= 0) { cred = s.slice(0, at); hostPart = s.slice(at + 1); }
  let user = cred, pass = '';
  const co = cred.indexOf(':');
  if (co >= 0) { user = cred.slice(0, co); pass = cred.slice(co + 1); }
  let host = hostPart, port;
  const hp = hostPart.split(':');
  if (hp.length >= 2) { host = hp.slice(0, -1).join(':'); port = Number(hp[hp.length - 1]); }
  return { user, pass, host, port };
}

/* ================================================================
 *  agw inst
 * ================================================================ */
function cmdInst(argv) {
  const a = argv[0];
  if (canLoop() && a && !a.startsWith('-') && !['help', '--help', 'list', 'delete'].includes(a) && argv.length === 1 && listInsts().includes(a)) return loopInst(a);
  if (!a) return cmdInst(['list']);
  if (!a || a === 'help' || a === '--help') {
    console.log(t(`用法:
  agw inst list                     列出全部实例(端口/运行态/TLS)
  agw inst delete <name> [-y]       删除实例(配置/日志/pid, default 不可删)
  agw inst <name> [start|stop]      启动/停止(缺省=进入实例 loop)
  agw inst <name> --status <kind>   日志/统计: all|requests|error|debug (默认 all, 50 行)
  agw inst <name> --apikey <key>    设置 Gateway-Key(空串=清除)
  agw inst <name> --webtoken <key>  设置可选的管理 API 令牌(面板登录不需要)
  agw inst <name> --tls <on|off>    启用 TLS(该实例只在 listen.port 提供 HTTPS; 非 default 实例则只经主端口 /name/ 访问)
  agw inst <name> --cold <sec>      上游连接超时秒数
  agw inst <name> --filter <on/off> 隐私过滤(密钥/敏感信息打码)
  agw inst <name> --filter-resp <on/off>  响应方向也打码
  agw inst <name> --transcreet <on/off/res-only>  非流式 DSML 清洗范围`));
    return;
  }
  if (a === 'list') return listInsts().forEach(n => {
    let c; try { c = loadCfg(n); } catch (e) { return console.log(`  ${pad(n, 22)} ${C.red('(config read failed)')}`); }
    const port = (c.listen || {}).port || 16384;
    const tls = !!(c.tls && c.tls.enable);
    console.log(`  ${pad(n, 22)} :${pad(port, 6)} ${tls ? 'HTTPS' : 'HTTP '}  key:${c.gatewayKey ? 'set' : '-'}  panel:${panelAuth.read(c, n) ? 'ready' : '-'}`);
  });
  if (a === 'delete') {
    const name = argv[1]; if (!name) die('Usage: agw inst delete <name> [-y]');
    if (name === 'default') die('The default instance cannot be deleted');
    const doDel = async () => {
      try { await api('POST', `/admin/api/shutdown-all`); } catch (_) {} // 关全池(pool 模式无法单停)
      try { fs.renameSync(cfgPathOf(name), cfgPathOf(name) + '.deleted.' + Date.now()); ok(`Config removed (backup kept as .deleted.*)`); } catch (e) { die(e.message); }
      for (const f of [path.join(DATA_DIR, 'log', `requests-${name}.jsonl`), path.join(DATA_DIR, 'log', `${name}.log`)])
        if (fs.existsSync(f)) fs.renameSync(f, f + '.deleted.' + Date.now());
      ok(`Instance ${name} deleted; run agw.sh start to relaunch the rest`);
    };
    if (/^-y|^--yes/.test(argv[2] || '')) return doDel();
    return confirm(`Delete instance ${name}? (config is backed up before removal) `).then(y => y ? doDel() : console.log('Cancelled'));
  }
  const name = a;
  const flags = argv.slice(1);
  const get = (fl) => { const i = flags.indexOf(fl); return i >= 0 ? flags[i + 1] : undefined; };
  const has = (fl) => flags.includes(fl);
  if (has('help')) return cmdInst(['help']);
  const onlyStatus = flags.length === 0;
  const touch = [];
  if (has('--apikey')) touch.push(() => { const c = loadCfg(name); c.gatewayKey = get('--apikey') || ''; saveCfg(name, c); ok(`gatewayKey ${c.gatewayKey ? 'set (' + c.gatewayKey.length + ' chars)' : 'cleared'}`); });
  const wtv = get('--webtoken') !== undefined ? get('--webtoken') : get('--adminkey'); // optional long-lived API token; panel login uses agw web login
  if (has('--webtoken') || has('--adminkey')) touch.push(() => { const c = loadCfg(name); c.webToken = wtv || ''; saveCfg(name, c); ok(`webToken ${c.webToken ? 'set' : 'cleared'}`); });
  if (has('--tls')) touch.push(() => {
    const c = loadCfg(name); const pv = get('--tls');
    if (!pv || pv === '0' || pv === 'off') { c.tls = { enable: false }; ok('TLS disabled'); }
    else {
      const cert = (c.tls && c.tls.cert) || 'cert.pem', key = (c.tls && c.tls.key) || 'key.pem';
      c.tls = { enable: true, cert, key };
      if (name === 'default') ok(`TLS enabled (port ${(c.listen || {}).port || 16384} HTTPS-only)`);
      else {
        const main = readCfgSafe('default');
        ok(`TLS enabled: this instance no longer listens on its own port; reachable only via main port /${name}/`);
        if (!(main && main.tls && main.tls.enable)) console.log(C.yel('  ⚠ default 未开启 TLS, 该实例将无法访问: 请先给 default 开启 TLS (agw-tls setup)'));
      }
    }
    saveCfg(name, c);
  });
  if (has('--cold')) touch.push(() => { const c = loadCfg(name); c.connectTimeout = Math.round(parseNum(get('--cold')) * 1000); saveCfg(name, c); ok(`connectTimeout = ${msStr(c.connectTimeout)}`); });
  if (has('--filter')) touch.push(() => {
    const c = loadCfg(name); const v = get('--filter');
    c.redact = c.redact || {}; c.redact.enable = !/^off$/i.test(v || 'on');
    saveCfg(name, c); ok(`Privacy filter ${onoff(c.redact.enable)}`);
  });
  if (has('--filter-resp')) touch.push(() => {
    const c = loadCfg(name); const v = get('--filter-resp');
    c.redact = c.redact || {}; c.redact.response = !/^off$/i.test(v || 'on');
    saveCfg(name, c); ok(`Response filter ${onoff(c.redact.response)}`);
  });
  if (has('--transcreet')) touch.push(() => {
    const c = loadCfg(name); const v = (get('--transcreet') || 'on').toLowerCase();
    c.dsmlClean = { enable: v !== 'off', reasoning: v === 'on' };
    saveCfg(name, c);
    ok(`DSML cleaning ${v === 'on' ? 'on (with chain-of-thought)' : v === 'res-only' ? 'res-only (response only)' : 'off'}`);
  });
  const showStatus = async () => {
    const kind = (get('--status') || 'all').toLowerCase();
    const N = 50;
    const c = loadCfg(name);
    const port = (c.listen || {}).port, tls = !!(c.tls && c.tls.enable);
    console.log(C.bold(`■ ${name}  :${port} ${tls ? 'HTTPS' : 'HTTP'}`));
    if (kind === 'requests' || kind === 'all') {
      try {
        const d = await api('GET', `/admin/api/stats?instance=${encodeURIComponent(name)}`);
        const s = d.stats || d;
        console.log('  ' + t('请求 %s 错误 %s 重试 %s 运行 %s').replace('%s', String(s.requests || 0)).replace('%s', String(s.errors || 0)).replace('%s', String(s.retries || 0)).replace('%s', humanTime(s.startedAt)));
        const bc = s.byChannel || {};
        const rows = Object.entries(bc).sort((x, y) => y[1].requests - x[1].requests).slice(0, 10);
        for (const [cn, v] of rows) console.log(`    ${pad(cn, 20)} ${v.requests} req ${v.errors ? C.red(v.errors + ' err') : ''}`);
      } catch (e) { if (kind === 'requests') die(e.message); }
    }
    if (kind === 'usage') {
      try {
        const d = await api('GET', `/admin/api/stats?instance=${encodeURIComponent(name)}`);
        const s2 = d.stats || d;
        const rows = Object.entries(s2.byChannel || {}).sort((x, y) => (y[1].requests || 0) - (x[1].requests || 0));
        if (rows.length) {
          console.log(C.dim('  渠道用量(请求 / 输入 / 输出)'));
          for (const [cn, v] of rows) console.log(`    ${pad(cn, 20)} ${pad(String(v.requests || 0), 7)} ${pad(fmtTok(v.inputTokens || 0), 9)} ${pad(fmtTok(v.outputTokens || 0), 9)}`);
        }
        const ks = Object.entries(s2.byKey || {}).sort((x, y) => (y[1].requests || 0) - (x[1].requests || 0));
        if (ks.length) {
          console.log(C.dim('  卡密用量'));
          for (const [kn, v] of ks.slice(0, 20)) console.log(`    ${pad(kn, 20)} ${pad(String(v.requests || 0), 7)} req`);
        }
        if (!rows.length && !ks.length) console.log(C.dim('  暂无用量'));
      } catch (e) { die(e.message); }
    }
    if (kind === 'error' || kind === 'all') {
      let log = '';
      try { log = await api('GET', `/admin/api/logs/${encodeURIComponent(name)}?lines=400`); } catch (e) { log = ''; }
      const errLines = String(log).split('\n').filter(l => /error|fail|✗|失败|超时/i.test(l)).slice(-N);
      if (errLines.length) { console.log(C.red('  [近期错误]')); errLines.forEach(l => console.log('  ' + trunc(l, 150))); }
      else if (kind === 'error') console.log('  No error records');
    }
    if (kind === 'debug' || kind === 'all') {
      let log = '';
      try { log = await api('GET', `/admin/api/logs/${encodeURIComponent(name)}?lines=${kind === 'all' ? N : 200}`); } catch (e) { if (kind === 'debug') die(e.message); }
      if (log) { console.log(C.dim('  [日志尾部]')); String(log).split('\n').slice(-N).forEach(l => console.log('  ' + trunc(l, 150))); }
    }
  };
  if (onlyStatus) return showStatus();
  if (has('--status')) return Promise.all(touch.map(t => t())).then(showStatus); // --status 原先只被 onlyStatus 分支使用, 显式传参时无输出
  const valFlags = ['--apikey', '--webtoken', '--adminkey', '--tls', '--cold', '--filter', '--filter-resp', '--transcreet', '--status'];
  const act = flags.find((f, i) => !f.startsWith('--') && !valFlags.includes(flags[i - 1]));
  if (act === 'start' || act === 'stop') {
    return api('POST', `/admin/api/action/${name}/${act}`).then(d => ok(`${name} ${act}${d && d.restarting ? '' : ''}`)).catch(e => die(e.message + ' (单进程池模式下或需 agw.sh restart)'));
  }
  if (act) die(`Unknown argument: ${act}`);
  return Promise.all(touch.map(t => t())).then(hotRestart.bind(null, name));
}

/* ================================================================
 *  agw router
 * ================================================================ */
function cmdRouter(argv) {
  const name = argv[0];
  if (!name || name === 'help' || /help/.test(argv[1] || '')) {
    console.log(t(`用法:
  agw router <inst>                          查看路由相关配置
  agw router <inst> --retry <num>            渠道故障重试次数(connRetry)
  agw router <inst> --timeout <sec>          上游响应超时(responseTimeout)
  agw router <inst> --cold <sec>             上游连接超时(connectTimeout)
  agw router <inst> --models-fetch <h>       模型自动同步间隔(0=关)
  agw router <inst> --filter <on/off>        隐私过滤 redact.enable
  agw router <inst> --filter-resp <on/off>   响应方向打码 redact.response
  agw router <inst> --transcreet <on/off/res-only>  非流式 DSML 清洗(dsmlClean)`));
    return;
  }
  const c = loadCfg(name);
  if (!argv[1] || !argv[1].startsWith('--')) return showRouter(c);
  const touch = [];
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  if (get('--retry') != null) touch.push(() => { c.connRetry = Math.max(0, Number(get('--retry')) || 0); });
  if (get('--timeout') != null) touch.push(() => { c.responseTimeout = Math.round(parseNum(get('--timeout')) * 1000); });
  if (get('--cold') != null) touch.push(() => { c.connectTimeout = Math.round(parseNum(get('--cold')) * 1000); });
  if (get('--models-fetch') != null) touch.push(() => {
    const h = Number(get('--models-fetch')) || 0;
    c.modelSync = c.modelSync || {}; c.modelSync.enable = h > 0; c.modelSync.intervalHours = Math.max(1, h || 24);
  });
  if (get('--filter') != null) touch.push(() => { c.redact = c.redact || {}; c.redact.enable = !/^off$/i.test(get('--filter')); });
  if (get('--filter-resp') != null) touch.push(() => { c.redact = c.redact || {}; c.redact.response = !/^off$/i.test(get('--filter-resp')); });
  if (get('--transcreet') != null) touch.push(() => {
    const v = get('--transcreet').toLowerCase();
    c.dsmlClean = { enable: v !== 'off', reasoning: v === 'on' };
  });
  if (!touch.length) return showRouter(c);
  touch.forEach(f => f());
  saveCfg(name, c);
  showRouter(loadCfg(name));
  return hotRestart(name);
}
function showRouter(c) {
  console.log(`  connRetry=${c.connRetry ?? 2}  responseTimeout=${msStr(c.responseTimeout || 180000)}  connectTimeout=${msStr(c.connectTimeout || 15000)}
  modelSync=${(c.modelSync && c.modelSync.enable !== false) ? (c.modelSync.intervalHours || 24) + 'h' : C.dim('off')}  redact=${onoff(c.redact && c.redact.enable)}${(c.redact && c.redact.response) ? '+resp' : ''}  dsml(non-stream)=${(c.dsmlClean && c.dsmlClean.enable) ? ((c.dsmlClean.reasoning ? 'on' : 'res-only')) : 'off'}`);
}

/* ================================================================
 *  agw chan
 * ================================================================ */
function cmdChan(argv) {
  const name = argv[0];
  if (canLoop() && name && !name.startsWith('-') && name !== 'help' && argv.length === 1 && listInsts().includes(name)) return loopChan(name);
  if (!name || name === 'help' || /help/.test(argv[1] || '')) {
    console.log(t(`用法:
  agw chan <inst>                                   列出该实例全部渠道
  agw chan <inst> --sdk <openai|gemini|claude>       设置全局默认上游格式(新增渠道缺省)
  agw chan <inst> --provider <name> "<url=…, key=…>"  新建/更新渠道
  agw chan <inst> --provider <name> --remove          删除渠道
  agw chan <inst> --provider <name> --scope "请求模型=真实模型, …"  模型映射/白名单
  agw chan <inst> --provider <name> --value <BaseURL> <JSON-Key> <Currency>  余额代查覆盖
  agw chan <inst> --provider <name> --proxy "user:pass@host:port"    渠道代理
  agw chan <inst> --provider <name> --path "/v1/chat/completions"   锁定上游路径(忽略客户端 path)
  agw chan <inst> --provider <name> --warn <num>     余额低于该值发系统通知
  例: agw chan DeepSeek --provider newapi "url=https://api.xx.com, key=sk-xxx" --scope "gpt-4o=deepseek-v3"`));
    return;
  }
  const c = loadCfg(name);
  const pi = argv.indexOf('--provider');
  if (pi < 0) { // list all channels
    if (argv[1] === '--sdk') { c.channels = c.channels || []; const v = argv[2]; if (!['openai', 'gemini', 'claude'].includes(v)) die('--sdk accepts only openai|gemini|claude'); c.channels.forEach(ch => { if (!ch.type) ch.type = v; }); saveCfg(name, c); return ok(`Default type written to channels without one = ${v}`); }
    if (!c.channels || !c.channels.length) return console.log('  (no channels)');
    for (const ch of c.channels) {
      const lk = chanLockInfo(ch);
      console.log(`  ${C.cyn(pad(ch.name, 18))} ${pad(ch.type || 'openai', 8)} ${trunc(ch.baseUrl, 46)}${ch.default ? C.grn(' [default]') : ''}${lk.locked ? C.red(' [locked]') + C.dim(' until ' + fmtWhen(lk.until || 0)) : lk.scheduled ? C.yel(' [lock at ' + fmtWhen(lk.at) + ']') : ''}
      models:${(ch.models || []).length || '-'} map:${Object.keys(ch.modelMap || {}).length} proxy:${ch.proxy || '-'} delay:${ch.delayMs || 0}ms path:${ch.path || 'auto'} dsml:${ch.transcreet || 'inherit'} bal:${ch.balanceUrl ? 'custom' : ''}${ch.balanceWarn ? C.yel(' warn<' + ch.balanceWarn + '>') : ''}`);
    }
    return;
  }
  const chName = argv[pi + 1]; if (!chName) die('--provider needs a channel name');
  const kv = argv[pi + 2];
  let ch = (c.channels || []).find(x => x.name === chName);
  const isNew = !ch;
  if (isNew) { ch = { name: chName, type: 'openai', baseUrl: '', apiKey: '', models: [] }; c.channels = c.channels || []; c.channels.push(ch); }
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  const has = fl => argv.includes(fl);
  let changed = false;
  if (kv && !kv.startsWith('--')) { // "url=…, key=…" 逗号串
    for (const pair of kv.split(/[,，]/)) {
      const m = pair.trim().match(/^(url|key)\s*=\s*(.+)$/);
      if (!m) die(`--provider value format: "url=BaseURL, key=APIKey", got: ${pair}`);
      if (m[1] === 'url') ch.baseUrl = m[2].trim(); else ch.apiKey = m[2].trim();
      changed = true;
    }
  }
  if (has('--remove')) {
    if (isNew) die(`Channel not found: ${chName}`);
    c.channels = c.channels.filter(x => x.name !== chName);
    saveCfg(name, c); ok(`Channel ${chName} deleted`); return hotRestart(name);
  }
  if (has('--scope')) {
    const s = get('--scope'); if (!s) die('--scope needs a "request-model=real-model" string');
    const map = {}; let hasPlain = false;
    for (const pair of s.split(/[,，]/)) {
      const t = pair.trim(); if (!t) continue;
      const m = t.match(/^(.+?)=(.+)$/);
      if (m) map[m[1].trim()] = m[2].trim(); else { hasPlain = true; }
    }
    if (Object.keys(map).length) ch.modelMap = map;
    if (hasPlain) ch.models = s.split(/[,，]/).map(x => x.trim()).filter(x => x && !x.includes('='));
    changed = true;
  }
  if (has('--value')) { // <BaseURL> <JSON-Key> <Currency>
    const vi = argv.indexOf('--value');
    const bu = argv[vi + 1], jk = argv[vi + 2], cur = argv[vi + 3];
    if (!bu || !jk) die('--value needs <BaseURL> <JSON-Key> [Currency]');
    ch.balanceUrl = bu; ch.balancePath = jk; if (cur) ch.balanceUnit = cur;
    changed = true;
  }
  if (has('--path')) {
    const v = String(get('--path') || '').trim();
    if (/^(none|clear|-|空)$/i.test(v) || v === '') delete ch.path;
    else if (/^https?:\/\//i.test(v)) die('--path 需要路径, 不能是完整 URL: ' + v);
    else ch.path = v.charAt(0) === '/' ? v : '/' + v;
    changed = true;
  }
  if (has('--proxy')) {
    const p = parseUserPass(get('--proxy'));
    const scheme = 'socks5://'; // 计划通 proxy 默认按 socks5; 需要 http 代理时 --proxy "…@host:port?type=http"
    let s = scheme + p.host; if (p.port) s += ':' + p.port;
    if (p.user || p.pass) s += '?' + (p.user ? `username=${encodeURIComponent(p.user)}` : '') + (p.pass ? `${p.user ? '&' : ''}password=${encodeURIComponent(p.pass)}` : '');
    ch.proxy = s;
    changed = true;
    console.log(C.dim('  (代理按 socks5 处理; HTTP 代理请在 agw chan 后手工调整 config)'));
  }
  if (has('--warn')) {
    const w = parseNum(get('--warn')); if (!(w > 0)) die('--warn needs a positive balance threshold');
    ch.balanceWarn = w; changed = true;
  }
  if (!changed && !isNew) return console.log('  (no changes)');
  if (isNew && !ch.baseUrl) die('A new channel needs url=…');
  saveCfg(name, c);
  ok(t('渠道 %s %s').replace('%s', chName).replace('%s', isNew ? t('新建') : t('已更新')));
  return hotRestart(name);
}

/* ================================================================
 *  agw fetch  (model sync)
 * ================================================================ */
function cmdFetch(argv) {
  const a = argv[0];
  if (a === 'chan') {
    const chName = argv[1], inst = argv[2];
    if (!chName) die('Usage: agw fetch chan <channel-name> [instance]');
    return api('POST', `/admin/api/channel-models/${encodeURIComponent(inst || 'default')}`, { name: chName })
      .then(d => {
        const ms = d.models || d.list || [];
        console.log(t('渠道 %s 上游模型 %s 个:').replace('%s', chName).replace('%s', String(ms.length)));
        ms.slice(0, 60).forEach(m => console.log('  ' + (typeof m === 'string' ? m : m.id || JSON.stringify(m))));
        if (ms.length > 60) console.log(C.dim(`  … ${ms.length} in total`));
      }).catch(e => die(e.message + ' (channel-models API 以渠道名匹配, 请确认渠道存在)'));
  }
  if (a === 'inst') {
    const inst = argv[1]; if (!inst) die('Usage: agw fetch inst <instance> [-y]');
    const yes = argv.includes('-y') || argv.includes('--yes');
    const run = () => api('POST', `/admin/api/sync-models${inst && inst !== 'all' ? '?instance=' + encodeURIComponent(inst) : ''}`)
      .then(d => { const s = d.summary || d; ok('Model sync done'); console.log(JSON.stringify(s, null, 2).slice(0, 2000)); });
    if (yes) return run();
    return confirm(`从上游拉取模型列表并覆盖本地 models? `).then(y => y ? run() : console.log('Cancelled'));
  }
  console.log(t(`用法:
  agw fetch chan <channel-name> [instance]   拉取该渠道上游模型列表(只看)
  agw fetch inst <instance> [-y]              同步模型列表覆盖本地(-y 免确认)`));
}

/* ================================================================
 *  agw card
 * ================================================================ */
function cmdCard(argv) {
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  const has = fl => argv.includes(fl);
  const inst = get('--inst') || 'default';
  if (!argv.length || has('help')) { console.log(t(`用法:
  agw card --generate --name <名> [--balance <tokens>] [--expires <ISO日期>] [--inst <实例>]
  agw card --delete <card-id>        [--inst]
  agw card --charge <card-id> --balance <num>  [--inst]
  agw card --length <8~128>          [--inst]   新卡密钥长度
  agw card ban <card-id>             [--inst]   停用卡
  agw card list                      [--inst]   卡列表
  (无 --inst 时作用于 default)`)); return; }
  const load = () => loadCfg(inst);
  const findKey = (c, id) => (c.apiKeys || []).find(k => k.key === id || k.key.endsWith(id) || k.name === id);
  if (has('--generate')) {
    const c = load();
    const name = get('--name') || ('card-' + new Date().toISOString().slice(0, 10));
    const quota = has('--balance') ? Math.max(0, parseNum(get('--balance')) || 0) : 0;
    const body = { name, quotaTokens: quota, expiresAt: get('--expires') || '' };
    return api('POST', `/admin/api/keys/${encodeURIComponent(inst)}`, body).then(d => {
      ok(t('新卡已生成 (实例 %s)').replace('%s', inst));
      console.log(`  key:   ${C.bold(d.key)}`);
      console.log(`  Quota:  ${quota ? fmtTok(quota) + ' tokens' : 'unlimited'}${body.expiresAt ? '  expires: ' + body.expiresAt : ''}`);
      console.log(C.dim('  完整 key 只显示这一次, 请立即保存'));
    }).catch(e => die(e.message));
  }
  if (has('--delete')) {
    const id = get('--delete'); const c = load(); const k = findKey(c, id);
    if (!k) die(`Card not found: ${id}`);
    return api('DELETE', `/admin/api/keys/${encodeURIComponent(inst)}/${encodeURIComponent(k.key)}`).then(() => ok(`Card ${trunc(k.key, 10)}… (${k.name || '-'}) deleted`)).catch(e => die(e.message));
  }
  if (has('--charge')) {
    const id = get('--charge'); const add = parseNum(get('--balance'));
    if (!(add > 0)) die('--charge needs --balance <num> (amount to add)');
    const c = load(); const k = findKey(c, id);
    if (!k) die(`卡不存在: ${id}`);
    return api('POST', `/admin/api/keys-update/${encodeURIComponent(inst)}`, { key: k.key, addQuota: add }).then(() => ok(`Card ${trunc(k.key, 10)}… charged ${fmtTok(add)} tokens`)).catch(e => die(e.message));
  }
  if (has('--length')) {
    const n = Number(get('--length'));
    if (!(n >= 8 && n <= 128)) die('--length must be 8~128');
    const c = load(); c.keyLength = Math.round(n); saveCfg(inst, c);
    return ok(`New card length = ${n}`);
  }
  if (argv[0] === 'ban') {
    const id = argv[1]; const c = load(); const k = findKey(c, id);
    if (!k) die(`卡不存在: ${id}`);
    return api('POST', `/admin/api/keys-update/${encodeURIComponent(inst)}`, { key: k.key, enable: false }).then(() => ok(`Card ${trunc(k.key, 10)}… (${k.name || '-'}) disabled`)).catch(e => die(e.message));
  }
  if (argv[0] === 'list') {
    const c = load();
    if (!(c.apiKeys || []).length) return console.log('  (no cards)');
    for (const k of c.apiKeys) {
      const used = k.usedTokens || 0, q = k.quotaTokens || 0;
      const bar = q ? '[' + '█'.repeat(Math.round(10 * Math.min(1, used / q))) + '░'.repeat(10 - Math.round(10 * Math.min(1, used / q))) + ']' : '[   ∞   ]';
      console.log(`  ${pad(trunc(k.key, 14), 16)} ${pad(k.name || '-', 14)} ${k.enable === false ? C.red('disabled') : C.grn('enabled')} ${bar} ${fmtTok(used)}${q ? '/' + fmtTok(q) : ''}${k.expiresAt ? C.yel(' until ' + k.expiresAt.slice(0, 10)) : ''}`);
    }
    return;
  }
  console.log('Unknown argument; see agw card help');
}

/* ================================================================
 *  agw refresh ca / record / cloudflared
 * ================================================================ */
function cmdRefresh(argv) {
  if (argv[0] !== 'ca') { console.log(t('Usage: agw refresh ca  — 检查并按需重签 TLS 证书(过期/换 CA/SAN 缺当前 IP 时), 完成后重启网关并回验')); return; }
  const script = path.join(DIR, 'ops', 'guard.sh');
  if (!fs.existsSync(script)) die('ops/guard.sh not found');
  // renew.sh uses gen-server.sh --ensure (signs only when a re-sign is actually needed); --force re-signs unconditionally
  const renew = path.join(DIR, 'tls', 'renew.sh');
  console.log(C.dim('运行 tls/renew.sh (检查+按需重签+重启+回验)…'));
  try { execSync(`bash '${renew}'`, { stdio: 'inherit' }); ok('Certificate check done'); }
  catch (e) { die('renew failed (exit 2 = re-sign failure): ' + (e.status || e.message)); }
}
function cmdRecord(argv) {
  const a = argv[0];
  if (!['on', 'off'].includes((a || '').toLowerCase())) { console.log(t(`用法:
  agw record <on/off> [--server "user:pass@host:port"] [--max-length <num>] [实例名]
  record 落盘位置: log/requests-<inst>.jsonl (5MB 轮转)`)); return; }
  const inst = argv.find((x, i) => i > 0 && !x.startsWith('--') && argv[i - 1] !== '--server' && argv[i - 1] !== '--max-length') || 'default';
  const c = loadCfg(inst);
  c.record = c.record || {};
  c.record.enable = a.toLowerCase() === 'on';
  const gi = argv.indexOf('--server');
  if (gi >= 0) {
    const up = parseUserPass(argv[gi + 1]);
    let url = 'http://' + (up.user ? encodeURIComponent(up.user) + (up.pass ? ':' + encodeURIComponent(up.pass) + '@' : '@') : '') + up.host;
    if (up.port) url += ':' + up.port;
    c.record.server = url;
  }
  const mi = argv.indexOf('--max-length');
  if (mi >= 0) { const n = Number(argv[mi + 1]); if (!(n > 0)) die('--max-length needs a positive number'); c.record.maxChars = n; }
  saveCfg(inst, c);
  ok(`Request recording ${a.toLowerCase() === 'on' ? C.grn('on') : C.dim('off')}${c.record.server ? ' → ' + c.record.server : ''}`);
  hotRestart(inst);
}
function cmdCloudflared(argv) {
  if (!argv.length && canLoop()) return loopCf();
  const a = (argv[0] || '').toLowerCase();
  if (!['start', 'stop', 'restart', 'clear'].includes(a)) { console.log(t('用法: agw cloudflared <start|stop|restart|clear>')); return; }
  const get = () => api('GET', '/admin/api/tunnel');
  if (a === 'clear') return get().then(() => api('POST', '/admin/api/tunnel', { action: 'stop' })).then(() => ok('Tunnel stopped and state cleaned'));
  if (a === 'restart') return api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => new Promise(r => setTimeout(r, 800))).then(() => api('POST', '/admin/api/tunnel', { action: 'start' })).then(() => new Promise(r => setTimeout(r, 2500))).then(get).then(d => ok('Tunnel restarted: ' + (d.url || '(getting domain, later: agw cloudflared status)')));
  const act = a;
  return api('POST', '/admin/api/tunnel', { action: act }).then(() => {
    if (act === 'start') return new Promise(r => setTimeout(r, 2500)).then(get).then(d => ok('Tunnel started: ' + (d.url || '(getting domain, later: status)')));
    ok('Tunnel stopped');
  }).catch(e => die(e.message));
}

/* ---------- tunnel loop ---------- */
const HELP_CF = t(`隧道管理 loop 命令:
  log [silence|log|warn|error|debug]   日志尾部(可按级别过滤)
  grep <time|line|content|other> <值>  日志过滤
  kill                                 立即停止隧道
  start | stop                         启动/停止
  空行                                 刷新状态`);
function loopCf() {
  const get = () => api('GET', '/admin/api/tunnel');
  const opt = (a, ...fl) => { for (let i = 0; i < a.length; i++) if (fl.includes(a[i])) return a[i + 1]; return undefined; };
  const cfWhen = a => {
    const t = opt(a, '-t', '--time'), w = opt(a, '-w', '--wait');
    if (t === undefined && w === undefined) return 0;
    return parseWhen(w !== undefined ? w : t) || NaN;
  };
  const view = () => get().then(d => {
    console.log(`  Tunnel running=${d.running ? C.grn('on') : C.dim('off')}  url=${d.url || '-'}`);
    if (d.next) console.log('  Scheduled ' + d.next.action + ' @ ' + fmtWhen(d.next.at));
    (d.log || []).slice(-8).forEach(l => console.log('  ' + trunc(l, 160)));
  }).catch(e => console.log(C.yel('隧道状态读取失败: ' + e.message)));
  const grep = a => {
    const mode = (a[0] || '').toLowerCase(), val = a.slice(1).join(' ');
    return get().then(d => {
      let lines = (d.log || []).slice();
      if (mode === 'line') lines = lines.slice(-(Math.max(1, Number(val) || 50)));
      else if (mode === 'content') lines = val ? lines.filter(l => l.toLowerCase().includes(val.toLowerCase())) : lines;
      else if (mode === 'other') {
        let re; try { re = new RegExp(val || '.', 'i'); } catch (e) { return console.log(C.yel('正则无效: ' + e.message)); }
        lines = lines.filter(l => re.test(l));
      } else if (mode === 'time') {
        const win = parseWhen(val || '10m'), nowT = Date.now();
        const from = win > nowT ? nowT - (win - nowT) : win;
        lines = lines.filter(l => {
          const m = l.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
          if (!m) return false;
          const t = new Date(); t.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
          return t.getTime() >= from;
        });
      } else return console.log('Usage: grep <time|line|content|other> <value>');
      if (!lines.length) return console.log(C.dim('  无匹配日志'));
      lines.slice(-200).forEach(l => console.log('  ' + trunc(l, 180)));
    }).catch(e => console.log(C.yel('Log read failed: ' + e.message)));
  };
  const commands = {
    log: a => {
      const lv = (a[0] || 'log').toLowerCase();
      if (lv === 'silence') return console.log(C.dim('  (静默)'));
      return get().then(d => {
        let lines = (d.log || []).slice(-40);
        if (lv !== 'log') lines = lines.filter(l => new RegExp(lv, 'i').test(l));
        if (!lines.length) return console.log(C.dim('  无日志'));
        lines.forEach(l => console.log('  ' + trunc(l, 180)));
      }).catch(e => console.log(C.yel('Log read failed: ' + e.message)));
    },
    grep: grep,
    kill: () => api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => { ok('隧道已停止'); view(); }).catch(e => console.log(C.yel('停止失败: ' + e.message))),
    start: a => {
      const at = cfWhen(a);
      if (Number.isNaN(at)) return console.log(C.yel('时间格式: 30 / 10m / 2h / 22:30 / 2026-10-28 09:00'));
      if (at) return api('POST', '/admin/api/tunnel', { action: 'start', at }).then(d => { ok('Start scheduled: ' + fmtWhen(d.at)); view(); }).catch(e => console.log(C.yel('计划失败: ' + e.message)));
      return api('POST', '/admin/api/tunnel', { action: 'start' }).then(() => new Promise(r => setTimeout(r, 2500))).then(get).then(d => { ok('Tunnel started: ' + (d.url || '(getting domain)')); }).catch(e => console.log(C.yel('启动失败: ' + e.message)));
    },
    stop: a => {
      const at = cfWhen(a);
      if (Number.isNaN(at)) return console.log(C.yel('时间格式: 30 / 10m / 2h / 22:30 / 2026-10-28 09:00'));
      if (at) return api('POST', '/admin/api/tunnel', { action: 'stop', at }).then(d => { ok('Stop scheduled: ' + fmtWhen(d.at)); view(); }).catch(e => console.log(C.yel('计划失败: ' + e.message)));
      return api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => { ok('隧道已停止'); view(); }).catch(e => console.log(C.yel('停止失败: ' + e.message)));
    },
  };
  return startRepl({
    title: 'agw 隧道管理 loop',
    prompt: () => 'agw·cloudflared> ',
    help: HELP_CF,
    refresh: view,
    commands,
    unknown: parts => console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)')),
  });
}

/* ================================================================
 *  agw encrypt / decrypr / recrypt / export / inport
 * ================================================================ */
function eachCfgDo(nameArg, fn) {
  const targets = (nameArg === 'all') ? listInsts() : [nameArg];
  if (nameArg !== 'all' && !listInsts().includes(nameArg)) die(`Instance not found: ${nameArg}`);
  let done = 0;
  for (const t of targets) {
    const f = cfgPathOf(t);
    try { fn(f, t); done++; } catch (e) { console.error(C.red(`✗ ${t}: ${e.message}`)); }
  }
  if (!done) die('No instances were processed');
  ok(`${done}/${targets.length} instances processed`);
}
function cmdEncrypt(argv) {
  const [scope, pass] = argv;
  if (!scope || /help/.test(scope)) { console.log(t(`用法:
  agw encrypt <all|inst> [password]     口令缺省=用 .agwkey(推荐: agw 才能继续编辑; 自定义口令仅作归档)
  agw decrypr <all|inst> [password]     解密
  agw recrypt <all|inst> [new-password] 换口令重加密`)); return; }
  const p = pass || crypt.loadPass();
  if (!p) die('No passphrase: pass it or set AGW_CRYPT_PASS / .agwkey');
  eachCfgDo(scope, (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    if (crypt.isEncText(raw)) return console.log(C.dim(`  ${path.basename(f)} already encrypted, skipped`));
    fs.copyFileSync(f, f + '.agwbak');
    fs.writeFileSync(f, crypt.encryptText(raw, p));
    console.log(`  ${C.grn('✓')} ${path.basename(f)} encrypted`);
  });
}
function cmdDecrypt(argv) {
  const [scope, pass] = argv;
  if (!scope || /help/.test(scope)) return cmdEncrypt(['help']);
  const p = pass || crypt.loadPass();
  if (!p) die('无口令: 传参或设置 AGW_CRYPT_PASS / .agwkey');
  eachCfgDo(scope, (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    if (!crypt.isEncText(raw)) return console.log(C.dim(`  ${path.basename(f)} is already plaintext`));
    fs.copyFileSync(f, f + '.agwbak');
    let pt; try { pt = crypt.decryptText(raw, p); } catch (e) { throw new Error(`解密失败(口令错?) ${e.message}`); }
    fs.writeFileSync(f, pt);
    console.log(`  ${C.grn('✓')} ${path.basename(f)} decrypted`);
  });
}
function cmdRecrypt(argv) {
  const [scope, np] = argv;
  if (!scope) { console.log(t('用法: agw recrypt <all|inst> <new-password>')); return; }
  const oldP = crypt.loadPass();
  if (!oldP) die('Current passphrase unavailable (.agwkey/AGW_CRYPT_PASS)');
  const newP = np || die('A new passphrase is required');
  eachCfgDo(scope, (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    const pt = crypt.isEncText(raw) ? crypt.decryptText(raw, oldP) : raw;
    fs.copyFileSync(f, f + '.agwbak');
    fs.writeFileSync(f, crypt.encryptText(pt, newP));
    console.log(`  ${C.grn('✓')} ${path.basename(f)} re-encrypted with new passphrase`);
  });
}
function cmdExport(argv) {
  const scope = argv[0];
  const qri = argv.indexOf('--QRcode');
  const qr = qri >= 0 ? (argv[qri + 1] !== 'false') : false;
  if (!scope || /help/.test(scope)) { console.log(t(`用法:
  agw export <all|inst> [--QRcode true/false]
  ⚠ 导出为解密后的明文 JSON, 含全部 API Key, 输出后请立即转移到安全位置`)); return; }
  const targets = scope === 'all' ? listInsts() : [scope];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.join(HOME, 'ai-gateway-export-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(C.yel('⚠ 明文导出, 含全部密钥: ' + outDir));
  for (const t of targets) {
    const c = loadCfg(t);
    const f = path.join(outDir, `config.${t}.json`);
    fs.writeFileSync(f, JSON.stringify(c, null, 2));
    console.log(`  ${path.basename(f)}`);
    if (qr) {
      const txt = fs.readFileSync(f, 'utf8');
      if (txt.length > 2000) { console.log(C.dim(`  ${t}: ${txt.length} chars, QR split into chunks (scan in order)`)); }
      try {
        execSync(`qrencode -t ANSIUTF8 -o - '${f}' > '${path.join(outDir, t + '.qr.txt')}'`, { shell: '/bin/bash' });
        console.log(`  ${t}.qr.txt (scannable in terminal)`);
      } catch (e) { console.log(C.dim(`  ${t}: qrencode 失败 ${e.message}`)); }
    }
  }
  ok('Export done (dir mode 700)');
  fs.chmodSync(outDir, 0o700);
}
function cmdInport(argv) {
  const fp = argv[0], pass = argv[1];
  if (!fp || /help/.test(fp)) { console.log(t('用法: agw inport <file-path> [password]')); return; }
  const abs = path.resolve(fp);
  if (!fs.existsSync(abs)) die('File not found: ' + abs);
  let raw = fs.readFileSync(abs, 'utf8');
  if (crypt.isEncText(raw)) {
    const dp = pass || crypt.loadPass();
    if (!dp) die('Source file is encrypted: passphrase required (argument or .agwkey)');
    try { raw = crypt.decryptText(raw, dp); } catch (e) { die('Source decrypt failed (wrong passphrase?): ' + e.message); }
  }
  let c;
  try { c = JSON.parse(raw); } catch (e) { die('Invalid JSON: ' + e.message); }
  const name = (path.basename(abs).match(/^config\.(.+)\.json$/) || [])[1] || 'imported';
  const finalName = listInsts().includes(name) ? name + '-' + Date.now().toString(36) : name;
  if (!c.channels || !c.channels.length) console.log(C.yel('⚠ 该配置没有任何 channels'));
  const dest = cfgPathOf(finalName);
  fs.copyFileSync(abs, dest);
  if (pass) { fs.writeFileSync(dest, crypt.encryptText(fs.readFileSync(dest, 'utf8'), pass)); console.log('  Encrypted with the passphrase you entered'); }
  ok(`Imported as instance ${finalName}; takes effect on agw.sh restart`);
}

/* ================================================================
 *  agw lang / notice / stat
 * ================================================================ */
function cmdLang(argv) {
  const v = (argv[0] || '').toLowerCase();
  if (!v || v === 'help' || v === '--help') {
    console.log(t('用法: agw lang <语言代码> 例: agw lang en'));
    console.log(t('当前语言: %s 可用: %s').replace('%s', currentLang()).replace('%s', LANGS.join(' ')));
    return;
  }
  const norm = v === 'zh' ? 'zh-CN' : (v === 'zh-tw' || v === 'zh-hant') ? 'zh-TW' : v;
  if (!LANGS.includes(norm)) die(t('语言未提供: %s').replace('%s', v));
  if (norm === 'zh-CN') { try { fs.unlinkSync(LANG_FILE); } catch (_) {} ok(t('已切回默认语言 (zh-CN)')); return; }
  fs.writeFileSync(LANG_FILE, norm + '\n');
  const lname = (function(){ try { return JSON.parse(fs.readFileSync(path.join(DIR, 'lang', norm + '.json'), 'utf8'))['meta.lang_name'] || norm; } catch (_) { return norm; } })();
  ok(t('语言 %s = %s').replace('%s', norm).replace('%s', lname));
}
function cmdNotice(argv) {
  console.log(C.bold(t('■ 告警汇总')));
  let n = 0;
  for (const t of listInsts()) {
    const c = loadCfg(t);
    for (const ch of (c.channels || [])) {
      if (!ch.apiKey) { console.log(C.red(`  [${t}] 渠道 ${ch.name}: apiKey 为空`)); n++; }
      if (ch.balanceWarn) {
        // balance proxy lookup (only when configured)
        try {
          const gw = require('./gateway.js');
          gw.fetchBalanceCached(c, ch, r => {
            if (!r.ok) return;
            const val = parseFloat(r.balance);
            if (val < ch.balanceWarn) console.log(C.yel(`  [${t}] 渠道 ${ch.name}: 余额 ${val} ${r.unit || ''} 低于 warn ${ch.balanceWarn}`));
          });
        } catch (_) {}
      }
    }
    const exp = (c.apiKeys || []).filter(k => k.expiresAt && new Date(k.expiresAt) < new Date(Date.now() + 7 * 864e5));
    for (const k of exp) { console.log(C.yel(`  [${t}] card ${trunc(k.key, 10)}… expiring/expired: ${k.expiresAt}`)); n++; }
  }
  // certificate days remaining
  try {
    const cert = path.join(DIR, 'tls', 'ca.pem');
    const certFile = fs.existsSync(path.join(DIR, 'tls', 'cert.pem')) ? path.join(DIR, 'tls', 'cert.pem') : cert;
    const out = execSync(`openssl x509 -enddate -noout -in '${certFile}' 2>/dev/null`).toString();
    const end = new Date(out.match(/notAfter=(.*)/)[1]);
    const days = Math.floor((end - Date.now()) / 864e5);
    if (days < 7) { console.log(C.yel(`  证书剩余 ${days} 天 (${end.toISOString().slice(0, 10)})`)); n++; }
  } catch (_) {}
  setTimeout(() => { if (!n) console.log('  All OK'); }, 1500);
}
function cmdStat(argv) {
  const ri = argv.indexOf('--refresh');
  if (ri >= 0) {
    const val = Number(argv[ri + 1]);
    if (!(val >= 0)) return die('Usage: agw stat --refresh <minutes> [instance]   (0=off)');
    const inst = argv[ri + 2] && !argv[ri + 2].startsWith('-') ? argv[ri + 2] : 'default';
    return (async () => {
      const c = loadCfg(inst); c.statsFlushMin = val; saveCfg(inst, c);
      console.log(`  ${inst}: statsFlushMin = ${val} (${val > 0 ? 'flush every ' + val + ' min to data/stats-' + inst + '.json' : 'scheduled flush off'})`);
      const { execFile } = require('child_process');
      execFile('bash', [path.join(DIR, 'agw.sh'), 'restart'], { timeout: 60000 }, (err) => {
        if (err) console.log(C.yel('  ⚠ 重启失败(' + (err.message || '?') + '), 下次启动生效'));
        else console.log('  Applied after gateway restart');
      });
    })();
  }
  const scope = (argv[0] || 'all').toLowerCase();
  const instArg = argv.find(a => !a.startsWith('-') && !['all', 'daily', 'weekly', 'monthly', 'models', 'dist'].includes(a));
  if (scope === 'models' || scope === 'dist') {
    const inst = instArg || 'default';
    const sf = path.join(DATA_DIR, 'stats-' + inst + '.json');
    if (!fs.existsSync(sf)) return console.log(C.dim(`  ${sf} not found (run agw stat --refresh <minutes> ${inst} to enable saving)`));
    let j; try { j = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) { return die('Stats file parse failed: ' + e.message); }
    if (scope === 'models') {
      const rows = Object.entries(j.byModel || {}).sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens));
      if (!rows.length) return console.log('  No per-model data');
      const total = rows.reduce((t, [, v]) => t + v.inputTokens + v.outputTokens, 0) || 1;
      console.log(`  ${inst} by model (since ${j.since || j.savedAt}):`);
      for (const [m, v] of rows.slice(0, 15)) {
        const sum = v.inputTokens + v.outputTokens;
        const bar = '█'.repeat(Math.max(1, Math.round(sum / total * 24)));
        console.log(`    ${pad(m.slice(0, 28), 30)} ${pad(String(v.requests), 6)} req  ${fmtTok(sum).padStart(8)} tok  ${bar} ${(sum / total * 100).toFixed(1)}%`);
      }
      return;
    }
  // dist: aggregate the 6-way split across all days
    const D = { tools: 0, system: 0, history: 0, user: 0, reasoning: 0, text: 0, tool: 0 };
    for (const v of Object.values(j.daily || {})) { for (const k of Object.keys(D)) D[k] += (v.dist && v.dist[k]) || 0; }
    const tot = Object.values(D).reduce((a, b) => a + b, 0);
    if (!tot) return console.log('  No token distribution data');
    console.log(`  ${inst} token distribution (est., since ${j.since || j.savedAt}):`);
    const names = { tools: '工具定义', system: '系统提示', history: '对话历史', user: '用户输入', reasoning: '思考内容', text: '正文', tool: 'ToolCall' };
    for (const k of Object.keys(names)) {
      const bar = '█'.repeat(Math.max(1, Math.round(D[k] / tot * 24)));
      console.log(`    ${pad(names[k], 20)} ${fmtTok(D[k]).padStart(9)} tok  ${bar} ${(D[k] / tot * 100).toFixed(1)}%`);
    }
    return;
  }
  if (!['all', 'daily', 'weekly', 'monthly'].includes(scope)) { console.log(t('用法: agw stat <all|daily|weekly|monthly|models|dist> [实例名] / agw stat --refresh <分钟> [实例]')); return; }
  const inst = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'default';
  if (scope === 'all') {
    return api('GET', `/admin/api/stats?instance=${encodeURIComponent(inst)}`).then(d => {
      const s = d.stats || d;
      console.log(`  ${inst}: requests ${s.requests}  errors ${s.errors}  retries ${s.retries || 0}  since ${humanTime(s.startedAt)}`);
      for (const [cn, v] of Object.entries(s.byChannel || {})) console.log(`    ${pad(cn, 18)} ${v.requests} req${v.errors ? ' ' + C.red(v.errors + ' err') : ''}`);
    }).catch(e => die(e.message));
  }
  // daily/weekly/monthly: parse requests-<inst>.jsonl
  const f = path.join(DATA_DIR, 'log', `requests-${inst}.jsonl`);
  if (!fs.existsSync(f)) return console.log(C.dim(`  ${inst} 未开请求记录(record), 无历史数据可统计`));
  const now = Date.now();
  const span = { daily: 864e5, weekly: 7 * 864e5, monthly: 30 * 864e5 }[scope];
  const buckets = new Map();
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (const ln of lines) {
    let r; try { r = JSON.parse(ln); } catch (_) { continue; }
    if (!r.time) continue;
    const t = new Date(r.time).getTime(); if (now - t > span) continue;
    const key = scope === 'daily' ? r.time.slice(0, 10) : scope === 'weekly' ? r.time.slice(0, 10) : r.time.slice(0, 7);
    const b = buckets.get(key) || { req: 0, err: 0, tok: 0, dur: 0 };
    b.req++; if (r.status >= 400) b.err++;
    b.tok += (r.inputTokens || 0) + (r.outputTokens || 0);
    b.dur += r.duration || 0;
    buckets.set(key, b);
  }
  if (!buckets.size) return console.log('  No records in range');
  console.log(`  ${inst} ${scope} (from requests-*.jsonl):`);
  [...buckets.entries()].sort().forEach(([k, b]) => {
    console.log(`    ${k}  ${pad(b.req, 6)} req  err${pad(b.err, 4)}  ${fmtTok(b.tok)} tok  avg ${fmtDur(b.dur / b.req)}`);
  });
}

/* ================================================================
 *  agw web -- panel login link (/auth/<session-id>/<token>)
 *  session-id: regenerated on every gateway start; token: regenerated by every login command
 * ================================================================ */
function panelPort(cfg, isDefault) {
  const tls = !!(cfg.tls && cfg.tls.enable);
  if (isDefault === false && tls) {
    const main = readCfgSafe('default');
    return { tls: !!(main && main.tls && main.tls.enable), port: listenPort(main || cfg) };
  }
  const port = Number((cfg.listen || {}).port) || 16384;
  return { tls, port };
}
function readCfgSafe(name) {
  try {
    const f = cfgPathOf(name);
    if (!fs.existsSync(f)) return null;
    const raw = fs.readFileSync(f, 'utf8');
    if (crypt.isEncText(raw)) {
      const pass = crypt.loadPass();
      if (!pass) return null;
      return JSON.parse(crypt.decryptText(raw, pass));
    }
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
function listenPort(cfg) { return Number((cfg.listen || {}).port) || 16384; }
function webBases(cfg, inst) { // panel base addresses (no credentials)
  const isDefault = !inst || inst === 'default';
  const tlsInst = !!(cfg.tls && cfg.tls.enable);
// A TLS instance listens nowhere itself: its panel lives behind the main port's HTTPS + /<name>/ prefix
  let routeCfg = cfg, prefix = '';
  if (!isDefault && tlsInst) {
    const main = readCfgSafe('default');
    routeCfg = main || cfg;
    prefix = '/' + encodeURIComponent(inst);
    if (!(main && main.tls && main.tls.enable)) {
      console.log(C.yel('⚠ Instance ' + inst + ' has TLS on but the main instance does not: it is only reachable via main-port HTTPS and is currently unreachable'));
      console.log(C.dim('  Fix: enable TLS on default too (agw-tls setup), or disable TLS on this instance'));
    }
  } else if (!isDefault) {
    const main = readCfgSafe('default');
    if (main && listenPort(main) === listenPort(cfg)) {
      routeCfg = main;
      prefix = '/' + encodeURIComponent(inst);
    }
  }
  const { tls, port } = panelPort(routeCfg, isDefault);
  const scheme = tls ? 'https' : 'http';
  const bases = [`${scheme}://127.0.0.1:${port}${prefix}`];
  try {
    const priv = i => i && i.family === 'IPv4' && !i.internal
      && (/^10\./.test(i.address) || /^192\.168\./.test(i.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(i.address));
    const lan = Object.values(os.networkInterfaces()).flat().find(priv);
    if (lan) bases.push(`${scheme}://${lan.address}:${port}${prefix}`);
  } catch (_) {}
  return bases;
}
function openBrowser(url) {
if (process.env.AGW_NO_OPEN) return null; // scripted/test runs: do not open a browser
  const q = `'` + String(url).replace(/'/g, `'\\''`) + `'`;
  for (const c of ['termux-open', 'termux-open-url', 'xdg-open']) {
    try { execSync(`${c} ${q}`, { stdio: 'ignore' }); return c; } catch (_) {}
  }
  return null;
}
function gatewayRunning() {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA_DIR, '.run', 'main.pid'), 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}
function printLinks(label, urls) {
  console.log(t(label));
  urls.forEach(u => console.log('  ' + C.cyn(u)));
}
function webHelp() {
  console.log(t(`用法:
  agw web login [--inst <实例>] [--open|--no-open]
      生成新的随机登录 Token, 打印一次性登录链接; 浏览器行为默认读 config.panel.openBrowser
  agw web [--inst <实例>]
      查看当前 session-id、登录 Token 状态和面板地址
  agw web --expired [--inst <实例>]
      注销全部面板会话, 并让旧登录链接全部失效`));
}
function panelTokenLabel(st, now) {
  const kind = panelAuth.tokenState(st, now);
  if (kind === 'none') return C.yel('not generated') + C.dim(' (run agw web login to generate)');
  if (kind === 'used') return C.dim('used (one-time link)');
  if (kind === 'expired') return C.yel('expired') + C.dim(' (re-run agw web login)');
  return C.grn('valid') + C.dim(' until ' + fmtWhen(st.tokenExp) + ' (15 min; first open invalidates it)');
}
async function cmdWeb(argv) {
  const has = f => argv.includes(f);
  if (has('help') || has('--help')) return webHelp();
  const inst = (() => { const i = argv.indexOf('--inst'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'default'; })();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(inst)) die('Instance name: letters/digits/hyphen/underscore only, max 32 chars');
  const cfg = loadCfg(inst);

  if (!argv.length || (argv.length === 2 && argv[0] === '--inst')) { // status view
    const st = panelAuth.read(cfg, inst);
    console.log(t('实例: ') + inst + '  ' + (gatewayRunning() ? C.grn('Gateway running') : C.yel('No gateway process detected')));
    console.log(t('会话ID: ') + (st ? C.grn(maskKey(st.sid)) : C.yel('not generated') + C.dim(' (auto-generated on gateway start)')));
    console.log(t('登录Token: ') + panelTokenLabel(st, Date.now()));
    console.log(t('自动打开浏览器: ') + ((cfg.panel && cfg.panel.openBrowser !== false) ? 'on' : 'off') + C.dim('  (config.panel.openBrowser)'));
    console.log(t('面板地址(完整登录链接用 agw web login 生成):'));
    webBases(cfg, inst).forEach(b => console.log('  ' + C.cyn(b + '/auth')));
    return;
  }

  if (has('--expired')) {
    panelAuth.revoke(cfg, inst);
    ok('All panel sessions logged out; old login links and browser sessions are invalid');
    return;
  }
  if (argv.length && !has('login')) return webHelp();

  // login: session-id is created at gateway start; this command creates a fresh one-time token.
  const before = panelAuth.read(cfg, inst);
  const live = gatewayRunning();
  const r = panelAuth.issue(cfg, inst);
  const urls = webBases(cfg, inst).map(b => `${b}/auth/${r.sid}/${r.token}`);
  printLinks('One-time login link (valid 15 min, first open invalidates it; do not share):', urls);
  if (!before) console.log(C.yel('⚠ No session-id read; make sure the instance is running, otherwise re-run agw web login after start'));
  else if (!live) console.log(C.dim('Note: no .run/main.pid detected (ignore for manual/Docker starts)'));
  console.log(C.dim('The token is regenerated on every agw web login; old links die immediately'));
  console.log(C.dim('session-id rotates on every gateway restart; re-run agw web login after a restart'));

  const shouldOpen = has('--open') ? true : has('--no-open') ? false : !(cfg.panel && cfg.panel.openBrowser === false);
  if (!shouldOpen) {
    console.log(C.dim('Auto-open skipped per config (--open to force)'));
    return;
  }
  const opened = openBrowser(urls[0]);
  console.log(opened ? C.dim(`已尝试用 ${opened} 打开浏览器`) : C.dim('No browser-open command available; copy the link manually'));
}

/* ==================== per-domain loop -- agw inst/chan/router/stat/admin ==================== */
const LOOP_HINT = 'blank = refresh | help = commands | exit = quit';
function canLoop() { return !process.env.AGW_NO_LOOP && !!(process.stdin.isTTY && process.stdout.isTTY); } // cmdXxx called inside a loop does not nest another loop
function tailLog(name, n) {
  const k = Math.max(1, Number(n) || 30);
  return api('GET', `/admin/api/logs/${encodeURIComponent(name)}?lines=${k}`)
    .then(d => {
      const txt = typeof d === 'string' ? d : ((d && (d.logs || d.text)) || '');
      console.log(String(txt || '(empty)').split('\n').slice(-k).join('\n'));
    }).catch(e => console.log(C.yel('Log read failed: ' + e.message)));
}
function splitArgs(raw) { // split on whitespace but respect "..." / '...' (values like url=..., key=... may contain commas/spaces)
  const out = []; let cur = '', q = null;
  for (const ch of String(raw || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
/* Generic REPL: empty line = refresh; help/exit; everything else goes to the domain's commands table */
function startRepl(o) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  let closing = false;
  LOOPING = true;
  process.env.AGW_NO_LOOP = '1'; // 防止 loop 内部委派 cmdChan/cmdRouter 等再次开 loop
  const P = () => { if (!closing) { try { rl.setPrompt(C.cyn(typeof o.prompt === 'function' ? o.prompt() : o.prompt)); rl.prompt(); } catch (_) {} } };
  const done = r => { if (r && r.then) r.then(P).catch(e => { console.log(C.red('✗ ' + e.message)); P(); }); else P(); };
  const run = raw => {
if (o.before) { const h = o.before(raw); if (h) return h; } // sub-loops (edit/scope/models) take input first
    const parts = splitArgs(raw);
    if (!parts.length) return o.refresh && o.refresh();
    const c = parts[0].toLowerCase();
    if (['exit', 'quit', 'q', ':q'].includes(c)) { rl.close(); return; }
    if (c === 'help' || c === '?') { console.log(o.help); return; }
    const fn = o.commands[c];
    if (fn) return fn(parts.slice(1), parts);
    if (o.unknown) return o.unknown(parts);
    console.log(C.yel('未知命令: ' + c + '  (help 查看)'));
  };
  console.log(C.dim(o.title + ' — ' + LOOP_HINT));
  try { done(o.refresh && o.refresh()); } catch (e) { console.log(C.red('✗ ' + e.message)); P(); }
  rl.on('line', l => { try { done(run(l)); } catch (e) { console.log(C.red('✗ ' + e.message)); P(); } });
  rl.on('SIGINT', () => rl.close());
  rl.on('close', () => {
    closing = true; LOOPING = false;
    if (o.onClose) { try { o.onClose(); } catch (_) {} }
    console.log(C.dim('bye'));
setTimeout(() => process.exit(0), 300); // give in-flight output a moment to flush
  });
}

/* ---------- Instance management ---------- */
const HELP_INST = t(`实例管理 loop 命令:
  status [all|requests|error|debug|usage]   状态 / 日志 / 用量
  grep <time|line|content|other> <值>       日志过滤
       time 10m        最近 10 分钟
       line 100        最后 100 行
       content timeout 包含文本
       other <正则>     正则匹配
  dist [--export -p <路径>] [--export-type -t image|table|html]
       上下文 Token 六分类分布; 导出缺省 ./dist-<实例>-<时间>.<svg|txt|html>
  edit                                     进入编辑 loop
       name=<实例名>   port=<端口|r=随机>   tls=<on/off>
       apikey=<key|0=随机|none>   fetch=<分钟|0=关>
       filter=<on/off>
  空行刷新当前实例状态`);
function distData(inst) {
  const sf = path.join(DATA_DIR, 'stats-' + inst + '.json');
  if (!fs.existsSync(sf)) return null;
  let j; try { j = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (_) { return null; }
  const D = { tools: 0, system: 0, history: 0, user: 0, reasoning: 0, text: 0, tool: 0 };
  for (const v of Object.values(j.daily || {})) for (const k of Object.keys(D)) D[k] += (v.dist && v.dist[k]) || 0;
  const tot = Object.values(D).reduce((a, b) => a + b, 0);
  return { since: j.since || j.savedAt, D, tot };
}
const DIST_NAMES = { tools: '工具定义', system: '系统提示', history: '对话历史', user: '用户输入', reasoning: '思考内容', text: '正文', tool: 'ToolCall' };
function distExport(inst, opt) {
  const d = distData(inst);
  if (!d || !d.tot) return console.log(C.dim('  无 Token 分布数据(先 stat --refresh <分钟> 开启落盘)'));
  const type = (opt.type || 'table').toLowerCase();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const def = path.join(process.cwd(), 'dist-' + inst + '-' + stamp + (type === 'image' ? '.svg' : type === 'html' ? '.html' : '.txt'));
  const out = path.resolve(opt.path || def);
  const rows = Object.keys(DIST_NAMES).map(k => ({ k, name: DIST_NAMES[k], v: d.D[k], pct: d.tot ? d.D[k] / d.tot * 100 : 0 }));
  let body;
  if (type === 'html') {
    body = '<!doctype html><meta charset="utf-8"><title>Token 分布 ' + inst + '</title><style>body{font:14px system-ui;background:#111;color:#ddd;padding:24px}table{border-collapse:collapse}td,th{padding:6px 14px;border-bottom:1px solid #333;text-align:left}.bar{background:#2b6cb0;height:10px}</style>'
      + '<h2>' + inst + ' Token 分布</h2><p>since ' + (d.since || '-') + ' · 合计 ' + d.tot + ' tok</p><table><tr><th>分类</th><th>Token</th><th>占比</th><th></th></tr>'
      + rows.map(r => '<tr><td>' + r.name + '</td><td>' + r.v + '</td><td>' + r.pct.toFixed(1) + '%</td><td><div class="bar" style="width:' + Math.max(1, Math.round(r.pct * 4)) + 'px"></div></td></tr>').join('')
      + '</table>';
  } else if (type === 'image') {
    const W = 640, rowH = 34, H = 60 + rows.length * rowH;
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" font-family="sans-serif">'
      + '<rect width="100%" height="100%" fill="#111"/><text x="24" y="34" fill="#eee" font-size="18">' + inst + ' Token 分布 (since ' + (d.since || '-') + ')</text>'
      + rows.map((r, i) => {
        const y = 60 + i * rowH, w = Math.max(1, Math.round(r.pct / 100 * 380));
        return '<text x="24" y="' + (y + 14) + '" fill="#bbb" font-size="13">' + r.name + '</text>'
          + '<rect x="120" y="' + y + '" width="' + w + '" height="18" fill="#2b6cb0"/>'
          + '<text x="' + (128 + w) + '" y="' + (y + 14) + '" fill="#ddd" font-size="12">' + r.v + ' tok ' + r.pct.toFixed(1) + '%</text>';
      }).join('') + '</svg>';
  } else {
    body = [inst + ' Token 分布 (since ' + (d.since || '-') + ', 合计 ' + d.tot + ' tok)', ...rows.map(r => pad(r.name, 10) + '\t' + String(r.v).padStart(10) + '\t' + r.pct.toFixed(1) + '%')].join('\n');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  fs.chmodSync(out, 0o600);
  ok('Exported ' + type + ': ' + out);
}
function instGrep(cur, a) {
  const mode = (a[0] || '').toLowerCase();
  const val = a.slice(1).join(' ');
  if (!mode) return console.log('Usage: grep <time|line|content|other> <value>');
  return api('GET', `/admin/api/logs/${encodeURIComponent(cur)}?lines=400`).then(d => {
    const txt = typeof d === 'string' ? d : ((d && (d.logs || d.text)) || '');
    let lines = String(txt).split('\n').filter(Boolean);
    if (mode === 'line') {
      const n = Math.max(1, Number(val) || 50);
      lines = lines.slice(-n);
    } else if (mode === 'content') {
      if (!val) return console.log('Usage: grep content <text>');
      lines = lines.filter(l => l.toLowerCase().includes(val.toLowerCase()));
    } else if (mode === 'other') {
      if (!val) return console.log('Usage: grep other <regex>');
      let re; try { re = new RegExp(val, 'i'); } catch (e) { return console.log(C.yel('正则无效: ' + e.message)); }
      lines = lines.filter(l => re.test(l));
    } else if (mode === 'time') {
      const win = parseWhen(val || '10m');
      if (!win) return console.log('Usage: grep time <10m|2h|HH:MM>');
      const nowT = Date.now();
const from = win > nowT ? nowT - (win - nowT) : win; // relative window -> now minus duration; absolute time -> compare directly
      lines = lines.filter(l => {
        const m = l.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
        if (!m) return false;
        const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
        return d.getTime() >= from;
      });
    } else return console.log('Usage: grep <time|line|content|other> <value>');
    if (!lines.length) return console.log(C.dim('  无匹配日志'));
    lines.slice(-200).forEach(l => console.log('  ' + trunc(l, 200)));
  }).catch(e => console.log(C.yel('Log read failed: ' + e.message)));
}
function loopInst(startName) {
  let cur = startName || 'default', mode = null;
  const show = () => cmdInst([cur, '--status', 'all']);
  const editView = () => {
    const c = loadCfg(cur);
    const port = (c.listen || {}).port || 16384;
    const ms = c.modelSync || {};
    const fetchMin = ms.enable === false ? 0 : (ms.intervalMin || Math.round((ms.intervalHours || 24) * 60));
    console.log(C.bold('■ 编辑实例 ' + cur) + C.dim('  (key=value 逐项生效, exit 返回)'));
    console.log(`  name=${cur}  port=${port}  tls=${(c.tls && c.tls.enable) ? 'on' : 'off'}  apikey=${c.gatewayKey ? maskKey(c.gatewayKey) : C.dim('(empty)')}`);
    console.log(`  fetch=${fetchMin ? fetchMin + 'min' : 'off'}  filter=${(c.redact && c.redact.enable) ? 'on' : 'off'}`);
  };
  const editPost = body => api('POST', `/admin/api/config/${encodeURIComponent(cur)}`, body);
  const applyEdit = line => {
    const eq = line.indexOf('=');
    if (eq < 0) return console.log(C.yel('格式: key=value (name/port/tls/apikey/fetch/filter)'));
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
    if (k === 'name') {
      if (!v) return console.log(C.yel('name 不能为空'));
      if (cur === 'default') return console.log(C.yel('default 实例不能改名'));
      const old = cur;
      return api('POST', `/admin/api/instance-rename/${encodeURIComponent(old)}`, { newName: v })
        .then(d => { cur = (d && d.name) || v; ok('Instance renamed: ' + cur); editView(); })
        .catch(e => console.log(C.yel('改名失败: ' + e.message)));
    }
    if (k === 'port') {
      const port = /^r(andom)?$/i.test(v) ? 20000 + Math.floor(Math.random() * 20000) : Number(v);
      if (!(port >= 1024 && port <= 65535)) return console.log(C.yel('port: 1024-65535 或 r=随机'));
      return editPost({ port }).then(() => { ok('Port changed to ' + port); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'tls') {
      const c = loadCfg(cur), on = !/^(off|0|no|false)$/i.test(v);
      const tls = Object.assign({}, c.tls || {}, { enable: on });
      delete tls.port;
      return editPost({ tls }).then(() => { ok('TLS ' + (on ? 'enabled' : 'disabled')); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'apikey') {
      const key = /^0$/.test(v) ? crypto.randomBytes(24).toString('base64url') : /^(none|clear|-|空)$/i.test(v) ? '' : v;
      if (!key && v && !/^(none|clear|-|空)$/i.test(v)) return console.log(C.yel('apikey: 填 key / 0=随机 / none=清除'));
      return editPost({ gatewayKey: key }).then(() => { ok('Gateway-Key ' + (key ? 'set' : 'cleared')); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'fetch') {
      const n = Math.max(0, Math.round(Number(v) || 0));
      const body = { modelSync: { enable: n > 0, intervalMin: n, intervalHours: Math.max(1, Math.round(n / 60) || 24) } };
      return editPost(body).then(() => { ok('Model sync ' + (n ? n + ' min' : 'off')); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'filter' || k === 'fliter') {
      return editPost({ redact: { enable: !/^(off|0|no|false)$/i.test(v) } }).then(() => { ok('Privacy filter updated'); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    console.log(C.yel('未知字段: ' + k));
  };
  const before = raw => {
    if (!mode) return;
    const line = raw.trim();
    if (/^(exit|done|q|:q|back)$/i.test(line)) { mode = null; console.log(C.dim('已返回实例 loop')); show(); return true; }
    if (!line) { editView(); return true; }
    return applyEdit(line) || true;
  };
  const commands = {
    status: a => cmdInst([cur, '--status', (a[0] || 'all').toLowerCase()]),
    grep: a => instGrep(cur, a),
    dist: a => {
      const pi = a.findIndex(x => x === '-p' || x === '--output' || x === '--export-path');
      const ti = a.findIndex(x => x === '-t' || x === '--export-type');
      const outPath = pi >= 0 ? a[pi + 1] : undefined;
      const type = ti >= 0 ? a[ti + 1] : (outPath ? (/\.svg$/i.test(outPath) ? 'image' : /\.html?$/i.test(outPath) ? 'html' : 'table') : 'table');
      const d = distData(cur);
      if (d && d.tot) {
        console.log(`  ${cur} token distribution (since ${d.since || '-'}, total ${fmtTok(d.tot)} tok):`);
        for (const k of Object.keys(DIST_NAMES)) {
          const pct = d.D[k] / d.tot * 100;
          console.log(`    ${pad(DIST_NAMES[k], 20)} ${fmtTok(d.D[k]).padStart(9)} tok  ${'█'.repeat(Math.max(1, Math.round(pct / 4)))} ${pct.toFixed(1)}%`);
        }
      } else console.log(C.dim('  无 Token 分布数据(先 stat --refresh <分钟> 开启落盘)'));
      if (pi >= 0 || a.includes('--export')) return distExport(cur, { path: outPath, type });
    },
    edit: () => { mode = { type: 'edit' }; editView(); },
  };
  return startRepl({
    title: 'agw 实例管理 loop',
    prompt: () => mode ? 'agw·inst ' + cur + ' [edit]> ' : 'agw·inst ' + cur + '> ',
    help: HELP_INST,
    refresh: show,
    commands,
    before: before,
    unknown: parts => {
      if (parts[0].startsWith('-')) return console.log(C.yel('未知参数: ' + parts[0] + '  (help 查看)'));
      console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)'));
    },
  });
}


const HELP_CHAN = t(`渠道管理 loop 命令:
  fetch <渠道|all>              拉取上游模型列表
  edit <渠道>                   进入编辑 loop
       name=<渠道名>  url=<BaseURL>  sdk=<0=openai/1=claude/2=google>
       key=<API-Key>  path=<上游固定路径|none>  balance=<URL>  balance-key=<JSON-Key>
       delay=<毫秒/2s>  transcreet=<on/off/res-only/inherit>
  default <渠道>                设为默认渠道(其余默认自动取消)
  lock <渠道> [-t 时长/时间] [-w 时长/时间] [--cancel]   锁定(路由跳过)
  unlock <渠道> [-t 时长/时间] [-w 时长/时间] [--cancel] 解锁/定时解锁
  delete <渠道>                 删除渠道(输入 y 二次确认)
  models <渠道>                 模型清单 loop(add <模型> / delete <模型|*> / list)
  scope <渠道> "请求模型=真实模型, …"   一次写入映射
  scope <渠道>                  映射/白名单 loop(models= / name= / override= / apply)
  空行                          刷新渠道列表`);

/* Channel-lock check (same semantics as router.js channelLocked; used for listings/hints) */
function chanLockInfo(ch, now) {
  const t = now || Date.now();
  const at = Number(ch && ch.lockAt) || 0, until = Number(ch && ch.lockUntil) || 0;
  const scheduled = at > t;
  const expired = until && until <= t;
  return { locked: !!(at || until) && !scheduled && !expired, scheduled, at, until };
}
function fmtWhen(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms)), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function parseWhen(v) { // "30" = seconds / 30s 10m 2h 1h30m / 22:30 / 10-28 09:00 / 2026-10-28 09:00
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  const now = Date.now();
  if (/^\d+(\.\d+)?$/.test(s)) return now + Math.round(Number(s) * 1000);
  let ms = 0, hit = false;
  s.replace(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi, (m, n, u) => { hit = true; ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[u.toLowerCase()]; return m; });
  if (hit && !s.replace(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi, '').trim()) return now + Math.round(ms);
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) { const d = new Date(); d.setHours(Number(hm[1]), Number(hm[2]), 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime(); }
  const md = s.match(/^(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (md) {
    const d = new Date(); d.setMonth(Number(md[1]) - 1, Number(md[2]));
    if (md[3] != null) d.setHours(Number(md[3]), Number(md[4]), 0, 0); else d.setHours(23, 59, 59, 0);
    if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(23, 59, 59, 0);
  return d.getTime();
}
function loopChan(startName) {
  let cur = startName, mode = null; // null | {type:'edit'|'scope'|'models', name, ...}
  const show = () => cmdChan([cur]);
  const chOf = name => (loadCfg(cur).channels || []).find(x => x.name === name);
  const post = ch => api('POST', `/admin/api/channel/${encodeURIComponent(cur)}`, ch)
    .then(d => { if (d && d.hotReload === false) console.log(C.yel('已保存但热重载失败: ' + (d.warn || ''))); return d; });
const pv = (a, rest) => { // <channel> + rest -> cmdChan --provider
    if (!a[0]) return console.log(C.yel('缺少渠道名'));
    return cmdChan([cur, '--provider', a[0]].concat(rest));
  };
  /* ---- edit sub-loop ---- */
  const editView = () => {
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道不存在, 已退出编辑')); }
    const lk = chanLockInfo(ch);
    console.log(C.bold('■ 编辑渠道 ' + ch.name) + C.dim('  (key=value 逐项生效, exit 返回)'));
    console.log(`  name=${ch.name}  url=${ch.baseUrl}  path=${ch.path || 'auto'}  sdk=${ch.type}`);
    console.log(`  key=${ch.apiKey ? maskKey(ch.apiKey) : C.dim('(empty)')}  default=${ch.default ? 'on' : 'off'}  delay=${ch.delayMs || 0}ms  transcreet=${ch.transcreet || 'inherit'}`);
    console.log(`  balance=${ch.balanceUrl || '-'}  balance-key=${ch.balancePath || '-'}` + (lk.locked ? C.red('  [已锁定]') : lk.scheduled ? C.yel('  [待锁定 ' + fmtWhen(lk.at) + ']') : ''));
  };
  const applyEdit = line => {
    const eq = line.indexOf('=');
    if (eq < 0) return console.log(C.yel('格式: key=value (name/url/path/sdk/key/balance/balance-key/delay/transcreet)'));
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道已不存在, 退出编辑')); }
    const next = Object.assign({}, ch);
    const none = /^(none|clear|-|空)$/i.test(v);
    if (k === 'name') {
      if (!v || none) return console.log(C.yel('name 不能为空'));
      if (v === ch.name) return console.log(C.dim('渠道名未变'));
      if (chOf(v)) return console.log(C.yel('渠道名已被占用: ' + v));
      return post(Object.assign(next, { name: v, oldName: ch.name }))
        .then(() => { mode.name = v; ok('Channel renamed: ' + v); editView(); })
        .catch(e => console.log(C.yel('改名失败: ' + e.message)));
    }
    if (k === 'url') { if (!/^https?:\/\//i.test(v)) return console.log(C.yel('url 需要 http(s):// 开头')); next.baseUrl = v.replace(/\/+$/, ''); }
    else if (k === 'path') {
      if (!none && /^https?:\/\//i.test(v)) return console.log(C.yel('path 需要路径, 不能是完整 URL'));
      next.path = none ? '' : (v.charAt(0) === '/' ? v : '/' + v);
    }
    else if (k === 'sdk') {
      const t = { '0': 'openai', '1': 'claude', '2': 'gemini', openai: 'openai', claude: 'claude', gemini: 'gemini', google: 'gemini' }[v.toLowerCase()];
      if (!t) return console.log(C.yel('sdk: 0=openai / 1=claude / 2=google(gemini)'));
      next.type = t;
    }
    else if (k === 'key') next.apiKey = none ? '' : v;
    else if (k === 'balance') next.balanceUrl = none ? null : v;
    else if (k === 'balance-key') next.balancePath = none ? null : v;
    else if (k === 'delay') {
      const ms = /^\d+(\.\d+)?$/.test(v) ? Number(v) : /^\d+(\.\d+)?s$/i.test(v) ? Number(v.slice(0, -1)) * 1000 : /^\d+(\.\d+)?ms$/i.test(v) ? Number(v.slice(0, -2)) : NaN;
      if (!(ms >= 0)) return console.log(C.yel('delay 需要毫秒数: delay=200 / delay=2s'));
      next.delayMs = Math.min(120000, Math.round(ms));
    }
    else if (k === 'transcreet') {
      const x = v.toLowerCase();
      if (!['on', 'off', 'res-only', 'inherit', 'none'].includes(x)) return console.log(C.yel('transcreet: on / off / res-only / inherit'));
      next.transcreet = (x === 'inherit' || x === 'none') ? '' : x;
    }
    else return console.log(C.yel('未知字段: ' + k));
    return post(next).then(() => { ok(k + ' applied'); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- scope sub-loop ---- */
  const scopeView = () => {
    console.log(C.bold('■ 模型映射/白名单 ' + mode.name) + C.dim('  (字段逐项设置, apply 生效, exit 返回)'));
    console.log(`  models=${mode.models || C.dim('(unset)')}  name=${mode.real || C.dim('(unset)')}  override=${mode.override}`);
    console.log(C.dim('  models=<请求模型[*], …>  name=<真实模型>  override=true|false  apply'));
  };
  const applyScope = () => {
    if (!mode.models) return console.log(C.yel('先设 models=<请求模型>'));
    if (mode.override && !mode.real) return console.log(C.yel('override=true 需要 name=<真实模型>'));
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道已不存在, 退出编辑')); }
    const next = Object.assign({}, ch);
    const map = Object.assign({}, ch.modelMap || {});
    const pats = mode.models.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    if (!mode.override) {
      const ms = Array.isArray(ch.models) ? ch.models.slice() : [];
      for (const p of pats) { delete map[p]; if (!ms.includes(p)) ms.push(p); }
      next.models = ms;
    } else for (const p of pats) map[p] = mode.real;
    next.modelMap = Object.keys(map).length ? map : null;
    return post(next).then(() => { ok('Mapping saved'); mode = null; show(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- models sub-loop ---- */
  const modelsView = () => {
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道不存在, 已退出')); }
    const ms = ch.models || [];
    console.log(C.bold('■ 模型清单 ' + ch.name) + `  (${ms.length})` + C.dim('  add <模型> / delete <模型|*> / list / exit'));
    ms.slice(0, 60).forEach(m => console.log('  ' + m));
    if (ms.length > 60) console.log(C.dim(`  … ${ms.length} in total`));
  };
  const modelsSave = (ms, label) => {
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道不存在, 已退出')); }
    return post(Object.assign({}, ch, { models: ms })).then(() => { ok(label); modelsView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- lock / unlock ---- */
  const lockView = ch => {
    const lk = chanLockInfo(ch);
    if (lk.locked) console.log(C.red('  locked') + (lk.until ? ' until ' + fmtWhen(lk.until) : ' (manual unlock)'));
    else if (lk.scheduled) console.log(C.yel('  lock at ') + fmtWhen(lk.at) + (lk.until ? ' until ' + fmtWhen(lk.until) : ''));
    else console.log(C.dim('  未锁定'));
  };
  const setLock = (a, want) => {
    const name = a[0];
    if (!name) return console.log('Usage: ' + (want ? 'lock' : 'unlock') + ' <channel> [-t duration/time] [-w duration/time] [--cancel]');
    const ch = chOf(name);
    if (!ch) return console.log(C.yel('渠道不存在: ' + name));
    const getV = (...fl) => { for (let i = 0; i < a.length; i++) if (fl.includes(a[i])) return a[i + 1]; return undefined; };
    const now = Date.now(), next = Object.assign({}, ch);
    const tRaw = getV('-t', '--time'), wRaw = getV('-w', '--wait');
    if (a.includes('--cancel')) {
      if (want) {
        if (!(Number(ch.lockAt) > now)) return console.log(C.yel('没有待生效的锁定'));
        delete next.lockAt; delete next.lockUntil;
      } else {
        if (!(Number(ch.lockUntil) > now)) return console.log(C.yel('没有待生效的解锁'));
        delete next.lockUntil;
      }
      return post(next).then(() => { ok('Cancelled'); lockView(chOf(name)); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    const tMs = tRaw === undefined ? 0 : parseWhen(tRaw);
    if (tRaw !== undefined && !tMs) return console.log(C.yel('时间格式: 30(秒) / 10m / 2h / 22:30 / 10-28 09:00 / 2026-10-28 09:00'));
    const wMs = wRaw === undefined ? 0 : parseWhen(wRaw);
    if (wRaw !== undefined && !wMs) return console.log(C.yel('时间格式: 30(秒) / 10m / 2h / 22:30 / 10-28 09:00 / 2026-10-28 09:00'));
    if (want) {
      const start = wMs || now;
      const end = tMs || 0;
      if (end && end <= start) return console.log(C.yel('锁定结束时间必须晚于开始时间'));
      next.lockAt = start;
      if (end) next.lockUntil = end; else delete next.lockUntil;
    } else {
      const until = wMs || tMs || 0;
      if (!until) { delete next.lockAt; delete next.lockUntil; }
      else {
        if (until <= now) return console.log(C.yel('解锁时间必须晚于当前时间'));
if (!(Number(ch.lockAt) > now)) next.lockAt = now; // lock immediately if unlocked; auto-unlocks at the deadline
        next.lockUntil = until;
      }
    }
    return post(next).then(() => { ok(want ? 'Lock applied' : 'Unlock scheduled'); lockView(chOf(name)); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- sub-loop input dispatch ---- */
  const before = raw => {
    if (!mode) return;
    const line = raw.trim();
    if (/^(exit|done|q|:q|back)$/i.test(line)) { mode = null; console.log(C.dim('已返回渠道 loop')); show(); return true; }
    if (mode.type === 'del') {
      if (!/^y(es)?$/i.test(line)) { mode = null; console.log(C.dim('已取消')); return true; }
      const name = mode.name; mode = null;
      return Promise.resolve(cmdChan([cur, '--provider', name, '--remove'])).then(() => show()) || true;
    }
    if (mode.type === 'edit') { if (!line) { editView(); return true; } return applyEdit(line) || true; }
    if (mode.type === 'scope') {
      if (!line) { scopeView(); return true; }
      if (/^(apply|save)$/i.test(line)) return applyScope() || true;
      const eq = line.indexOf('=');
      if (eq < 0) { console.log(C.yel('scope 编辑: models=… / name=… / override=true|false / apply / exit')); return true; }
      const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
      if (k === 'models') mode.models = v;
      else if (k === 'name') mode.real = v;
      else if (k === 'override') mode.override = !/^(false|0|off|no)$/i.test(v);
      else console.log(C.yel('未知字段: ' + k));
      scopeView(); return true;
    }
  }
  const commands = {
    lock: a => setLock(a, true),
    unlock: a => setLock(a, false),
    models: a => {
      if (!a[0]) return console.log('Usage: models <channel>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      mode = { type: 'models', name: ch.name };
      modelsView();
    },
    scope: a => {
      if (a.length > 1) return pv(a, ['--scope', a.slice(1).join(' ')]);
      if (!a[0]) return console.log('Usage: scope <channel> "a=b" | scope <channel>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      mode = { type: 'scope', name: ch.name, models: '', real: '', override: true };
      scopeView();
    },
    fetch: a => {
      if (!a[0]) return console.log('Usage: fetch <channel|all>');
      if (a[0] !== 'all') return cmdFetch(['chan', a[0], cur]);
      const chs = loadCfg(cur).channels || [];
      if (!chs.length) return console.log(C.dim('  (无渠道)'));
      return chs.reduce((p, ch) => p.then(() => Promise.resolve(cmdFetch(['chan', ch.name, cur])).catch(e => console.log(C.yel(ch.name + ': ' + e.message)))), Promise.resolve());
    },
  };
  return startRepl({
    title: 'agw 渠道管理 loop (' + cur + ')',
    prompt: () => mode ? 'agw·chan ' + cur + ' [' + mode.type + ' ' + mode.name + ']> ' : 'agw·chan ' + cur + '> ',
    help: HELP_CHAN,
    refresh: show,
    commands,
    before: before,
    unknown: parts => {
      if (parts[0].startsWith('-')) return console.log(C.yel('未知参数: ' + parts[0] + '  (help 查看 -- 子命令)'));
      console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)'));
    },
  });
}

/* ---------- Admin system ---------- */
const HELP_ADMIN = t(`管理体系 loop 命令:
  login                         生成新的一次性面板登录链接
  expire [--time -t <时长/时间>] [--wait -w <时长/时间>] [--device -d <id|all>]
                                注销面板会话(当前仅立即执行)
  profile change [--avatar <URL/路径>] [--name <名>] [--profile <内容>] [--other <内容>]
                                管理端资料
  logout [--device -d <id|all>] 退出面板登录
  空行                          显示当前状态`);
function loopAdmin(startName) {
  let cur = startName || 'default';
  const show = () => {
    const c = loadCfg(cur), pf = c.adminProfile || {}, ps = panelAuth.read(c, cur);
    console.log(C.bold(`■ 管理体系 (${cur})`));
    console.log('  Panel session ' + (ps ? C.grn(maskKey(ps.sid)) : C.yel('not generated')) + '  登录令牌 ' + panelTokenLabel(ps, Date.now()));
    console.log('  Entry ' + webBases(c, cur).map(b => b + '/auth').join('  '));
    console.log('  Profile ' + (pf.name || C.dim('-')) + '  avatar=' + (pf.avatar || C.dim('-')) + '  profile=' + (pf.profile ? trunc(pf.profile, 40) : C.dim('-')) + '  other=' + (pf.other || C.dim('-')));
    if (c.adminExpireAt > 0) console.log('  Session expires ' + C.yel(fmtWhen(c.adminExpireAt)));
  };
  const opt = (a, ...fl) => { for (let i = 0; i < a.length; i++) if (fl.includes(a[i])) return a[i + 1]; return undefined; };
  const commands = {
    login: () => cmdWeb(['--inst', cur, 'login']),
    expire: a => {
      const dev = opt(a, '-d', '--device');
      if (dev && dev !== 'all') return api('POST', '/admin/api/admin-expire', { sid: dev }).then(() => { ok('Session logged out: ' + dev); show(); }).catch(e => console.log(C.yel('注销失败: ' + e.message)));
      const tRaw = opt(a, '-t', '--time'), wRaw = opt(a, '-w', '--wait');
      if (tRaw === undefined && wRaw === undefined) return api('POST', '/admin/api/web-expired').then(() => { ok('All panel sessions logged out'); show(); }).catch(e => console.log(C.yel('注销失败: ' + e.message)));
      const at = parseWhen(wRaw !== undefined ? wRaw : tRaw);
      if (!at) return console.log(C.yel('时间格式: 30(秒) / 10m / 2h / 22:30 / 2026-10-28 09:00'));
      return api('POST', '/admin/api/admin-expire', { at: Math.max(at, Date.now() + 1000) }).then(d => { ok('Panel session expires at ' + fmtWhen(d.at)); show(); }).catch(e => console.log(C.yel('设置失败: ' + e.message)));
    },
    logout: a => {
      const dev = opt(a, '-d', '--device');
      if (dev && dev !== 'all') return api('POST', '/admin/api/web-expired', { sid: dev }).then(() => { ok('Device session logged out: ' + dev); show(); }).catch(e => console.log(C.yel('退出失败: ' + e.message)));
      panelAuth.revoke(loadCfg(cur), cur);
      ok('Logged out of all panel logins');
      show();
    },
    profile: a => {
      const sub = (a[0] || '').toLowerCase();
      if (sub !== 'change') return show();
      const c = loadCfg(cur), pf = Object.assign({}, c.adminProfile || {});
      const av = opt(a, '--avatar'), nm = opt(a, '--name'), pr = opt(a, '--profile'), ot = opt(a, '--other');
      if (av === undefined && nm === undefined && pr === undefined && ot === undefined) return console.log(C.yel('用法: profile change --avatar <URL/路径> --name <名> --profile <内容> --other <内容>'));
      if (av !== undefined) pf.avatar = av;
      if (nm !== undefined) pf.name = nm;
      if (pr !== undefined) pf.profile = pr;
      if (ot !== undefined) pf.other = ot;
      c.adminProfile = pf; saveCfg(cur, c);
      ok('Profile saved'); show();
    },
  };
  return startRepl({
    title: 'agw 管理体系 loop (' + cur + ')',
    prompt: () => 'agw·admin ' + cur + '> ',
    help: HELP_ADMIN,
    refresh: show,
    commands,
    unknown: parts => console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)')),
  });
}


/* ---------- Command entry (prints a one-shot summary when not a TTY; interactive terminals enter the loop) ---------- */
function cmdAdmin(argv) {
  if (argv.includes('help') || argv.includes('--help')) { console.log(HELP_ADMIN); return; }
  const inst = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : 'default';
  if (!listInsts().includes(inst)) die(`Instance not found: ${inst} (have: ${listInsts().join(', ') || 'none'})`);
  if (canLoop()) return loopAdmin(inst);
  const c = loadCfg(inst);
  const ps = panelAuth.read(c, inst);
  console.log(`  ${inst}: panel session ${ps ? maskKey(ps.sid) : 'none'}  login token ${panelAuth.tokenState(ps, Date.now())}  second-key ${(c.adminAuth || {}).secondKey ? 'set' : 'unset'}  TOTP ${(c.adminAuth || {}).totpSecret ? 'on' : 'off'}`);
  console.log(C.dim('  交互终端执行 agw admin 进入管理 loop'));
}

/* ---------- agw config / agw crypt ---------- */
function qrDecode(file) {
  const r = require('child_process').spawnSync('zbarimg', ['-q', '--raw', file], { timeout: 20000 });
  if (r.error) return { error: '二维码解码需要 zbarimg (pkg install zbar)' };
  if (r.status !== 0) return { error: '二维码识别失败: ' + trunc(String(r.stderr || ''), 120) };
  return { text: String(r.stdout || '').trim() };
}
function cmdConfig(argv) {
  const sub = (argv[0] || '').toLowerCase();
  const opt = (...fl) => { for (let i = 0; i < argv.length; i++) if (fl.includes(argv[i])) return argv[i + 1]; return undefined; };
  const usage = () => console.log(t(`用法:
  agw config export <config|all|实例> [--output -p <路径>] [--type -t <0=JSON/1=QRcode>] [--encrypt <true/false>]
  agw config import <文件|二维码图片|camera> [--decrypt <password|none>] [--repair <true/false>]`));
  if (sub === 'export') {
    const scope = argv[1];
    if (!scope) return usage();
    const targets = (scope === 'config' || scope === 'all') ? listInsts() : [scope];
    if (!targets.length) return die('No instances to export');
    if (scope !== 'config' && scope !== 'all' && !listInsts().includes(scope)) return die('Instance not found: ' + scope);
    const qr = opt('-t', '--type') === '1';
    const enc = /^(true|1|on|yes)$/i.test(opt('--encrypt') || '');
    const out = opt('-p', '--output');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const pass = enc ? crypt.loadPass() : null;
    if (enc && !pass) return die('Encrypted export needs .agwkey / AGW_CRYPT_PASS');
    let dir = null;
    if (out && !qr) {
      try { dir = fs.statSync(out).isDirectory() ? out : null; } catch (_) {}
      if (!dir && targets.length > 1) return die('--output must be an existing directory for multi-instance export');
    }
    for (const name of targets) {
      const c = loadCfg(name);
      let text = JSON.stringify(c, null, 2);
      if (enc) text = crypt.encryptText(text, pass);
      if (qr) {
        const dest = path.resolve(out && targets.length === 1 ? out : path.join(out || process.cwd(), 'config-' + name + '-' + stamp + '.png'));
        const r = require('child_process').spawnSync('qrencode', ['-t', 'PNG', '-o', dest], { input: text });
        if (r.error || r.status !== 0) { console.log(C.yel('  ' + name + ': qrencode 失败 ' + (r.error ? r.error.message : 'exit ' + r.status))); continue; }
        console.log('  ' + dest + (text.length > 2200 ? C.dim('  (内容较大, 扫码可能不完整)') : ''));
      } else {
        let dest;
        if (out) dest = path.resolve(dir ? path.join(out, 'config.' + name + '.json') : (targets.length === 1 ? out : path.join(out, 'config.' + name + '.json')));
        else dest = path.join(process.cwd(), 'config-' + name + '-' + stamp + '.json');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
        fs.chmodSync(dest, 0o600);
        console.log('  ' + dest);
      }
    }
    if (enc) console.log(C.dim('已用 .agwkey 加密导出'));
    return ok('Export done');
  }
  if (sub === 'import') {
    const src = argv[1];
    if (!src) return usage();
    const abs = src === 'camera' ? 'camera' : path.resolve(src);
    let raw;
    if (src === 'camera') {
      const shot = path.join(DATA_DIR, '.run', 'qr-camera-' + Date.now() + '.jpg');
      try { fs.mkdirSync(path.dirname(shot), { recursive: true }); } catch (_) {}
      const r = require('child_process').spawnSync('termux-camera-photo', ['-c', '0', shot], { timeout: 20000 });
      if (r.error || r.status !== 0) return die('Photo failed (needs termux-api): ' + (r.error ? r.error.message : 'exit ' + r.status));
      const d = qrDecode(shot);
      try { fs.unlinkSync(shot); } catch (_) {}
      if (d.error) return die(d.error);
      raw = d.text;
    } else {
      if (!fs.existsSync(abs)) return die('文件不存在: ' + abs);
      if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(abs)) {
        const d = qrDecode(abs);
        if (d.error) return die(d.error);
        raw = d.text;
      } else raw = fs.readFileSync(abs, 'utf8');
    }
    const dec = opt('--decrypt');
    if (dec && dec !== 'none') {
      try { raw = crypt.decryptText(raw, dec); } catch (e) { return die('Decrypt failed: ' + e.message); }
    } else if (crypt.isEncText(raw)) {
      const p = crypt.loadPass();
      if (!p) return die('源文件已加密: 用 --decrypt <口令> 或配置 .agwkey');
      try { raw = crypt.decryptText(raw, p); } catch (e) { return die('解密失败: ' + e.message); }
    }
    let c; try { c = JSON.parse(raw); } catch (e) { return die('JSON 无效: ' + e.message); }
    if (/^(true|1|on|yes)$/i.test(opt('--repair') || '')) {
      c.listen = c.listen || {};
      if (!c.listen.port) c.listen.port = 16384;
      c.channels = c.channels || [];
      c.apiKeys = c.apiKeys || [];
      console.log(C.dim('已修补缺失字段(listen/channels/apiKeys)'));
    }
    const base = path.basename(abs).replace(/^config\./, '').replace(/\.json$/i, '');
    const name = listInsts().includes(base) ? base + '-' + Date.now().toString(36) : (base || 'imported');
    fs.writeFileSync(cfgPathOf(name), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
    return ok('Imported as instance ' + name + '; takes effect on agw.sh restart');
  }
  usage();
}
function cmdCrypt(argv) {
  const scope = argv[0], op = (argv[1] || '').toLowerCase(), pass = argv[2];
  if (!scope || !['en', 'de', 're'].includes(op)) return console.log(t(`用法:
  agw crypt <all|config|实例> en <password>        加密
  agw crypt <all|config|实例> de <password|none>   解密
  agw crypt <all|config|实例> re <new-password>    换口令重加密`));
  const sc = scope === 'config' ? 'all' : scope;
  if (op === 'en') return cmdEncrypt([sc, pass]);
  if (op === 'de') return cmdDecrypt([sc, pass === 'none' ? '' : pass]);
  return cmdRecrypt([sc, pass]);
}


/* ==================== main dispatch ==================== */
function help(sub) {
  if (sub && CMDS[sub]) { console.log('agw ' + sub + ' —'); CMDS[sub](['help']); return; }
  console.log(t(`agw — ai-gateway 统一 CLI (计划通规范)    []=可选  <>=值

实例
  agw inst list                                 列出全部实例
  agw inst <inst> [start|stop]                  启动/停止/看状态(无参数=进入实例管理 loop)
  agw inst delete <inst> [-y]                   删除实例(default 不可删)
  agw inst <inst> --status <all|requests|error|debug>
  agw inst <inst> --apikey <key> --webtoken <key> --tls <port|0=关>
  agw inst <inst> --cold <秒> --filter <on|off> --transcreet <on|off|res-only>

路由
  agw router <inst>                             查看当前路由配置
  agw router <inst> --retry <n> --timeout <秒> --cold <秒>
  agw router <inst> --models-fetch <小时|0=关> --filter <on|off>
  agw router <inst> --transcreet <on|off|res-only>

渠道
  agw chan <inst>                               列出渠道
  agw chan <inst> --sdk <openai|gemini|claude>
  agw chan <inst> --provider <名> "<url=…, key=…>"      新建/更新渠道
  agw chan <inst> --provider <名> --scope "请求模型=真实模型, …"
  agw chan <inst> --provider <名> --value <BaseURL> <JSON-Key> [币种]
  agw chan <inst> --provider <名> --proxy "user:pass@host:port" --warn <余额阈值>
  agw chan <inst> --provider <名> --remove      删除渠道
  agw fetch chan <渠道名> [实例]                 看渠道上游模型列表
  agw fetch inst <实例> [-y]                     同步上游模型覆盖本地

上下文

卡密
  agw card list [--inst <实例>]
  agw card --generate --name <名> [--balance <n>] [--expires <ISO>] [--inst <实例>]
  agw card --charge <卡> --balance <n> | --delete <卡> | ban <卡>
  agw card --length <8~128>

交互 loop (空行刷新, help 看命令, exit 退出; 非 TTY 时打印一次性摘要)
  agw inst <inst>                       实例管理 loop(status/grep/dist/edit)
  agw chan <inst>                       渠道管理 loop(fetch/edit/default/lock/unlock/delete/models/scope)
  agw admin [<inst>]                    管理体系 loop(login/expire/profile/logout)
  agw cloudflared                       隧道管理 loop(log/grep/kill/start/stop)

运维
  agw <start|stop|restart|status>               网关进程启停(agw.sh 同款)
  agw refresh ca                                重签 TLS 证书并重启
  agw record <on|off> [--server "user:pass@host:port"] [--max-length <n>] [实例]
  agw cloudflared <start|stop|restart|clear>
  agw notice                                    告警汇总(空key/卡到期/余额/证书)
  agw stat <all|daily|weekly|monthly> [实例]
  agw stat --refresh <分钟> [实例]       统计落盘间隔(0=关; 写 config.statsFlushMin)
  agw stat models|dist [实例]            按模型 / Token 分布(读落盘统计)

面板
  agw web login [--inst <实例>] [--open|--no-open]  打印一次性登录链接
  agw web [--inst <实例>]                           查看 session-id / 登录令牌状态
  agw web --expired [--inst <实例>]                 注销全部面板会话

配置
  agw encrypt|decrypr|recrypt <all|实例> [口令]
  agw export <all|实例> [--QRcode <true|false>]
  agw inport <文件> [口令]
  agw config export|import ...               配置导出/导入(见 agw config)
  agw crypt <all|config|实例> <en|de|re> [口令]
  agw lang <zh>

细节: agw help <命令>    例: agw help chan`));
}
const CMDS = {
  web: cmdWeb,
  inst: cmdInst, router: cmdRouter, chan: cmdChan, fetch: cmdFetch,
  card: cmdCard, refresh: cmdRefresh, record: cmdRecord, cloudflared: cmdCloudflared,
  lang: cmdLang, notice: cmdNotice, stat: cmdStat, admin: cmdAdmin,
  encrypt: cmdEncrypt, decrypr: cmdDecrypt, recrypt: cmdRecrypt,
  export: cmdExport, inport: cmdInport, config: cmdConfig, crypt: cmdCrypt,
};

/* agw restart / agw stop / agw start -- gateway process-level operations (not in the spec; kept for agw.sh muscle memory) */
function cmdProc(argv) {
  const a = (argv[0] || 'status').toLowerCase();
  if (!['start', 'stop', 'restart', 'status'].includes(a)) { console.log(t('用法: agw <start|stop|restart|status>  (网关进程级; 实例启停用 agw inst <inst> [start|stop])')); return; }
  const argsh = path.join(DIR, 'agw.sh');
  try { execSync(`bash '${argsh}' ${a}`, { stdio: 'inherit' }); }
  catch (e) { die(`agw.sh ${a} failed: ` + (e.status || e.message)); }
}
CMDS.start = cmdProc; CMDS.stop = cmdProc; CMDS.restart = cmdProc;
const cmd = process.argv[2];
if (['start', 'stop', 'restart', 'gw', 'status'].includes(cmd)) return cmdProc([cmd]);
if (!cmd || cmd === 'help' || cmd === '--help') return help(process.argv[3]);
const fn = CMDS[cmd];
if (!fn) die(`Unknown command: ${cmd} (agw help)`);
try { const r = fn(process.argv.slice(3)); if (r && r.catch) r.catch(e => die(e.message)); }
catch (e) { die(e.message); }
