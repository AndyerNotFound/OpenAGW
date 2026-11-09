'use strict';
/* Endpoint completion: a base URL that stops at the host (no /v1) reaches the same endpoints.
 * Coverage: (1) completePath unit matrix — exact / prefix / idempotent / trailing slash
 *           (2) closed prefixes are NOT completed (/health /balance /dashboard/... stay 404)
 *           (3) real HTTP, single instance: bare paths route to the same handlers
 *           (4) real HTTP, multi-instance: /<inst>/chat/completions completes after the prefix is
 *               stripped, a bare path with no such instance falls through to default,
 *               and an instance name that really exists still wins
 * Run: node test/endpoint_completion_test.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');
const { completePath } = require('../endpoints.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got=' + JSON.stringify(a) + ', want=' + JSON.stringify(b) + ')'); }

/* ---------- (1) unit: completePath ---------- */
eq(completePath('/chat/completions'), '/v1/chat/completions', 'unit: /chat/completions → /v1/chat/completions');
eq(completePath('/completions'), '/v1/completions', 'unit: legacy /completions');
eq(completePath('/messages'), '/v1/messages', 'unit: Claude /messages');
eq(completePath('/responses'), '/v1/responses', 'unit: /responses');
eq(completePath('/models'), '/v1/models', 'unit: /models');
eq(completePath('/models/'), '/v1/models', 'unit: 尾斜杠 /models/ 也补全');
eq(completePath('/models/gemini-2.5-pro:generateContent'), '/v1/models/gemini-2.5-pro:generateContent', 'unit: Gemini 裸 /models/{model}:generateContent');
eq(completePath('/images/generations'), '/v1/images/generations', 'unit: /images/generations');
eq(completePath('/audio/speech'), '/v1/audio/speech', 'unit: /audio/speech');
eq(completePath('/files/abc'), '/v1/files/abc', 'unit: 子路径 /files/abc');
eq(completePath('/batches'), '/v1/batches', 'unit: /batches');
eq(completePath('/messages/count_tokens'), '/v1/messages/count_tokens', 'unit: /messages/count_tokens');
eq(completePath('/v1/chat/completions'), '/v1/chat/completions', 'unit: 已带 /v1 幂等');
eq(completePath('/v1beta/models/x:generateContent'), '/v1beta/models/x:generateContent', 'unit: /v1beta 原样');
eq(completePath('/v1/models'), '/v1/models', 'unit: /v1/models 原样');
/* base URL 已带 /v1 + 客户端又拼了一层版本号 → 折叠重复段 */
eq(completePath('/v1/v1/chat/completions'), '/v1/chat/completions', 'unit: /v1/v1/chat/completions 折叠');
eq(completePath('/v1/v1/v1/models'), '/v1/models', 'unit: 三层 /v1 也折叠');
eq(completePath('/v1beta/v1beta/models/x:generateContent'), '/v1beta/models/x:generateContent', 'unit: /v1beta 重复折叠');
eq(completePath('/v1beta/models/x:generateContent'), '/v1beta/models/x:generateContent', 'unit: 单层 /v1beta 不动');
eq(completePath('/v1/v1beta/models/x:generateContent'), '/v1/v1beta/models/x:generateContent', 'unit: 不同版本前缀不折叠');
eq(completePath('/v1/v1/health'), '/v1/v1/health', 'unit: 折叠只针对已知端点(/v1/v1/health 原样透传)');
eq(completePath('/v1/v1/dashboard/billing/credit_grants'), '/v1/v1/dashboard/billing/credit_grants', 'unit: 折叠不碰余额路径');
eq(completePath('/v1/models/'), '/v1/models', 'unit: 带前缀的尾斜杠也去掉');
eq(completePath('/chat/completions/'), '/v1/chat/completions', 'unit: 裸路径尾斜杠 + 补全');
eq(completePath('/v1//models'), '/v1/models', 'unit: 重复斜杠折叠为已知端点');
eq(completePath('//v1/models'), '/v1/models', 'unit: 双前导斜杠折叠');
eq(completePath('/v1//health'), '/v1//health', 'unit: 重复斜杠不碰非端点路径');
eq(completePath('/evals'), '/v1/evals', 'unit: /evals');
eq(completePath('/v1/v1/branches'), '/v1/branches', 'unit: 网关自有 /branches 也折叠');
eq(completePath('/v1/v1/models/'), '/v1/models', 'unit: 折叠 + 尾斜杠同时归一');
eq(completePath('/v1/v1/completionz'), '/v1/v1/completionz', 'unit: 非端点不折叠');
eq(completePath('/evals/runs/1'), '/v1/evals/runs/1', 'unit: /evals 子路径');
eq(completePath('/containers/abc'), '/v1/containers/abc', 'unit: /containers 子路径');
/* ---------- (2) closed prefixes are never completed ---------- */
for (const p of ['/health', '/status', '/auth/login', '/admin', '/plugins', '/api/app/bootstrap',
  '/balance', '/credits', '/dashboard/billing/credit_grants', '/user/balance', '/chat/completionz', '/', '']) {
  eq(completePath(p), p, 'unit: 不改写 ' + (p || '(空)'));
}

/* ---------- (2b) one shared name vocabulary for panel and router ---------- */
{
  const paths = require('../paths.js');
  const poolMod = require('../pool.js');
  const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok(poolMod.RESERVED_PATHS === paths.RESERVED_PATHS, 'names: pool 与 paths 共用同一个保留字集合');
  ok(!/const RESERVED_PATHS = new Set\(/.test(adminSrc), 'names: admin 不再自带一份保留字表(已改为 import)');
  for (const n of ['credits', 'auth', 'plugins', 'user', 'api', 'profile']) {
    ok(paths.RESERVED_PATHS.has(n), 'names: 保留字包含 ' + n);
  }
  for (const n of ['chat', 'models', 'images']) {
    ok(!paths.RESERVED_PATHS.has(n), 'names: 端点首段 ' + n + ' 不算保留字(交给 isEndpointHead 管)');
  }
  ok(paths.isPanelPath('/admin') && paths.isPanelPath('/admin/api/x') && paths.isPanelPath('/auth/s/t'), 'names: 面板路径判定');
  ok(paths.RESERVED_PATHS.has('credits'), 'names: 保留字含 credits(主端口不可路由, 只能走实例端口)');
  ok(!paths.isPanelPath('/v1/models') && !paths.isPanelPath('/chat/completions'), 'names: API 路径不是面板路径');
  const heads = [...paths.RESERVED_PATHS].filter(n => require('../endpoints.js').isEndpointHead(n));
  eq(heads.length, 0, 'names: 保留字与端点首段不重叠');
}

/* ---------- (2c) invariants: what completion may and may not do ---------- */
{
  const closed = ['/health', '/status', '/balance', '/credits', '/quota', '/usage', '/wallet',
    '/user/balance', '/dashboard/billing/credit_grants', '/dashboard/billing/subscription', '/admin', '/auth/login'];
  let bad = 0;
  for (const base of closed) {
    for (const v of [base, base + '/', '/v1' + base, '/v1/v1' + base, '/' + base.slice(1).replace('/', '//')]) {
      if (completePath(v) !== v) { bad++; console.error('    改写越界: ' + v + ' → ' + completePath(v)); }
    }
  }
  eq(bad, 0, 'invariant: 关闭前缀的任何变体都不被改写');
  const { isKnownEndpoint } = require('../endpoints.js');
  let stray = 0;
  for (const p of ['/chat/completions', '/models', '/messages', '/images/generations', '/files/x',
    '/v1/v1/models', '/v1//models', '/models/', '/evals', '/containers/a', '/v1/v1/chat/completions']) {
    const q = completePath(p);
    if (q !== p && !isKnownEndpoint(q)) { stray++; console.error('    改写落到非端点: ' + p + ' → ' + q); }
    if (completePath(q) !== q) { stray++; console.error('    改写不幂等: ' + p + ' → ' + q + ' → ' + completePath(q)); }
    if (q !== p && !/^\/v1(?:beta|alpha)?\//.test(q)) { stray++; console.error('    改写落到 /v1 之外: ' + p + ' → ' + q); }
  }
  eq(stray, 0, 'invariant: 改写必为已知端点、幂等、且落在 /v1* 之下');
}

/* ---------- shared helpers ---------- */
function fakeUpstream() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw });
      let out;
      if (req.url.indexOf('/images/') >= 0 || req.url.indexOf('/files') >= 0) out = JSON.stringify({ data: [{ url: 'x' }], object: 'list' });
      else out = JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
      res.end(out);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, hits, port: srv.address().port })));
}
function req(port, p, method = 'POST', body = null) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' } }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function freePort() {
  return new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

(async () => {
  const up = await fakeUpstream();
  const chatBody = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

/* ---------- (3) single instance over real HTTP ---------- */
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-ep1-'));
  const f1 = path.join(dir1, 'config.json');
  fs.writeFileSync(f1, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false },
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + up.port, apiKey: 'x', models: ['m'], default: true }],
  }));
  const cfg1 = G.loadConfig(f1);
  const s1 = await G.startServer(cfg1, { host: '127.0.0.1', port: 0, multi: false });
  const p1 = s1.port;

  const a1 = await req(p1, '/chat/completions', 'POST', chatBody);
  eq(a1.status, 200, 'http: 裸 /chat/completions 200');
  eq(up.hits[up.hits.length - 1].url, '/v1/chat/completions', 'http: 上游收到 /v1/chat/completions');
  ok(/"content":"ok"/.test(a1.body), 'http: 裸 /chat/completions 返回 chat 体');

  const a2 = await req(p1, '/v1/chat/completions', 'POST', chatBody);
  eq(a2.status, 200, 'http: 带 /v1 仍然 200(未回归)');
  eq(up.hits[up.hits.length - 1].url, '/v1/chat/completions', 'http: 带 /v1 上游路径不变');

  const a3 = await req(p1, '/messages', 'POST', JSON.stringify({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }));
  eq(a3.status, 200, 'http: 裸 /messages 200(Claude 方言)');
  const a3j = (() => { try { return JSON.parse(a3.body); } catch (_) { return null; } })();
  ok(a3j && a3j.type === 'message', 'http: 裸 /messages 返回 Claude 体(type=message)');

  const a4 = await req(p1, '/models', 'GET');
  eq(a4.status, 200, 'http: 裸 /models 200');
  const a4j = (() => { try { return JSON.parse(a4.body); } catch (_) { return null; } })();
  ok(a4j && a4j.object === 'list' && a4j.data.some(m => m.id === 'm'), 'http: 裸 /models 列出模型');

  const a5 = await req(p1, '/models/', 'GET');
  eq(a5.status, 200, 'http: 尾斜杠 /models/ 200');

  const a6 = await req(p1, '/images/generations?x=1', 'POST', JSON.stringify({ model: 'm', prompt: 'p' }));
  eq(a6.status, 200, 'http: 裸 /images/generations 200');
  eq(up.hits[up.hits.length - 1].url, '/v1/images/generations?x=1', 'http: 裸扩展端点透传 path+query(补 /v1)');

  const aGem = await req(p1, '/models/gemini-2.5-pro:generateContent', 'POST', JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }));
  eq(aGem.status, 200, 'http: 裸 Gemini /models/{model}:generateContent 200');
  const aGemJ = (() => { try { return JSON.parse(aGem.body); } catch (_) { return null; } })();
  ok(aGemJ && Array.isArray(aGemJ.candidates), 'http: 裸 Gemini 路径返回 Gemini 体(candidates)');

  const aOpt = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p1, path: '/chat/completions', method: 'OPTIONS', headers: { Origin: 'http://x', 'Access-Control-Request-Method': 'POST' } }, res => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject); r.end();
  });
  eq(aOpt, 204, 'http: 裸路径的 CORS 预检 204');

  const aDup = await req(p1, '/v1/v1/chat/completions', 'POST', chatBody);
  eq(aDup.status, 200, 'http: 重复 /v1/v1/chat/completions 折叠后 200');
  eq(up.hits[up.hits.length - 1].url, '/v1/chat/completions', 'http: 重复段折叠后上游收到单层 /v1');

  const a7 = await req(p1, '/files/abc', 'GET');
  eq(a7.status, 200, 'http: 裸 /files/abc 200');
  eq(up.hits[up.hits.length - 1].url, '/v1/files/abc', 'http: 裸子路径 /files/abc → /v1/files/abc');

  const aEv = await req(p1, '/evals', 'GET');
  eq(aEv.status, 200, 'http: 裸 /evals 200(新增端点)');
  eq(up.hits[up.hits.length - 1].url, '/v1/evals', 'http: 裸 /evals 上游收到 /v1/evals');

  const aPass = await req(p1, '/v1/v1/health', 'GET');
  ok(aPass.status !== undefined, 'http: /v1/v1/health 仍走透传(不改写)');
  eq(up.hits[up.hits.length - 1].url, '/v1/v1/health', 'http: /v1/v1/health 上游原样收到(折叠不越权)');

  for (const p of ['/health', '/status', '/balance', '/dashboard/billing/credit_grants', '/chat/completionz']) {
    const r = await req(p1, p, 'GET');
    eq(r.status, 404, 'http: 补全不放开 ' + p + ' (仍 404)');
  }
  const rHealthPost = await req(p1, '/health', 'POST', '{}');
  eq(rHealthPost.status, 404, 'http: 补全不放开 POST /health (仍 404)');

  await new Promise(r => s1.server.close(r));

/* ---------- (3b) key cards: completion must not bypass auth ---------- */
  const dir1b = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-ep1b-'));
  const f1b = path.join(dir1b, 'config.json');
  fs.writeFileSync(f1b, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false },
    apiKeys: [{ key: 'sk-good', name: 'good' }],
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + up.port, apiKey: 'x', models: ['m'], default: true }],
  }));
  const cfg1b = G.loadConfig(f1b);
  const s1b = await G.startServer(cfg1b, { host: '127.0.0.1', port: 0, multi: false });
  const p1b = s1b.port;
  const anon = (p, m = 'POST', b = chatBody) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p1b, path: p, method: m, headers: { 'Content-Type': 'application/json' } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject); if (b) r.write(b); r.end();
  });
  eq((await anon('/chat/completions')).status, 401, 'auth: 裸 /chat/completions 无 key 401');
  eq((await anon('/models', 'GET', null)).status, 401, 'auth: 裸 /models 无 key 401');
  eq((await anon('/images/generations')).status, 401, 'auth: 裸 /images/generations 无 key 401');
  const wrong = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p1b, path: '/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-bad' } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.on('error', reject); r.write(chatBody); r.end();
  });
  eq(wrong.status, 401, 'auth: 裸 /chat/completions 错 key 401');
  const good = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p1b, path: '/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-good' } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.on('error', reject); r.write(chatBody); r.end();
  });
  eq(good.status, 200, 'auth: 裸 /chat/completions 对 key 200');
  await new Promise(r => s1b.server.close(r));

/* ---------- (4) multi-instance over real HTTP ---------- */
  const mainPort = await freePort();
  const instPort = await freePort();
  const chatPort = await freePort();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-ep2-'));
  const chans = [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + up.port, apiKey: 'x', models: ['m'], default: true }];
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: mainPort }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false }, channels: chans,
  }));
  fs.writeFileSync(path.join(dir2, 'config.second.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: instPort }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false }, channels: chans,
  }));
  fs.writeFileSync(path.join(dir2, 'config.example.json'), '{}');
  const cfg2 = G.loadConfig(path.join(dir2, 'config.json'));
  const s2 = await G.startServer(cfg2, { host: '127.0.0.1', multi: true });

  const b1 = await req(mainPort, '/second/chat/completions', 'POST', chatBody);
  eq(b1.status, 200, 'multi: /second/chat/completions 200(实例前缀 + 补全)');
  eq(up.hits[up.hits.length - 1].url, '/v1/chat/completions', 'multi: 实例前缀剥离后补 /v1');

  const b2 = await req(mainPort, '/second/v1/chat/completions', 'POST', chatBody);
  eq(b2.status, 200, 'multi: /second/v1/chat/completions 仍 200(未回归)');

  const b3 = await req(mainPort, '/chat/completions', 'POST', chatBody);
  eq(b3.status, 200, 'multi: 主端口裸 /chat/completions 落到 default 实例');
  eq(up.hits[up.hits.length - 1].url, '/v1/chat/completions', 'multi: default 实例补 /v1');

  const b4 = await req(mainPort, '/models', 'GET');
  eq(b4.status, 200, 'multi: 主端口裸 /models 200');

  const b5 = await req(mainPort, '/nosuchinst/whatever', 'POST', '{}');
  eq(b5.status, 404, 'multi: 不存在的实例名 + 不可补全路径 404');
  ok(/未知实例/.test(b5.body), 'multi: 404 仍是「未知实例」');
  const b6 = await req(mainPort, '/nosuchinst/chat/completions', 'POST', chatBody);
  eq(b6.status, 404, 'multi: 未知实例前缀不做补全(错误保持可见, 不静默改走 default)');

// (5) an instance literally named after an endpoint segment: the explicit prefix still wins
  fs.writeFileSync(path.join(dir2, 'config.chat.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: chatPort }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false }, channels: chans,
  }));
  s2.pool.reload('chat');
  const c1 = await req(mainPort, '/chat/completions', 'POST', JSON.stringify({ model: 'm', prompt: 'legacy' }));
  eq(c1.status, 200, 'multi: 实例名 chat 优先于补全(POST /chat/completions 进 chat 实例)');
  eq(up.hits[up.hits.length - 1].url, '/v1/completions', 'multi: chat 实例收到 /completions, 再补成 /v1/completions');
  const c2 = await req(mainPort, '/chat/v1/chat/completions', 'POST', chatBody);
  eq(c2.status, 200, 'multi: /chat/v1/chat/completions 仍 200(实例路径未回归)');

// (5b) the panel refuses to name an instance after an endpoint or a reserved path
  {
    const panelAuth = require('../panel-auth.js');
    const tok = panelAuth.read(s2.pool.instances.get('default'), 'default').adminToken;
    const post = (p, body) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: mainPort, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agw-token': tok } }, res => {
        let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out }));
      });
      r.on('error', reject); r.write(body); r.end();
    });
    const mk = await post('/admin/api/instance-create/chat', JSON.stringify({ port: await freePort() }));
    eq(mk.status, 400, 'admin: instance-create/chat 被拒(端点首段同名)');
    ok(/端点首段同名/.test(mk.body), 'admin: 拒绝文案说明原因');
    const mk2 = await post('/admin/api/instance-create/credits', JSON.stringify({ port: await freePort() }));
    eq(mk2.status, 400, 'admin: instance-create/credits 被拒(保留字, 主端口无法路由)');
    const rn = await post('/admin/api/instance-rename/second', JSON.stringify({ newName: 'models' }));
    eq(rn.status, 400, 'admin: instance-rename 改成 models 被拒');
  }

// (6) the instance's own compat port (via:'port') completes too
  const d1 = await req(instPort, '/chat/completions', 'POST', chatBody);
  eq(d1.status, 200, 'multi/port: 实例兼容端口裸 /chat/completions 200');
  eq(up.hits[up.hits.length - 1].url, '/v1/chat/completions', 'multi/port: 补全后上游 /v1/chat/completions');
  const d2 = await req(instPort, '/health', 'GET');
  eq(d2.status, 404, 'multi/port: 关闭前缀仍 404');

// (7) a disabled default instance stays disabled on the unprefixed path
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-ep3-'));
  const offPort = await freePort();
  fs.writeFileSync(path.join(dir3, 'config.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: offPort }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false }, disabled: true, channels: chans,
  }));
  fs.writeFileSync(path.join(dir3, 'config.example.json'), '{}');
  const cfg3 = G.loadConfig(path.join(dir3, 'config.json'));
  const s3 = await G.startServer(cfg3, { host: '127.0.0.1', multi: true });
  eq((await req(offPort, '/models', 'GET')).status, 503, 'multi: 停用实例的裸 /models 503');
  eq((await req(offPort, '/v1/models', 'GET')).status, 503, 'multi: 停用实例的 /v1/models 同样 503(一致)');
  eq((await req(offPort, '/chat/completions', 'POST', chatBody)).status, 503, 'multi: 停用实例的裸 /chat/completions 503');
// stopping an instance must not also take away the panel that starts it again
  const offAdmin = await req(offPort, '/admin', 'GET');
  ok(offAdmin.status !== 503, 'multi: 停用实例的 /admin 仍可达(不是 503, 实际 ' + offAdmin.status + ')');
  const offAuth = await req(offPort, '/auth', 'GET');
  ok(offAuth.status !== 503, 'multi: 停用实例的 /auth 仍可达(不是 503, 实际 ' + offAuth.status + ')');
  eq((await req(offPort, '/admin/api/instances', 'GET')).status, 401, 'multi: 停用实例的面板 API 仍返回 401(要认证, 不是 503)');
  for (const [, v] of s3.pool.servers) { try { v.server.close(); } catch (_) {} }
  fs.rmSync(dir3, { recursive: true, force: true });

  for (const [, v] of s2.pool.servers) { try { v.server.close(); } catch (_) {} }
  up.srv.close();
  fs.rmSync(dir1, { recursive: true, force: true });
  fs.rmSync(dir1b, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });

  console.log(`\nendpoint completion test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
