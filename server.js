'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { poolRoute, tlsBlocked, BILLING_PATHS, GENERIC_BALANCE_PATHS, createInstancePool, poolLoadAll, setupModelSync, statsFlushFile, setupStatsFlush } = require('./pool');
const { sendError, corsHeaders, jsonErr, checkAuth, keyCreditsJSON, genApiKey, persistRuntimeCfg, availableBranches, collectJson, modelsResponse, sendJson, loadKeyUsage, makeGatewayApi } = require('./router');
const { VERSION, utf8, log, logErr } = require('./util');
const { balanceAggregate, pickBalanceChannel, fetchBalanceCached, fetchChannelBalance, balanceTarget, setupProbe } = require('./upstream');
const { fetchUpstreamModels, syncModels } = require('./sync');
const { handleExtraEndpoint } = require('./passthrough');
const { handleChat } = require('./record');
const modelref = require('./modelref');
const { applyDefaults } = require('./config');
const rt = require('./runtime');
const admin = require('./admin');
const { handleAdmin } = admin;
const state = require('./state');
const panelAuth = require('./panel-auth');
const hot = require('./hot');
const { completePath } = require('./endpoints');
const mdns = require('./mdns');
const permissions = require('./permissions');
const ratelimit = require('./ratelimit');
const { surfaceMatch } = require('./surface');
/* Endpoint completion logs once per bare path, not once per request: a client whose base URL
 * has no /v1 would otherwise add a line to every single call. */
const EP_LOGGED = new Set();

// ================= HTTP service =================
/* Greedy model segment: a model reference "instance:channel:model" contains colons itself,
 * so the method name is split off at the LAST colon (ported from ai-gateway-core) */
const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;
// Any /v1/* path not handled by a conversion entry forwards verbatim to the openai channel (isPassthru → handleExtraEndpoint); always on.

async function handleHttp(cfg, req, res) {
  hot.track(req, res);
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;

// ===== Secret admin surface (2026-11-10) =====
// The WebUI lives at /<sid>/admin/... (one-time link -> login page -> session cookie). The
// card-holder API keeps its old bare paths (/v1, /v1beta, /api/app, /plugins and the
// /<instance>/ prefix in multi-instance mode), so standard SDK base URLs need no changes.
// A /<sid>/admin shape that no instance owns answers 404: probing /admin or /auth never
// finds the panel. Instance permissions are enforced centrally afterwards, as before.
  {
    const pool = state.CUR_POOL;
    const insts = pool ? [...pool.instances.values()] : [cfg];
    const s = surfaceMatch(insts, p);
    if (s && s.cfg) {
      cfg = s.cfg;
      p = s.path;
      req._branchName = s.name;
      req._panelSid = s.sid;
      if (pool) {
        const blk = tlsBlocked(pool, s.name, req);
        if (blk) return sendError('openai', res, blk.status || 400, blk.error);
      }
    } else if (s && s.unknown) {
      return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);
    } else if (pool) {
      const r = poolRoute(pool, req, p);
      if (r.error) { sendError('openai', res, r.status || 404, r.error); return; }
      cfg = r.cfg;
      p = r.path;
      if (r.name) req._branchName = r.name;
    }
  }

  if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }

// ===== Endpoint completion: a base URL that stops at the host still works =====
// Runs after instance routing (so /<inst>/chat/completions completes on the stripped path) and
// before the whitelist (so completion can never re-open a closed prefix: only the OpenAI-dialect
// endpoints listed in endpoints.js are completed; /health /status /auth /admin ... are not there).
  const completed = completePath(p);
  if (completed !== p) {
    if (!EP_LOGGED.has(p) && EP_LOGGED.size < 200) {
      EP_LOGGED.add(p);
      log('[path] 端点补全:', p, '→', completed);
      if (EP_LOGGED.size === 200) log('[path] 端点补全日志已满(200 条), 后续不再逐条记录');
    }
    p = completed;
  }

// ===== Public route whitelist: the card-holder API plus the secret admin prefix =====
// /health /status /balance /dashboard… keep 404ing (completion never re-opens them either).
// /admin is only reachable through /<sid>/admin (req._panelSid); a bare /admin stays 404.
  const allowed = p === '/v1' || p.startsWith('/v1/')
    || p === '/v1beta' || p.startsWith('/v1beta/')
    || p === '/plugins' || p.startsWith('/plugins/')
    || p === '/api/app' || p.startsWith('/api/app/')
    || (!!req._panelSid && (p === '/admin' || p.startsWith('/admin/')));
  if (!allowed) return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);

// ===== Web admin panel: /admin... (only after the /<sid>/admin prefix matched) =====
// Entry is the one-time link /<sid>/admin/<token>; the panel, its static assets and the JSON
// API all sit behind the session cookie issued by the login page (admin card key + 2FA).
  if (req._panelSid && (p === '/admin' || p.startsWith('/admin/'))) {
// POST/DELETE bodies are collected first; handleAdmin answers every /admin/* path itself
    if (req.method === 'POST' || req.method === 'DELETE') {
      let adminBody = '';
const u8 = utf8();   /* *chunk-safe decoding (2026-09-18) */
      req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    } else {
      return handleAdmin(cfg, req, res, u, p, '');
    }
    return;
  }
// ===== Native app protocol: GET /api/app/bootstrap =====
  if (p === '/api/app/bootstrap' && req.method === 'GET') {
    return require('./bootstrap').handleBootstrap(cfg, req, res, rt.PLUGINS);
  }

// ===== Plugin routes: /plugins[/<id>[/<path...>]] =====
// (the whitelist above re-opens this prefix; dispatch lives in plugins.js)
  if (p === '/plugins' || p.startsWith('/plugins/')) {
    if (!rt.PLUGINS) return sendError('openai', res, 503, 'plugin kernel unavailable');
    const go = (b) => Promise.resolve(rt.PLUGINS.handle(cfg, req, res, u, p, b))
      .catch(e => { try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '插件分发异常: ' + e.message })); } catch {} });
    if (req.method === 'GET' || req.method === 'HEAD') { go(''); return; }
    let pb = '';
    const pu8 = utf8();
    req.on('data', c => { pb += pu8(c); if (pb.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => go(pb));
    req.on('error', () => {});
    return;
  }

// ===== Accessible branch list (card auth, filtered by branches) =====
  if (p === '/v1/branches' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams, { anyBranch: true });
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ branches: availableBranches(cfg, authR.userKey) }));
  }

  if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
    const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(fmt, res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(modelsResponse(cfg, fmt, authR.userKey)));
  }

// ===== Upstream balance passthrough (OpenAI semantics, recognizable by third-party clients) =====
//   GET /v1/dashboard/billing/credit_grants -> credit_summary (total_available = upstream balance)
//   GET /v1/dashboard/billing/subscription  -> billing_subscription (hard/soft_limit_usd = upstream balance)
//   ?ch=<channel> picks a channel (default when omitted); key cards may only pick channels from their own channels whitelist
  if (req.method === 'GET' && BILLING_PATHS.has(p)) {
    const t0 = Date.now();
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const isGrants = p.endsWith('credit_grants');
    const uk = authR.userKey || null;
    const want = String(u.searchParams.get('ch') || u.searchParams.get('channel') || '').trim();
    let ch = null;
    if (want) {
      ch = (cfg.channels || []).find(c => c.name === want) || null;
      if (!ch) return sendError('openai', res, 404, '渠道不存在: ' + want);
      const cardWl = uk && Array.isArray(uk.channels) && uk.channels.length ? uk.channels : null;
      const isAdminCard = uk && uk.role === 'admin';
      const allowed = isAdminCard || !cardWl || cardWl.includes(want);
      if (!allowed) return sendError('openai', res, 403, '此卡密不允许查询渠道余额: ' + want);
    } else if (GENERIC_BALANCE_PATHS.has(p)) {
// Multi-channel aggregation (generic balance alias): concurrently query every visible channel with a balance target -> convert to base currency and sum
      return balanceAggregate(cfg, uk, (agg) => {
        if (!agg.ok) return sendError('openai', res, agg.status || 503, agg.error);
        return sendJson(res, 200, {
          ...agg,
          data: { total_remain: agg.total_remain, unit: agg.unit, channels: agg.channels, partial: agg.partial, ok_count: agg.ok_count },
        });
      });
    } else {
      ch = pickBalanceChannel(cfg, uk);
      if (!ch) return sendError('openai', res, 503, '本实例没有可查询余额的渠道(可在渠道配置里填 balanceUrl + balancePath)');
    }
    const finish = (r, cached) => {
      if (!r.ok) {
        log('UPERR', '[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'status=' + (r.status || 502), r.error || '');
        return sendError('openai', res, r.status || 502, r.error || 'balance query failed');
      }
      log('[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'channel=' + ch.name, 'unit=' + (r.unit || '-'), 'ms=' + (Date.now() - t0) + (cached ? ' (cached)' : ''));
      const num = Number(r.balance);
      const avail = isFinite(num) ? num : null;
      const common = { channel: ch.name, balance: r.balance, unit: r.unit || '', upstream_url: r.url };
// Generic balance shape: compatible with any client's "balance path + JSON key" config (provides total_remain / balance / remaining / total_available)
      if (GENERIC_BALANCE_PATHS.has(p)) {
        const generic = { total_remain: avail, balance: r.balance, total_available: avail, total_granted: avail, total_used: 0, remaining: avail, unit: r.unit || '', channel: ch.name };
        return sendJson(res, 200, { ...generic, data: { ...generic, upstream_url: r.url } });
      }
      if (isGrants) return sendJson(res, 200, { object: 'credit_summary', total_granted: avail, total_used: 0, total_available: avail, grants: { object: 'list', data: [] }, ...common });
      return sendJson(res, 200, {
        object: 'billing_subscription', has_payment_method: true, canceled: false, canceled_at: null, delinquent: null,
        access_until: Math.floor(Date.now() / 1000) + 31536000,
        soft_limit_usd: avail, hard_limit_usd: avail, system_hard_limit_usd: avail,
        plan: { title: 'OpenAGW', id: 'openagw' }, account_name: ch.name, ...common,
      });
    };
    try {
      fetchBalanceCached(cfg, ch, finish);
    } catch (e) {
      logErr('[balance] 查询异常:', e.message);
      sendError('openai', res, 500, 'balance query failed: ' + e.message);
    }
    return;
  }

// Fallback passthrough decision: any /v1/* not owned by a conversion entry -> forwards verbatim to the openai channel
// (fixed gateway behavior: files/batches/vector_stores/images/embeddings/audio/completions/moderations etc. always pass through)
  const isConvEndpoint = (q) => (
    q === '/v1/chat/completions' || q === '/chat/completions' ||
    q === '/v1/messages' || q === '/messages' ||
    q === '/v1/responses' || GEMINI_RE.test(q)
  );
  const isPassthru = p.startsWith('/v1/') && !isConvEndpoint(p);

  // unknown non-POST endpoint: if the path looks like a balance/usage query, log one line (to add aliases later); passthrough paths go through
  if (req.method !== 'POST' && !isPassthru) {
    if (/balance|quota|credit|billing|usage|wallet|cost|spend|money/i.test(p)) {
      log('[balance] 未命中的余额系路径:', req.method, p, '(可补进 BILLING_PATHS 别名)');
    }
    return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);
  }

  let clientFormat = null;
  let clientApi = 'chat';
  const urlInfo = { model: null, altSse: false };
  if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
  else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
  else if (p === '/v1/responses') {
    clientFormat = 'openai';
    clientApi = 'responses';
  } else {
    const m = GEMINI_RE.exec(p);
    if (m) {
      clientFormat = 'gemini';
      urlInfo.model = decodeURIComponent(m[1]);
      urlInfo.altSse = u.searchParams.get('alt') === 'sse';
      urlInfo.stream = m[2] === 'streamGenerateContent';
      if (m[2] === 'countTokens') return sendError('gemini', res, 501, 'countTokens is not supported by this gateway');
    }
  }
// OpenAI fallback passthrough: any /v1/* (not handled by the conversion entries above) forwards verbatim to the openai channel
// Preserves method (GET/POST/PUT/PATCH/DELETE), query, multipart, binary/streaming
  if (!clientFormat && isPassthru) {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
/* Passthrough endpoints carry arbitrary payloads (files, images, audio), so only RPM applies here;
 * TPM accounting needs a parsed generation body and stays with the chat/conversion path. */
    if (authR.userKey) {
      const rl = ratelimit.admit(authR.userKey, 0);
      if (!rl.ok) {
        try { if (rl.retryAfter) res.setHeader('Retry-After', String(rl.retryAfter)); } catch (_) {}
        return sendError('openai', res, rl.status || 429, rl.error || 'rate limited');
      }
    }
    const ct = req.headers['content-type'] || '';
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); sendError('openai', res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) handleExtraEndpoint(cfg, req, res, p + (u.search || ''), Buffer.concat(chunks), ct, req.method, authR.userKey || null); });
    req.on('error', () => {});
    return;
  }
  if (!clientFormat) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1beta/models/{model}:generateContent|:streamGenerateContent; 其余 /v1/* 原样透传到 openai 渠道; base URL 不写 /v1 也认)');

  const authR = checkAuth(cfg, req, u.searchParams);
  if (!authR.ok) return sendError(clientFormat, res, authR.status || 401, authR.error || 'invalid key');
  urlInfo.userKey = authR.userKey || null;
  urlInfo.keyOwner = authR.keyOwner || cfg;

  let bodyStr = '';
  let size = 0;
  let aborted = false;
  const u8chat = utf8();
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > cfg.maxBodyBytes) {
      aborted = true;
      req.destroy();
      sendError(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)');
      return;
    }
    bodyStr += u8chat(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
/* Model reference "instance:channel:model" (ported from ai-gateway-core): lets a client pin an
 * exact source when the same model name is served by several channels/instances. Resolved and
 * verified (the named channel really serves the model) -> switch instance + pin channel + the
 * real name goes downstream; unresolvable references are treated as ordinary model names. */
      try {
        let want = urlInfo.model || null;
        if (!want && bodyStr) { try { const bj = JSON.parse(bodyStr); if (bj && typeof bj.model === 'string') want = bj.model; } catch (_) {} }
        if (want) {
          const ref = modelref.parseRef(want);
          if (ref) {
            const poolInsts = state.CUR_POOL ? [...state.CUR_POOL.instances.values()] : [cfg];
            let tgt = null;
            for (const c of poolInsts) {
              if (c && modelref.channelMatch(ref.instance, c._name || 'default')) { tgt = c; break; }
            }
            let hit = null;
            if (tgt && !tgt._disabled) {
              const branchesOk = !authR.userKey || permissions.allowsBranch(authR.userKey, tgt._name);
              if (branchesOk) {
                for (const ch of (tgt.channels || [])) {
                  if (!ch || !ch.name || !modelref.channelMatch(ref.channel, ch.name)) continue;
                  const mm = (ch.modelMap && typeof ch.modelMap === 'object') ? ch.modelMap : {};
                  if (Object.prototype.hasOwnProperty.call(mm, ref.model)
                    || (Array.isArray(ch.models) && ch.models.includes(ref.model))) { hit = ch; break; }
                }
              }
            }
            if (tgt && hit) {
              if (cfg !== tgt) log('[ref] ' + want + ' → 实例 ' + (tgt._name || 'default') + ' / 渠道 ' + hit.name);
              cfg = tgt;
              req._branchName = tgt._name;
              urlInfo.forceChannel = String(hit.name);
              urlInfo.modelOverride = ref.model;
              urlInfo.rawModel = want;
            } else {
              log('[ref] 引用无法解析(实例/渠道/模型不匹配), 当普通模型名处理: ' + want);
            }
          }
        }
      } catch (e) { logErr('[ref] 解析失败:', e.message); }
      handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr);
    } catch (e) {
      logErr('chat crash:', e);
      sendError(clientFormat, res, 500, 'internal: ' + e.message);
    }
  });
  req.on('error', () => {});
}

// Advertise the main port over mDNS (no-op unless config mdns.enable)
function startMdns(cfg, port, tls) {
  try {
    mdns.apply({ enable: !!(cfg.mdns && cfg.mdns.enable), name: cfg.mdns && cfg.mdns.name, port, tls });
  } catch (e) {
    logErr('[mdns] 启动失败: ' + e.message);
  }
}

function startServer(cfg, opts = {}) {
  state.CUR_CFG = cfg;
  applyDefaults(cfg);
  const cfgDir = cfg._configFile ? path.dirname(cfg._configFile) : path.join(os.homedir(), 'OpenAGW');
  admin.setDir(cfgDir);
  if (rt.PLUGINS) {
    admin.setPlugins(rt.PLUGINS);
    rt.PLUGINS.setAdminCheck((c, rq, u) => admin.checkAdminAuth(c, rq, u && u.searchParams));
  }

// ===== Multi-instance mode: one process hosts all config*.json in the dir; main-port path routing + compatibility listening on instance ports =====
  if (opts.multi) {
    const pool = createInstancePool(cfgDir);
    state.CUR_POOL = pool;
    pool.mainHost = opts.host || cfg.listen.host;
    admin.setPool(pool);
    admin.setUpstreamModels((ch, inst) => fetchUpstreamModels((inst && pool.instances.get(inst)) || cfg, ch));
    admin.setSyncFn((inst) => syncModels((inst && pool.instances.get(inst)) || cfg));
    admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb), { cached: fetchBalanceCached, target: balanceTarget });
    poolLoadAll(pool, cfg);
    log(`OpenAGW v${VERSION} 就绪 (多实例单进程模式):`);
    log(`  主端口 ${pool.mainHost}:${pool.mainPort}${pool.mainTlsPort ? ' (https:' + pool.mainTlsPort + ')' : ''}  →  /实例名/v1/... 访问对应实例, 无前缀 = default; 面板 /<sid>/admin/...`);
    for (const [name, c] of pool.instances) {
      const ports = [];
      for (const srv of pool.servers.values()) if (srv.name === name) ports.push((srv.tls ? 'https:' : '') + srv.port);
      log(`  实例 ${name}${c._disabled ? ' [已停用]' : ''}: ${c.channels.length} 渠道${ports.length ? ', 端口 ' + ports.join(',') : ''}`);
      for (const ch of c.channels) log(`    渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
    }
    return Promise.resolve({ pool, port: pool.mainPort, host: pool.mainHost, cfg });
  }

// ===== Single-instance mode =====
// A pool left over from an earlier multi-instance start in the same process would hijack every
// request (poolRoute is consulted whenever CUR_POOL is set), so single mode clears it explicitly.
  if (state.CUR_POOL) { state.CUR_POOL = null; admin.setPool(null); }
  try { panelAuth.ensure(cfg); } catch (e) { logErr('[panel] 初始化登录状态失败: ' + e.message); }
  admin.setUpstreamModels(ch => fetchUpstreamModels(cfg, ch));
  admin.setSyncFn(() => syncModels(cfg));
  admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb), { cached: fetchBalanceCached, target: balanceTarget });
  setupModelSync(cfg);
  loadKeyUsage(cfg);
  setupProbe(cfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance(cfg._name || 'default', cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败: ' + e.message); } }
  cfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, retries: 0, byChannel: {}, recent: [] };
try { // cold-start restore
    const sf = statsFlushFile(cfg);
    if (fs.existsSync(sf)) {
      const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
      cfg._stats.requests = j.requests || 0; cfg._stats.errors = j.errors || 0; cfg._stats.retries = j.retries || 0;
      cfg._stats.byChannel = j.byChannel || {}; cfg._stats.byKey = j.byKey || {};
      cfg._stats.byModel = j.byModel || {}; cfg._stats.daily = j.daily || {};
      cfg._stats.hourly = j.hourly || {}; cfg._stats.minutely = j.minutely || {};
      cfg._stats.startedAt = j.since || cfg._stats.startedAt;
    }
  } catch (_) {}
  setupStatsFlush(cfg);
  const handler = (req, res) => {
    handleHttp(cfg, req, res).catch(e => {
      logErr('handler crash:', e);
      sendError('openai', res, 500, 'internal: ' + (e && e.message));
    });
  };
  const host = opts.host || cfg.listen.host;
  const port = opts.port != null ? opts.port : cfg.listen.port;

  let tlsCfg = null;  // populated only when TLS is on and the certificate actually loads
  if (cfg.tls && cfg.tls.enable) {
    const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.cert);
    const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.key);
    try {
      tlsCfg = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
    } catch (e) {
      logErr(`⚠ TLS 已启用但证书读取失败: ${e.message}`);
      logErr(`  cert: ${certPath}`);
      logErr(`  key:  ${keyPath}`);
      logErr(`  请先运行 ~/OpenAGW/gen-cert.sh 生成证书, 或在 config.json 中设置 "tls": {"enable": false}`);
      logErr(`  (TLS 开启后该实例只在 listen.port 上提供 HTTPS, 不再有明文入口)`);
      logErr(`  本次将以纯 HTTP 模式启动`);
    }
  }

  if (!tlsCfg) {
    // pure HTTP mode
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        const realPort = server.address().port;
        log(`OpenAGW v${VERSION} 就绪: http://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${realPort}  配置: ${cfg._configFile}`);
        for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
        for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
        startMdns(cfg, realPort, false);
        resolve({ server, port: realPort, host, cfg });
      });
    });
  }

  // TLS serves pure HTTPS on listen.port (tls.port is ignored: one entry per instance)
  const httpsPort = port;

  return new Promise((resolve, reject) => {
    const results = { servers: [], ports: [], cfg };

    const logReady = () => {
      log(`OpenAGW v${VERSION} 就绪 (配置: ${cfg._configFile}):`);
      for (const [p, scheme] of results.ports) {
        log(`  ${scheme}://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${p}`);
      }
      for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
      for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
      if (results.ports.length) startMdns(cfg, results.ports[0][0], results.ports[0][1] === 'https');
    };

    let pending = 1;
    const onReady = (server, p, scheme) => {
      results.servers.push(server);
      results.ports.push([p, scheme]);
      if (--pending === 0) { logReady(); resolve({ servers: results.servers, ports: results.ports, server: results.servers[0], port: results.ports[0][0], host, cfg }); }
    };
    const onErr = (e) => reject(e);

    const httpsServer = https.createServer({ cert: tlsCfg.cert, key: tlsCfg.key }, handler);
    httpsServer.once('error', onErr);
    httpsServer.on('tlsClientError', (err) => log('[tls] 握手失败 :' + httpsPort + ' ' + (err.code || err.reason || '') + ' ' + String(err.message || '').slice(0, 120)));
    httpsServer.listen(httpsPort, host, () => {
      httpsServer.removeAllListeners('error');
      onReady(httpsServer, httpsServer.address().port, 'https');
    });
  });
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, rt, admin, state, GEMINI_RE, handleHttp, startServer };
