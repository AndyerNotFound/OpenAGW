'use strict';
/**
 * OpenAGW plugin kernel — protocol v2
 *
 * Responsibilities: scan installed plugins / activate each instance's server.js /
 * dispatch /plugins/<id>/* / per-instance data / capabilities / admin-SDUI pages /
 * intent signatures (Gay Core §3) / theme tokens.
 *
 * Isolation: plugin code is shared (plugins/<id>/), data and config are per instance
 * (data/plugins-data/<inst>/<id>.json, .gc-security.json).
 *
 * Manifest v2 fields: id, name, version, author, description, icon, type, builtin,
 * hasServer, permissions, provides, appUi, adminApi, configSchema, scope, dataScope,
 * depends, theme, userPage, adminPage.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { IntentGuard } = require('./plugin-security');

const PLUGIN_TYPES = new Set(['auth', 'business', 'theme']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_BODY = 8 * 1024 * 1024;

/** Minimal tar extraction (files/dirs only, path-traversal safe). Plugin packages use .tar.gz (zero-dep, cross-platform). */
function untar(tarBuf, destDir) {
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.slice(off, off + 512);
    let name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break; // empty block = end
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = header.slice(156, 157).toString('utf8');
    off += 512;
    const content = tarBuf.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;
    const safe = path.normalize(name).replace(/^([/\\])+/, '').replace(/(\.\.[/\\])+/g, '');
    if (!safe) continue;
    const dest = path.join(destDir, safe);
    if (type === '5') { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
  }
}

/** Download URL -> Buffer (follows redirects, 30s timeout, 50MB default cap) */
function downloadBuf(url, maxBytes = 50 * 1024 * 1024, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return downloadBuf(new URL(res.headers.location, u).toString(), maxBytes, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const chunks = [];
      let n = 0;
      res.on('data', c => { n += c.length; if (n > maxBytes) { req.destroy(); reject(new Error('超过大小上限')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
  });
}

/** Stable content hash of a plugin directory (relative paths + bytes), for bootstrap disclosure. */
function dirSha256(dir) {
  const files = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const abs = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) files.push([r, abs]);
    }
  };
  walk(dir, '');
  const h = crypto.createHash('sha256');
  for (const [r, abs] of files) {
    h.update(r);
    h.update('\0');
    try { h.update(fs.readFileSync(abs)); } catch {}
    h.update('\0');
  }
  return h.digest('hex');
}

function tryJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

class PluginManager {
/** @param gwDir gateway root dir; @param logFn logger */
  constructor(gwDir, logFn) {
    this.gwDir = gwDir;
    this.pluginsDir = path.join(gwDir, 'plugins');
    this.dataDir = path.join(gwDir, 'data', 'plugins-data');
    this.log = logFn || ((...a) => console.log('[plugins]', ...a));
    /** installed: id -> {manifest, dir, sha256} */
    this.installed = new Map();
    /** active: `${inst}/${id}` -> state */
    this.active = new Map();
    /** capabilities: `${inst}\0${name}` -> {inst, name, impl, pluginId, seq} */
    this._caps = new Map();
    /** admin SDUI pages: `${inst}/${pluginId}/${pageId}` -> page */
    this._adminPages = new Map();
    /** per-instance intent guards */
    this._guards = new Map();
    /** per-instance gatewayApi (findKey / grantQuota) */
    this._gwApi = new Map();
    /** per-instance auth apis contributed by an auth plugin */
    this._authApis = new Map();
    this._capSeq = 0;
    /** (cfg, req, url) => boolean — injected by server.js so plugin routes can reuse panel auth */
    this._adminCheck = null;
    this.ensureDirs();
  }

  /** Server injects the panel-auth check; plugin routes expose it as params.authAdmin(). */
  setAdminCheck(fn) { this._adminCheck = typeof fn === 'function' ? fn : null; }

  ensureDirs() {
    try { fs.mkdirSync(this.pluginsDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
  }

  /** Manifest v2 validation + defaults. A rejected manifest is skipped, never half-loaded. */
  normalizeManifest(raw, dirName) {
    const m = Object.assign({}, raw || {});
    if (!m.id) m.id = dirName;
    m.id = String(m.id);
    if (!ID_RE.test(m.id)) return { ok: false, reason: 'manifest.id 非法（只能小写字母/数字/连字符）' };
    const type = String(m.type || 'business');
    if (!PLUGIN_TYPES.has(type)) return { ok: false, reason: 'manifest.type 非法: ' + type };
    m.type = type;
    m.name = String(m.name || m.id);
    m.version = String(m.version || '?');
    m.author = String(m.author || '');
    m.description = String(m.description || '');
    m.permissions = Array.isArray(m.permissions) ? m.permissions.map(String) : [];
    m.provides = Array.isArray(m.provides) ? m.provides.map(String) : [];
    m.depends = Array.isArray(m.depends) ? m.depends.map(String) : [];
    m.configSchema = Array.isArray(m.configSchema) ? m.configSchema : [];
    m.appUi = (m.appUi && typeof m.appUi === 'object') ? m.appUi : null;
    m.theme = (m.theme && typeof m.theme === 'object') ? m.theme : null;
    m.hasServer = !!m.hasServer;
    m.builtin = !!m.builtin;
    m.scope = m.scope === 'instance' ? 'instance' : 'global';
    m.dataScope = m.dataScope === 'global' ? 'global' : 'instance';
    if (m.adminApi != null) {
      if (!Array.isArray(m.adminApi)) return { ok: false, reason: 'manifest.adminApi 必须是数组' };
      m.adminApi = m.adminApi.map(String);
      for (const p of m.adminApi) if (!p.startsWith('/')) return { ok: false, reason: 'manifest.adminApi 必须以 / 开头: ' + p };
    } else {
      m.adminApi = null; // null = not callable via the admin API
    }
    if (type === 'theme') {
      // theme plugins are pure token packs: no code, no permissions
      if (m.hasServer) return { ok: false, reason: '主题插件不得声明 hasServer' };
      if (m.permissions.length) return { ok: false, reason: '主题插件不得声明 permissions' };
      if (!m.theme) return { ok: false, reason: '主题插件缺少 theme 令牌' };
      m.hasServer = false;
    }
    return { ok: true, manifest: m };
  }

  /** Scan the plugins/ directory and register installed plugins (without activating). */
  scanInstalled(force) {
    const now = Date.now();
    if (!force && this._lastScan && now - this._lastScan < 3000 && this.installed.size) return;
    this._lastScan = now;
    this.installed.clear();
    if (!fs.existsSync(this.pluginsDir)) return;
    for (const d of fs.readdirSync(this.pluginsDir)) {
      const pdir = path.join(this.pluginsDir, d);
      const mf = path.join(pdir, 'manifest.json');
      try {
        if (!fs.statSync(pdir).isDirectory() || !fs.existsSync(mf)) continue;
        const raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const n = this.normalizeManifest(raw, d);
        if (!n.ok) { this.log('插件 ' + d + ' 被拒绝: ' + n.reason); continue; }
        const manifest = n.manifest;
        if (manifest.hasServer && !fs.existsSync(path.join(pdir, 'server.js'))) {
          this.log('插件 ' + d + ' 被拒绝: 声明 hasServer 但缺少 server.js');
          continue;
        }
        if (this.installed.has(manifest.id)) { this.log('插件 id 重复, 后者覆盖:', manifest.id); }
        this.installed.set(manifest.id, { manifest, dir: pdir, sha256: dirSha256(pdir) });
      } catch (e) { this.log('插件 manifest 解析失败:', d, e.message); }
    }
  }

  /** Activates the plugins enabled in an instance's cfg.plugins (auth group first, then business, then theme). */
  activateInstance(instName, cfg, gatewayApi) {
    this.deactivateInstance(instName); // hot-reload safety: stop the old set before activating the new config
    this.scanInstalled(true);
    if (gatewayApi) this._gwApi.set(instName, gatewayApi);
    const list = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    const entries = [];
    for (const pc of list) {
      if (!pc || !pc.enable || !pc.id) continue;
      const inst = this.installed.get(pc.id);
      if (!inst) { this.log(`[${instName}] 插件未安装:`, pc.id); continue; }
      entries.push({ pc, inst });
    }
    for (const e of this._order(entries)) {
      try { this.activateOne(instName, e.pc.id, e.pc, cfg, gatewayApi); }
      catch (err) { this.log(`[${instName}] 插件 ${e.pc.id} 激活异常:`, err.message); }
    }
  }

  /** depends-ordered within group; auth -> business -> theme (a failing auth plugin must not leave business half-on). */
  _order(entries) {
    const byId = new Map(entries.map(e => [e.pc.id, e]));
    const out = [], seen = new Set(), visiting = new Set();
    const visit = (id) => {
      if (seen.has(id) || visiting.has(id)) return;
      visiting.add(id);
      const e = byId.get(id);
      if (e) for (const dep of (e.inst.manifest.depends || [])) visit(dep);
      visiting.delete(id);
      if (e && !seen.has(id)) { seen.add(id); out.push(e); }
    };
    for (const e of entries) visit(e.pc.id);
    const rank = e => (e.inst.manifest.type === 'auth' ? 0 : e.inst.manifest.type === 'theme' ? 2 : 1);
    return out.map((e, i) => [rank(e), i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  }

  activateOne(instName, pluginId, pluginCfg, cfg, gatewayApi) {
    const key = instName + '/' + pluginId;
    this.deactivateByKey(key); // stop before re-activating
    const inst = this.installed.get(pluginId);
    if (!inst) return;
    const { manifest, dir } = inst;
    const state = {
      key, instName, pluginId, manifest, dir,
      routes: new Map(), timers: [], hooks: {},
      data: this.loadData(instName, pluginId),
      dirty: false, cfg: (pluginCfg && pluginCfg.config) || {},
      _instCfg: cfg,
    };
    const saveTimer = setInterval(() => this.flushData(state), 30000);
    if (saveTimer.unref) saveTimer.unref();
    state.timers.push(saveTimer);

    this.active.set(key, state); // registered before activate: a throwing plugin must still roll back
    const serverFile = path.join(dir, 'server.js');
    if (manifest.hasServer && fs.existsSync(serverFile)) {
      const ctx = this.makeCtx(state, cfg, gatewayApi);
      state.ctx = ctx;
      try {
        delete require.cache[require.resolve(serverFile)]; // a fresh module object per instance
        const mod = require(serverFile);
        state.module = mod;
        if (mod && typeof mod.activate === 'function') mod.activate(ctx);
        this.log(`[${instName}] 插件已激活: ${pluginId} v${manifest.version} (${manifest.type}, 路由${state.routes.size}条)`);
      } catch (e) {
        this.log(`[${instName}] 插件 ${pluginId} 激活失败:`, e.stack || e.message);
        this.deactivateByKey(key);
        return;
      }
    }
  }

  /** ctx factory: every capability a plugin may use */
  makeCtx(state, cfg, gatewayApi) {
    const self = this;
    const perms = new Set(state.manifest.permissions || []);
    const needPerm = (p) => { if (!perms.has(p)) throw new Error('插件 ' + state.pluginId + ' 未声明权限: ' + p); };
    const inst = state.instName;
    const maskKey = (k) => (k ? '***' + String(k).slice(-4) : '');
    /* A plugin must never see a credential that outranks it: webToken/adminKey are admin
       credentials, adminAuth holds the 2FA secret. */
    const SECRET_KEYS = new Set(['webToken', 'gatewayKey', 'adminKey', 'adminKey2', 'adminToken']);
    const HDR_SECRET = /^(authorization|x-api-key|x-goog-api-key|api-key|cookie)$/i;
    const scrub = (c) => {
      const o = {};
      for (const [k, v] of Object.entries(c || {})) {
        if (k.startsWith('_')) continue;
        if (SECRET_KEYS.has(k)) { o[k] = v ? '***' : v; continue; }
        if (k === 'adminAuth') { o[k] = v ? { configured: true } : undefined; continue; }
        if (k === 'apiKeys') { o[k] = (v || []).map(x => Object.assign({}, x, { key: maskKey(x.key) })); continue; }
        if (k === 'proxies') {
          const p = {};
          for (const [pn, pv] of Object.entries(v || {})) p[pn] = Object.assign({}, pv, { pass: pv && pv.pass ? '***' : pv && pv.pass, user: pv && pv.user ? '***' : pv && pv.user });
          o[k] = p; continue;
        }
        if (k === 'channels') {
          o[k] = (v || []).map(ch => Object.assign({}, ch, {
            apiKey: ch.apiKey ? '***' : ch.apiKey,
            headers: ch.headers ? Object.fromEntries(Object.entries(ch.headers).map(([hk, hv]) => [hk, HDR_SECRET.test(hk) ? '***' : hv])) : ch.headers,
          }));
          continue;
        }
        o[k] = v;
      }
      return o;
    };
    return {
      id: state.pluginId,
      uid: inst,
      instanceName: inst,
      config: state.cfg,
      type: state.manifest.type,

      /** Read another plugin's config on this instance (null when not enabled). Requires gateway:config. */
      getPluginConfig(pluginId) {
        needPerm('gateway:config');
        const pc = (cfg.plugins || []).find(p => p && p.id === pluginId);
        return pc ? (pc.config || {}) : null;
      },
      /** Instance config with secrets masked. Requires gateway:config. */
      getInstanceConfig() { needPerm('gateway:config'); return scrub(cfg); },

      /** Registers the endpoint /plugins/<id><path> */
      registerRoute(method, p, handler) {
        if (!p.startsWith('/')) p = '/' + p;
        state.routes.set(String(method).toUpperCase() + ' ' + p, handler);
      },

      /** Plugin-private KV (auto-persisted to plugins-data/<inst>/<id>.json) */
      data: {
        get: k => state.data[k],
        set: (k, v) => { state.data[k] = v; state.dirty = true; return v; },
        del: k => { delete state.data[k]; state.dirty = true; },
        all: () => state.data,
        flush: () => { this.flushData(state); },
        rev: () => state.dataRev || 0,
      },
      get dataDir() {
        const d = path.join(self.dataDir, String(inst).replace(/[^a-zA-Z0-9._-]/g, '_'), String(state.pluginId).replace(/[^a-zA-Z0-9._-]/g, '_'));
        try { fs.mkdirSync(d, { recursive: true }); } catch {}
        return d;
      },

      /** Scheduled task: cron(ms, fn) or cron(name, ms, fn). Cleaned up on disable. */
      cron(a, b, c) {
        // tolerant signature: cron(ms, fn) or cron(name, ms, fn)
        const named = typeof a !== 'number' && typeof b === 'number';
        const ms = Number(named ? b : a);
        const fn = named ? c : (typeof a === 'function' ? a : b);
        if (!(ms > 0) || typeof fn !== 'function') throw new Error('cron(ms, fn) / cron(name, ms, fn) 参数非法');
        const t = setInterval(() => { try { fn(); } catch (e) { self.log(`[${state.pluginId}] cron:`, e.message); } }, ms);
        if (t.unref) t.unref();
        state.timers.push(t);
        return t;
      },

      /** Request pipeline hooks (reserved; the kernel stores them, upstream modules may read them). */
      hook(name, fn) {
        (state.hooks[name] = state.hooks[name] || []).push(fn);
      },

      // ---------- capabilities: providers publish, consumers degrade on null ----------
      provideCapability: (name, impl) => self.provideCapability(state, name, impl),
      requireCapability: (name) => self.requireCapability(inst, name),
      listCapabilities: () => self.listCapabilities(inst),

      /** Admin-side SDUI page: {id,title,subtitle,icon,menu,render(gw,cfg,q,caps)} — served at /admin/ui/<id> */
      registerAdminUi: (def) => self.registerAdminUi(state, def),

      /** Auth plugins publish {findKey, grantQuota, ...} for the whole instance. */
      bindAuthApis: (apis) => self.bindAuthApis(state, apis),

      // ---------- intent signatures ----------
      security: {
        verifyIntent: (req, params) => self.verifyIntent(state, req, params),
        commit: (v, response) => self.commitIntent(state, v, response),
        guard: (req, res, params) => {
          const v = self.verifyIntent(state, req, params);
          if (v.ok) return v;
          const body = JSON.stringify(Object.assign({ ok: false, error: v.error },
            v.currentSeq !== undefined ? { currentSeq: v.currentSeq } : {}));
          try { res.writeHead(v.status || 401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body); } catch {}
          return null;
        },
      },

      /** Outbound HTTP through the kernel's upstream stack (proxies, timeouts).
       *  Accepts the core shape {ch,url,method,body,cb} and the positional core shape. */
      upstreamRequest: (o) => require('./src/router.js').upstreamRequest(o),

      /** Gateway capabilities (sensitive items gated by permissions) */
      gateway: {
        instanceName: inst,
        /** Channel list including upstream keys. Requires gateway:config. */
        instanceChannels() { needPerm('gateway:config'); return cfg.channels || []; },
        /** [{uid,name,port,enabled}] — uid is the instance name (single-tenant model). */
        listInstances: () => {
          try {
            const st = require('./state');
            if (st.CUR_POOL && st.CUR_POOL.instances) {
              return [...st.CUR_POOL.instances.entries()].map(([n, c]) => ({ uid: n, name: n, port: Number(c._port) || 0, enabled: !c._disabled }));
            }
          } catch {}
          return [{ uid: inst, name: inst, port: Number(cfg._port) || 0, enabled: !cfg._disabled }];
        },
        findKey: token => self.findKeyFor(inst, token),
        grantQuota: (keyId, tokens) => {
          needPerm('gateway:grantQuota');
          const api = self._gwApi.get(inst);
          return (api && api.grantQuota) ? api.grantQuota(keyId, tokens) : false;
        },
      },

      log: (...a) => self.log(`[${state.pluginId}]`, ...a),
    };
  }

  // ---------- Data persistence ----------
  dataFile(instName, pluginId) {
    const safe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dataDir, safe(instName), safe(pluginId) + '.json');
  }
  loadData(instName, pluginId) {
    const f = this.dataFile(instName, pluginId);
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
    return {};
  }
  flushData(state) {
    if (!state || !state.dirty) return;
    try {
      const f = this.dataFile(state.instName, state.pluginId);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(state.data, null, 2));
      state.dirty = false;
    } catch (e) { this.log('插件数据落盘失败:', e.message); }
  }
  flushAll() {
    for (const [, s] of this.active) this.flushData(s);
    for (const [, g] of this._guards) { try { g.flush(); } catch {} }
  }

  // ---------- Intent security ----------
  guardFor(instName) {
    const k = String(instName);
    if (!this._guards.has(k)) {
      const dir = path.join(this.dataDir, k.replace(/[^a-zA-Z0-9._-]/g, '_'));
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      this._guards.set(k, new IntentGuard(dir, k, this.log));
    }
    return this._guards.get(k);
  }
  findKeyFor(instName, token) {
    const custom = this._authApis.get(String(instName));
    if (custom && typeof custom.findKey === 'function') {
      try { const r = custom.findKey(token); if (r) return r; } catch {}
    }
    const api = this._gwApi.get(String(instName));
    return (api && api.findKey) ? api.findKey(token) : null;
  }
  verifyIntent(state, req, params) {
    return this.guardFor(state.instName).verify({
      pluginId: state.pluginId, req, params, cfg: state._instCfg,
      findKey: t => this.findKeyFor(state.instName, t),
    });
  }
  commitIntent(state, pending, response) {
    if (!pending || !pending._pending) return;
    this.guardFor(state.instName).commit(pending._pending, response);
  }

  // ---------- Capabilities ----------
  _capKey(inst, name) { return String(inst) + '\u0000' + String(name); }
  provideCapability(state, name, impl) {
    const n = String(name || '').trim();
    if (!n) throw new Error('provideCapability: 缺少能力名');
    if (impl == null) throw new Error('provideCapability: 能力 ' + n + ' 的实现为空');
    const inst = state.instName;
    const rec = { inst: String(inst), name: n, impl, pluginId: state.pluginId, seq: ++this._capSeq };
    this._caps.set(this._capKey(inst, n), rec);
    if (state.manifest.dataScope === 'global' && String(inst) !== '0') {
      this._caps.set(this._capKey('0', n), Object.assign({}, rec, { inst: '0', globalFrom: String(inst) }));
    }
    return true;
  }
  requireCapability(inst, name) {
    const r = this._caps.get(this._capKey(inst, name));
    if (r) return r.impl;
    if (String(inst) !== '0') {
      const g = this._caps.get(this._capKey('0', name));
      if (g) return g.impl;
    }
    return null; // missing capability is a normal state, not a fault
  }
  listCapabilities(instName) {
    const out = [];
    for (const v of this._caps.values()) {
      if (String(v.inst) !== String(instName)) continue;
      let api = null;
      try { if (v.impl && typeof v.impl.api === 'function') api = v.impl.api() || null; } catch { api = null; }
      out.push({ name: v.name, pluginId: v.pluginId, global: v.globalFrom !== undefined, api });
    }
    return out;
  }

  // ---------- Admin SDUI pages ----------
  registerAdminUi(state, def) {
    const perms = new Set(state.manifest.permissions || []);
    if (!perms.has('gateway:adminUi')) throw new Error('插件 ' + state.pluginId + ' 未声明权限: gateway:adminUi');
    const d = def && typeof def === 'object' ? def : null;
    if (!d || !d.id || !ID_RE.test(String(d.id))) throw new Error('registerAdminUi: 缺少合法 id（小写字母/数字/连字符）');
    if (typeof d.render !== 'function') throw new Error('registerAdminUi: 缺少 render(gw, cfg, q, caps) 函数');
    this._adminPages.set(state.instName + '/' + state.pluginId + '/' + d.id, {
      id: String(d.id), title: String(d.title || d.id), subtitle: String(d.subtitle || ''),
      icon: String(d.icon || 'apps'), menu: d.menu !== false, render: d.render,
      pluginId: state.pluginId, inst: state.instName,
    });
  }
  adminPages(instName) {
    const byId = new Map();
    for (const [k, page] of this._adminPages) {
      if (!k.startsWith(String(instName) + '/')) continue;
      byId.set(page.id, page); // later registration wins (same id = override)
    }
    return [...byId.values()];
  }
  adminUiManifest(instName) {
    const pages = this.adminPages(instName).filter(p => p.menu)
      .map(p => ({ id: p.id, title: p.title, subtitle: p.subtitle, icon: p.icon, ui: '/admin/ui/' + p.id }));
    return { version: 1, pages };
  }

  // ---------- Auth plugin hooks ----------
  bindAuthApis(state, apis) {
    const inst = String(state.instName);
    this._authApis.set(inst, Object.assign({}, this._authApis.get(inst) || {}, apis || {}));
    return true;
  }

  // ---------- Disable ----------
  deactivateByKey(key) {
    const state = this.active.get(key);
    if (!state) return;
    for (const t of state.timers) { try { clearInterval(t); } catch {} }
    this.flushData(state);
    if (state.module && typeof state.module.deactivate === 'function') {
      try { state.module.deactivate(); } catch (e) { this.log(`[${key}] deactivate:`, e.message); }
    }
    // roll back this plugin's contributions: capabilities + admin pages
    for (const [k, rec] of [...this._caps]) {
      if (rec.pluginId === state.pluginId && String(rec.inst) === String(state.instName)) this._caps.delete(k);
      else if (rec.globalFrom === String(state.instName) && rec.pluginId === state.pluginId) this._caps.delete(k);
    }
    for (const k of [...this._adminPages.keys()]) {
      if (k.startsWith(state.instName + '/' + state.pluginId + '/')) this._adminPages.delete(k);
    }
    this.active.delete(key);
  }
  deactivateInstance(instName) {
    for (const key of [...this.active.keys()]) if (key.startsWith(instName + '/')) this.deactivateByKey(key);
  }

  // ---------- Queries ----------
  /** Plugin list for one instance (with run status) */
  listForInstance(instName, cfg) {
    this.scanInstalled();
    const cfgMap = new Map((Array.isArray(cfg.plugins) ? cfg.plugins : []).map(p => [p.id, p]));
    const out = [];
    for (const [id, inst] of this.installed) {
      const pc = cfgMap.get(id);
      const running = this.active.has(instName + '/' + id);
      const m = inst.manifest;
      out.push({
        id, name: m.name, version: m.version, author: m.author, description: m.description,
        icon: m.icon || null, type: m.type, builtin: !!m.builtin, sha256: inst.sha256 || '',
        hasServer: !!m.hasServer, permissions: m.permissions, provides: m.provides,
        appUi: m.appUi || null,
        hasUserPage: !!m.userPage, hasAdminPage: !!m.adminPage || this.adminPages(instName).some(p => p.pluginId === id),
        userPage: m.userPage || null, adminPage: m.adminPage || null,
        capabilities: this.listCapabilities(instName).filter(c => c.pluginId === id).map(c => c.name),
        enable: pc ? !!pc.enable : false, running,
        config: pc ? (pc.config || {}) : {},
      });
    }
    return out;
  }
  /** Plugins visible to users (enabled + has userPage) */
  userPlugins(instName, cfg) {
    return this.listForInstance(instName, cfg).filter(p => p.enable && p.running && p.hasUserPage)
      .map(p => ({ id: p.id, name: p.name, icon: p.icon, description: p.description, userPage: p.userPage }));
  }

  /** bootstrap.plugins[] — shape matches Gay Core's PluginInfo (all fields optional on the client). */
  bootstrapPlugins(instName, cfg) {
    const enabled = new Set((Array.isArray(cfg.plugins) ? cfg.plugins : []).filter(p => p && p.enable && p.id).map(p => p.id));
    const caps = this.listCapabilities(instName);
    const pages = this.adminPages(instName);
    const out = [];
    for (const [id, inst] of this.installed) {
      if (!enabled.has(id)) continue;
      // a plugin that failed to activate is not disclosed: the App would call dead endpoints
      if (inst.manifest.hasServer && !this.active.has(instName + '/' + id)) continue;
      const m = inst.manifest;
      out.push({
        id, name: m.name, version: m.version, author: m.author, description: m.description,
        icon: m.icon || null, type: m.type, builtin: !!m.builtin, sha256: inst.sha256 || '',
        permissions: m.permissions, provides: m.provides,
        capabilities: caps.filter(c => c.pluginId === id).map(c => c.name),
        appUi: m.appUi || null, userPage: m.userPage || null,
        hasAdminPage: !!m.adminPage || pages.some(p => p.pluginId === id),
      });
    }
    return out;
  }

  /** bootstrap.themes[] — theme plugins are pure token packs; a locked default is always present. */
  themeList(cfg) {
    const out = [];
    for (const [id, inst] of this.installed) {
      const m = inst.manifest;
      if (m.type !== 'theme' || !m.theme) continue;
      const pc = (Array.isArray(cfg.plugins) ? cfg.plugins : []).find(p => p.id === id);
      const isDefault = m.theme.default === true || (!!m.builtin && !!m.locked);
      if (!(pc && pc.enable) && !isDefault) continue;
      out.push({
        id, name: m.theme.name || m.name, builtin: !!m.builtin, locked: isDefault,
        dark: m.theme.dark || null, light: m.theme.light || null, cssVars: m.theme.cssVars || null,
      });
    }
    out.sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0));
    if (!out.some(t => t.locked)) {
      out.unshift({ id: 'theme-md3', name: 'MD3 默认', builtin: true, locked: true, dark: null, light: null, cssVars: null });
    }
    return out;
  }

  // ---------- Install / uninstall / configure ----------
  /**
   * Installs a plugin package (.tar.gz) from a Buffer. Verify SHA256 (optional) -> extract -> validate manifest -> move to plugins/<id>.
   * Returns {id, manifest, sha256}. Errors when the id already exists (uninstall first to update).
   */
  installPackage(buf, expectedSha256) {
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha256 && actualSha !== String(expectedSha256).toLowerCase()) {
      throw new Error(`SHA256 不匹配! 期望 ${expectedSha256} 实际 ${actualSha} —— 安装已中止(可能被篡改)`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-pkg-'));
    try {
      const tarBuf = zlib.gunzipSync(buf); // .tar.gz
      untar(tarBuf, tmp);
      let root = tmp;
      if (!fs.existsSync(path.join(root, 'manifest.json'))) {
        const subs = fs.readdirSync(tmp).filter(d => fs.statSync(path.join(tmp, d)).isDirectory());
        if (subs.length === 1 && fs.existsSync(path.join(tmp, subs[0], 'manifest.json'))) root = path.join(tmp, subs[0]);
      }
      const mfPath = path.join(root, 'manifest.json');
      if (!fs.existsSync(mfPath)) throw new Error('包内找不到 manifest.json（不是合法的插件包）');
      const raw = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      const n = this.normalizeManifest(raw, path.basename(root));
      if (!n.ok) throw new Error('manifest 不合法: ' + n.reason);
      const manifest = n.manifest;
      if (manifest.hasServer && !fs.existsSync(path.join(root, 'server.js'))) throw new Error('manifest 声明 hasServer 但缺少 server.js');
      const dest = path.join(this.pluginsDir, manifest.id);
      if (fs.existsSync(dest)) throw new Error(`插件已存在: ${manifest.id}（更新请先卸载旧版）`);
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      fs.renameSync(root, dest);
      this.scanInstalled();
      return { id: manifest.id, manifest, sha256: actualSha };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  /** Download from a URL and install */
  async installFromUrl(url, sha256) {
    const buf = await downloadBuf(url);
    return this.installPackage(buf, sha256);
  }

  /** Uninstall a plugin (first disables it on every instance). keepData=true keeps its data */
  removePlugin(pluginId, keepData) {
    for (const key of [...this.active.keys()]) if (key.endsWith('/' + pluginId)) this.deactivateByKey(key);
    const dir = path.join(this.pluginsDir, pluginId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (!keepData) {
      try {
        for (const inst of fs.readdirSync(this.dataDir)) {
          const f = this.dataFile(inst, pluginId);
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        }
      } catch {}
    }
    this.scanInstalled();
    return true;
  }

  /** Read a plugin's configSchema + current config (lets the admin panel render its settings form) */
  configSchema(instName, pluginId, cfg) {
    const inst = this.installed.get(pluginId);
    if (!inst) return null;
    const pc = (Array.isArray(cfg.plugins) ? cfg.plugins : []).find(p => p.id === pluginId);
    return { schema: inst.manifest.configSchema || [], config: pc ? (pc.config || {}) : {} };
  }

  // ---------- HTTP dispatch ----------
  /** Handles /plugins[/<id>[/<path...>]]. Called after the main route has resolved the instance cfg. */
  async handle(cfg, req, res, u, p, body) {
    const instName = req._branchName || (cfg && cfg._name) || 'default';
    const segs = p.split('/').filter(Boolean); // ['plugins', ...]
    const json = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(s);
    };

    // GET /plugins -> plugin center page (HTML) to browsers, JSON to API callers
    if (p === '/plugins' || p === '/plugins/') {
      if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
      const list = this.userPlugins(instName, cfg);
      const accept = String(req.headers.accept || '');
      if (accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderPluginIndex(list, instName));
      }
      return json(200, { ok: true, plugins: list });
    }
    // GET /plugins/required -> admin-configured recommended plugins (first-login prompt)
    if (segs[1] === 'required') {
      if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
      return json(200, { ok: true, required: cfg.requiredPlugins || [] });
    }

    const pluginId = segs[1];
    const subPath = '/' + segs.slice(2).join('/');
    const state = this.active.get(instName + '/' + pluginId);
    if (!state) return json(404, { error: `插件未启用: ${pluginId}` });

    // 1) check API routes registered by server.js first
    const handler = state.routes.get(String(req.method).toUpperCase() + ' ' + subPath);
    if (handler) {
      const params = {
        query: Object.fromEntries(u.searchParams),
        body: tryJson(body),
        rawBody: body,
        headers: req.headers,
        // Admin check for plugin admin routes: {ok} / {ok:false,status,error}
        authAdmin: () => {
          const f = this._adminCheck;
          if (!f) return { ok: false, status: 401, error: '需要管理员密钥' };
          try { return f(cfg, req, u) ? { ok: true } : { ok: false, status: 401, error: '需要管理员密钥' }; }
          catch (e) { return { ok: false, status: 401, error: '需要管理员密钥' }; }
        },
        // Convenience: fetch the caller's key card (Bearer/x-api-key/x-goog-api-key/?key=)
        token: (() => {
          const a = req.headers.authorization || '';
          if (a.startsWith('Bearer ')) return a.slice(7).trim();
          return req.headers['x-api-key'] || req.headers['x-goog-api-key'] || u.searchParams.get('key') || '';
        })(),
      };
      try { await handler(req, res, params); }
      catch (e) { this.log(`[${pluginId}] ${subPath} 处理异常:`, e.stack || e.message); if (!res.headersSent) json(500, { error: '插件内部错误: ' + e.message }); }
      return;
    }

    // 2) static pages/assets: pages/ and declared entry files only.
    //    Never serve server.js / manifest.json / *.json: source + endpoint disclosure to anonymous callers.
    const rel = (subPath.replace(/^\/+/, '') || state.manifest.userPage || 'index.html');
    const ext = path.extname(rel).toLowerCase();
    const declared = [state.manifest.userPage, state.manifest.adminPage, state.manifest.icon].filter(Boolean).map(String);
    const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.css', '.otf', '.eot', '.wasm', '.txt']);
    const isPage = rel.startsWith('pages/') && (ext === '.html');
    const isAsset = ASSET_EXT.has(ext);
    if (!isPage && !isAsset && !declared.includes(rel)) {
      return json(404, { error: `插件静态文件不可直接访问: ${pluginId}/${rel}` });
    }
    if (ext === '.js' || ext === '.json' || ext === '.md' || ext === '.map') {
      return json(404, { error: `插件静态文件不可直接访问: ${pluginId}/${rel}` });
    }
    const filePath = path.normalize(path.join(state.dir, rel));
    if (!(filePath === state.dir || filePath.startsWith(state.dir + path.sep))) { res.writeHead(403); return res.end('Forbidden'); }
    const relResolved = path.relative(state.dir, filePath).replace(/\\/g, '/');
    if (state.manifest.adminPage && relResolved === String(state.manifest.adminPage)) {
      const okAdmin = (() => { try { return this._adminCheck ? this._adminCheck(cfg, req, u) : false; } catch (_) { return false; } })();
      if (!okAdmin) return json(401, { error: '需要管理员凭据才能打开插件管理页' });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(filePath));
    }
    json(404, { error: `插件路由不存在: ${pluginId}${subPath}` });
  }
}

/** Plugin center page (browser hits /plugins): card grid, click to open a plugin. Instance prefix is derived server-side to avoid relative-path ambiguity. */
function renderPluginIndex(list, instName) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (instName === 'default' ? '' : '/' + encodeURIComponent(instName)) + '/plugins/';
  const cards = list.map(p => {
    const href = base + p.id + '/' + (p.userPage || 'pages/user.html');
    const icon = p.icon
      ? `<img class="icon" src="${esc(base + p.id + '/' + p.icon)}" alt="">`
      : `<div class="icon emoji">🧩</div>`;
    return `<a class="card" href="${esc(href)}">${icon}<div class="name">${esc(p.name)}</div><div class="desc">${esc(p.description || '')}</div><div class="open">打开 →</div></a>`;
  }).join('\n');
  const empty = `<div class="empty">🧩<br><br>还没有启用的插件<br><span>请管理员在插件管理里安装并启用</span></div>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>插件中心${instName === 'default' ? '' : ' · ' + esc(instName)}</title>
<style>
  *{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#121212;color:#e8eaed;margin:0;padding:20px}
  header{max-width:880px;margin:8px auto 22px;display:flex;align-items:center;gap:12px}
  header h1{font-size:22px;margin:0}
  header .inst{font-size:12px;color:#9aa0a6;background:#1e1e1e;padding:4px 12px;border-radius:20px}
  .grid{max-width:880px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .card{background:#1e1e1e;border-radius:20px;padding:22px;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:.15s;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  .card:hover{background:#262626;transform:translateY(-2px)}
  .icon{font-size:38px;width:56px;height:56px;display:flex;align-items:center;justify-content:center;background:#2a2a2a;border-radius:16px;margin-bottom:14px}
  img.icon{object-fit:cover}
  .name{font-size:17px;font-weight:600;margin-bottom:6px}
  .desc{font-size:13px;color:#9aa0a6;line-height:1.5;flex:1}
  .open{margin-top:14px;font-size:13px;color:#8ab4f8;font-weight:600}
  .empty{max-width:880px;margin:60px auto;text-align:center;color:#9aa0a6;font-size:16px;line-height:2}
  .empty span{font-size:13px;color:#666}
</style></head><body>
<header><h1>🧩 插件中心</h1><span class="inst">${esc(instName)}</span></header>
<div class="grid">${list.length ? cards : empty}</div>
</body></html>`;
}

module.exports = { PluginManager, downloadBuf, dirSha256, PLUGIN_TYPES };
