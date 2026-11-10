'use strict';
const surface = require('./_surface');
/* 参数覆写 (paramOverride)
 * 网关自己的参数必须盖过 SDK 请求里的同名参数，而且两条路径都要生效：
 *   - 同方言直通（body 原样发，只改 model）
 *   - 跨方言转换（body 由 canonical 重建）
 * 另外钉住三件容易做坏的：
 *   1) 覆写只改发出去的副本，客户端 body 不被污染，重试换渠道时不会残留上一个渠道的覆写
 *   2) model / stream 由网关决定，覆写写了也不生效
 *   3) 实例级打底、渠道级优先
 * Run: node test/param_override_test.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');
const { buildRequestForChannel } = require('../sync.js');
const { normalizeOverride, mergeSpecs, applyOverride } = require('../override.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  x ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }
function chatBody(model) {
  return JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

/* ---------- 1. 归一化 / 合并语义 ---------- */
{
  eq(JSON.stringify(normalizeOverride('{"a":1}')), '{"a":1}', '归一化: JSON 文本被解析');
  eq(normalizeOverride({}), null, '归一化: 空对象 = 没有覆写');
  eq(normalizeOverride([]), null, '归一化: 数组不算覆写');
  eq(normalizeOverride('不是 JSON'), null, '归一化: 坏 JSON 被忽略');
  eq(normalizeOverride(null), null, '归一化: null = 没有覆写');

  const merged = mergeSpecs(
    { temperature: 0.5, thinking: { type: 'enabled', budget_tokens: 1024 } },
    { temperature: 0.7, thinking: { budget_tokens: 2048 } });
  eq(JSON.stringify(merged), JSON.stringify({ temperature: 0.7, thinking: { type: 'enabled', budget_tokens: 2048 } }),
    '合并: 渠道级覆盖同键, 嵌套对象逐键合并');

  const del = mergeSpecs({ max_tokens: 16, top_p: 0.9 }, { max_tokens: null });
  eq(del.max_tokens, null, '合并: null 删除标记被保留');
  const body = applyOverride({ max_tokens: 16, top_p: 0.9 }, del);
  ok(!('max_tokens' in body), '应用: null 删除参数');
  eq(body.top_p, 0.9, '应用: 未提到的参数保持原样');
}

/* ---------- 2. 同方言直通: 覆写盖过客户端 ---------- */
{
  const src = { model: 'alias', temperature: 0.2, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
  const ch = {
    name: 'oa', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k',
    paramOverride: { temperature: 1, max_tokens: null, stop: ['X'], metadata: { from: 'gateway' } },
  };
  const built = buildRequestForChannel({}, ch, 'openai', 'chat',
    { model: 'up-model', stream: false, messages: src.messages }, src, { model: 'up-model' }, { headers: {} });
  const out = JSON.parse(built.bodyBuf);
  eq(out.temperature, 1, '直通: temperature 被覆写盖过');
  ok(!('max_tokens' in out), '直通: max_tokens 被 null 删除');
  eq(JSON.stringify(out.stop), '["X"]', '直通: 数组整体替换');
  eq(out.metadata && out.metadata.from, 'gateway', '直通: 新增嵌套参数');
  eq(out.model, 'up-model', '直通: model 仍由网关决定');
  eq(src.temperature, 0.2, '直通: 客户端 body 未被改写');
  eq(src.max_tokens, 16, '直通: 客户端 body 的 max_tokens 未被删除');
}

/* ---------- 3. 跨方言转换: 覆写按上游方言落地 ---------- */
{
  const canon = { model: 'claude-real', stream: false, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, temperature: 0.2 };
  const ch = {
    name: 'oa2', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k',
    paramOverride: { temperature: 0.9, max_completion_tokens: 4096 },
  };
  const built = buildRequestForChannel({}, ch, 'claude', 'chat', canon, {}, { model: 'claude-real' }, { headers: {} });
  const out = JSON.parse(built.bodyBuf);
  eq(out.temperature, 0.9, '转换: 覆写作用在转换后的 openai body 上');
  eq(out.max_completion_tokens, 4096, '转换: 可写入转换层不认识的参数');
  ok(built.sameWire === false, '转换: 确实走了 canonical 转换路径');

  const gch = { name: 'gm', type: 'gemini', baseUrl: 'http://127.0.0.1:1', apiKey: 'k',
    paramOverride: { generationConfig: { temperature: 0.8, maxOutputTokens: 2048 } } };
  const gbuilt = buildRequestForChannel({}, gch, 'openai', 'chat',
    { model: 'gem-real', stream: false, messages: [{ role: 'user', content: 'hi' }] }, {}, { model: 'gem-real' }, { headers: {} });
  const gout = JSON.parse(gbuilt.bodyBuf);
  eq(gout.generationConfig && gout.generationConfig.temperature, 0.8, '转换: gemini 嵌套参数被覆写');
  eq(gout.generationConfig && gout.generationConfig.maxOutputTokens, 2048, '转换: gemini 新增 maxOutputTokens');
}

/* ---------- 4. 实例级打底, 渠道级优先 ---------- */
{
  const cfg = { paramOverride: { temperature: 0.5, top_p: 0.9, user: 'instance' } };
  const ch = { name: 'c', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', paramOverride: { temperature: 0.7 } };
  const out = JSON.parse(buildRequestForChannel(cfg, ch, 'openai', 'chat',
    { model: 'm', stream: false, messages: [] }, { model: 'm', stream: false, messages: [] }, { model: 'm' }, { headers: {} }).bodyBuf);
  eq(out.temperature, 0.7, '层级: 渠道级盖过实例级');
  eq(out.top_p, 0.9, '层级: 实例级的其它键仍然生效');
  eq(out.user, 'instance', '层级: 实例级参数注入到没有该参数的请求里');
}

/* ---------- 5. model / stream 受保护; 重试换渠道不残留 ---------- */
{
  const ch = { name: 'a', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k',
    paramOverride: { model: 'hacked', stream: true, temperature: 0.1, foo: 'bar' } };
  const src = { model: 'm', stream: false, messages: [] };
  const a = JSON.parse(buildRequestForChannel({}, ch, 'openai', 'chat',
    { model: 'real-model', stream: false, messages: [] }, src, { model: 'real-model' }, { headers: {} }).bodyBuf);
  eq(a.model, 'real-model', '保护: model 不被覆写');
  eq(a.stream, false, '保护: stream 不被覆写');

  // 第一个渠道失败后用同一个客户端 body 重试第二个渠道: 只应有第二个渠道的覆写
  const chB = { name: 'b', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', paramOverride: { top_p: 0.3 } };
  const b = JSON.parse(buildRequestForChannel({}, chB, 'openai', 'chat',
    { model: 'real-model', stream: false, messages: [] }, src, { model: 'real-model' }, { headers: {} }).bodyBuf);
  eq(b.top_p, 0.3, '重试: 新渠道的覆写生效');
  ok(!('foo' in b), '重试: 上一个渠道新增的覆写没有残留');
  eq(b.temperature, undefined, '重试: 上一个渠道改的 temperature 没有残留');
}

/* ---------- 6. 端到端: HTTP 请求到上游实际收到的 body ---------- */
(async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      hits.push(raw);
      let parsed = null; try { parsed = JSON.parse(raw); } catch (_) {}
      const text = chatBody(parsed && parsed.model || 'm');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-ov-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    paramOverride: { temperature: 0.6 },
    channels: [{
      name: 'ch', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'x', models: ['m'], default: true,
      paramOverride: { top_p: 0.5, metadata: { from: 'gateway' } },
    }],
  }));
  const cfg = G.loadConfig(cfgFile);
  surface.set(cfg);
  eq(JSON.stringify(cfg.paramOverride), '{"temperature":0.6}', '配置加载: 实例级 paramOverride 保留');
  eq(JSON.stringify(cfg.channels[0].paramOverride), '{"top_p":0.5,"metadata":{"from":"gateway"}}', '配置加载: 渠道级 paramOverride 保留');

  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const post = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: surface.spath(route), method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });

  const r1 = await post('/v1/chat/completions', JSON.stringify({
    model: 'm', temperature: 0.01, top_p: 0.99, max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }],
  }));
  eq(r1.status, 200, 'e2e: 请求成功');
  const sent = JSON.parse(hits[hits.length - 1]);
  eq(sent.temperature, 0.6, 'e2e: 实例级覆写盖过 SDK 的 temperature');
  eq(sent.top_p, 0.5, 'e2e: 渠道级覆写盖过 SDK 的 top_p');
  eq(sent.max_tokens, 32, 'e2e: 没被覆写的参数原样送达');
  eq(sent.metadata && sent.metadata.from, 'gateway', 'e2e: 覆写新增的参数送达');
  eq(sent.model, 'm', 'e2e: 模型名不受覆写影响');

  const r2 = await post('/v1/chat/completions', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
  eq(r2.status, 200, 'e2e: 未带参数的请求成功');
  const sent2 = JSON.parse(hits[hits.length - 1]);
  eq(sent2.temperature, 0.6, 'e2e: SDK 没传的参数也会被覆写注入');
  eq(sent2.top_p, 0.5, 'e2e: 渠道级参数同样注入');

  /* ---------- 7. 管理 API: 面板保存的三态(省略=沿用 / 空=清除 / 对象=设置) ---------- */
  {
    const adminMod = require('../admin.js');
    const panelAuth = require('../panel-auth.js');
    adminMod.setDir(dir);
    adminMod.setPool({ reload() {} });          // 假的 pool: 让保存走 hotReload 而不是重启进程
    const token = panelAuth.read(cfg, 'default').adminToken;
    const fakeRes = () => ({ status: 0, body: '', writeHead(st) { this.status = st; }, end(b) { this.body = String(b || ''); },
      json() { try { return JSON.parse(this.body); } catch (_) { return null; } } });
    const post = async (p, body) => {
      const res = fakeRes();
      await adminMod.handleAdmin(cfg, { method: 'POST', headers: { 'x-agw-token': token }, on() {} }, res,
        new URL('http://x/admin/api/' + p), '/admin/api/' + p, body);
      return res;
    };
    const get = async (p) => {
      const res = fakeRes();
      await adminMod.handleAdmin(cfg, { method: 'GET', headers: { 'x-agw-token': token }, on() {} }, res,
        new URL('http://x/admin/api/' + p), '/admin/api/' + p, '');
      return res;
    };
    const disk = () => G.loadConfig(cfgFile);

    let r = await post('config/default', JSON.stringify({ paramOverride: { user: 'gw', temperature: 0.4 } }));
    eq(r.status, 200, 'admin: 实例级覆写保存 200');
    eq(JSON.stringify(disk().paramOverride), '{"user":"gw","temperature":0.4}', 'admin: 实例级覆写落盘');
    let got = (await get('config/default')).json();
    eq(JSON.stringify(got && got.paramOverride), '{"user":"gw","temperature":0.4}', 'admin: 面板读回实例级覆写');

    r = await post('config/default', JSON.stringify({ paramOverride: {} }));
    eq(r.status, 200, 'admin: 清空实例级覆写 200');
    eq(disk().paramOverride, null, 'admin: 空对象 = 清除实例级覆写(落盘无键, 读回来是 null)');

    r = await post('channel/default', JSON.stringify({ name: 'ch', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, models: ['m'], paramOverride: { temperature: 1, top_p: null } }));
    eq(r.status, 200, 'admin: 渠道覆写保存 200');
    eq(JSON.stringify(disk().channels[0].paramOverride), '{"temperature":1,"top_p":null}', 'admin: 渠道覆写落盘');
    got = (await get('config/default')).json();
    eq(JSON.stringify(got && got.channels && got.channels[0].paramOverride), '{"temperature":1,"top_p":null}', 'admin: 面板读回渠道覆写');
    ok(got && got.channels[0].hasKey === false || got.channels[0].apiKey === undefined, 'admin: 新增字段不泄漏 apiKey');

    r = await post('channel/default', JSON.stringify({ name: 'ch', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, models: ['m'] }));
    eq(JSON.stringify(disk().channels[0].paramOverride), '{"temperature":1,"top_p":null}', 'admin: 省略 paramOverride = 沿用旧值');

    r = await post('channel/default', JSON.stringify({ name: 'ch', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, models: ['m'], paramOverride: '' }));
    eq(disk().channels[0].paramOverride, null, 'admin: 空串 = 清除渠道覆写(落盘无键, 读回来是 null)');

    r = await post('channel/default', JSON.stringify({ name: 'ch', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, models: ['m'], paramOverride: [1, 2] }));
    eq(r.status, 400, 'admin: 数组不是合法覆写 → 400');
  }
  await new Promise(r => started.server.close(r));
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nparam override test: ${pass} passed, ${fail} failed`);
  if (fail) { console.error(failures.join('\n')); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; });
