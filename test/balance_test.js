'use strict';
/* Channel balance passthrough test
 * Coverage: (1) target resolution (channel overrides / built-in presets)  (2) the runtime whitelist no longer drops balance* fields (otherwise persistRuntimeCfg would wipe them from the config)
 *       (3) fetchChannelBalance (relative URL joining / no preset / bad path / channel proxy)
 *       (4) client endpoints /v1/dashboard/billing/{credit_grants,subscription} (auth / channel pick / card whitelist / cache)
 *       (5) admin /admin/api/balance/:inst/:ch + "panel channel saves never wipe balance fields"
 * Run: node test/balance_test.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');
const { utf8 } = require('../util.js');
const u8 = utf8();
const adminMod = require('../admin.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, res => {
      let raw = '';
      res.on('data', c => raw += u8(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, raw, json: j }); });
    });
    req.on('error', reject);
    req.end();
  });
}

// Fake upstream: the two balance endpoints of an OpenAI-compatible relay + request counting
function fakeUpstream() {
  return new Promise(resolve => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push(req.url);
      const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/v1/user/info')) return send({ data: { balance: '42.50', currency: 'CNY' } });
      if (req.url.startsWith('/user/balance')) return send({ balance_infos: [{ currency: 'CNY', total_balance: '88.80' }] });
      if (req.url.startsWith('/v2/user/info')) return send({ data: { balance: '10' } }); // USD 口径(供汇率折算用例)
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown ' + req.url } }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, hits, close: () => srv.close() }));
  });
}

function fakeRes() {
  const o = { status: 0, headers: null, body: '', headersSent: false, ended: false };
  o.writeHead = (s, h) => { o.status = s; o.headers = h || {}; o.headersSent = true; };
  o.write = (c) => { o.body += c; };
  o.end = (c) => { if (c) o.body += c; o.ended = true; o.headersSent = true; };
  o.destroy = () => {};
  o.json = () => { try { return JSON.parse(o.body); } catch (_) { return null; } };
  return o;
}
const fakeReq = () => ({ method: 'GET', headers: { 'x-agw-token': 'test-admin' }, on() {}, destroy() {} });
// handleAdmin's balance branch is callback-style (the response is written only after the upstream query) -> tests must wait for the response to land before asserting
async function waitRes(res, ms = 4000) {
  const t0 = Date.now();
  while (!res.status && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  return res;
}

// Reads config with the same semantics as admin.js loadCfg (may be encrypted)
function readCfg(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let plain = raw;
  try { const c = require('../crypt.js'); if (c.isEncText(raw)) plain = c.decryptText(raw, c.loadPass()); } catch (_) {}
  return JSON.parse(plain);
}

(async () => {
/* ============ 1. Target resolution ============ */
  console.log('── Part 1: 余额目标解析 ──');
  const t1 = G.balanceTarget({ name: 'x', type: 'openai', baseUrl: 'https://api.deepseek.com' });
  eq(t1 && t1.url, '/user/balance', '预设: deepseek 命中 baseUrl');
  eq(t1 && t1.path, 'balance_infos.0.total_balance', '预设: deepseek 取值路径');
  eq(t1 && t1.unit, 'CNY', '预设: deepseek 单位');
  const t2 = G.balanceTarget({ name: 'any', type: 'openai', baseUrl: 'https://my-relay.example.com', balanceUrl: '/v1/user/info', balancePath: 'data.balance', balanceUnit: 'USD' });
  eq(t2.url, '/v1/user/info', '渠道级 balanceUrl 覆盖预设');
  eq(t2.unit, 'USD', '渠道级 balanceUnit 覆盖预设');
  eq(G.balanceTarget({ name: 'any', type: 'openai', baseUrl: 'https://my-relay.example.com' }), null, '无预设无覆盖 → null');
  const sf = G.balanceTarget({ name: 'sf', type: 'openai', baseUrl: 'https://api.siliconflow.cn' });
  eq(sf && sf.unit, 'CNY', '预设: siliconflow.cn → CNY');

/* ============ 2. Runtime whitelist preserves balance* fields ============ */
  console.log('── Part 2: 运行态渠道字段白名单 ──');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-balance-'));
  const tmpCfg = path.join(tmpDir, 'config.json');
  const up = await fakeUpstream();
  fs.writeFileSync(tmpCfg, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '',
    webToken: 'test-admin',
    proxies: { dead: { type: 'socks5', host: '127.0.0.1', port: 1 } },
    apiKeys: [
      { key: 'sk-card-all', name: '无绑定', enable: true, quotaTokens: 0, usedTokens: 0 },
      { key: 'sk-card-one', name: '绑定一个', enable: true, quotaTokens: 0, usedTokens: 0, channels: ['relay-custom'] },
    ],
    channels: [
      { name: 'relay-plain', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'sk-up', models: ['m1'] },
      { name: 'relay-custom', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'sk-up', default: true, models: ['m2'], balanceUrl: '/v1/user/info', balancePath: 'data.balance', balanceUnit: 'CNY' },
      { name: 'relay-proxy', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'sk-up', models: ['m3'], proxy: 'dead', balanceUrl: '/v1/user/info', balancePath: 'data.balance' },
      { name: 'deepseek-alike', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'sk-up', models: ['m4'] },
      { name: 'usd-relay', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'sk-up', models: ['m5'], balanceUrl: '/v2/user/info', balancePath: 'data.balance', balanceUnit: 'USD' },
    ],
  }, null, 1));
  const lc = G.loadConfig(tmpCfg);
  const lcCustom = lc.channels.find(c => c.name === 'relay-custom');
  eq(lcCustom.balanceUrl, '/v1/user/info', 'loadConfig 白名单保留 balanceUrl');
  eq(lcCustom.balancePath, 'data.balance', 'loadConfig 白名单保留 balancePath');
  eq(lcCustom.balanceUnit, 'CNY', 'loadConfig 白名单保留 balanceUnit');
  eq(lc.channels.find(c => c.name === 'deepseek-alike').balanceUrl, null, '未配 → null(不伪造)');

  /* ============ 3. fetchChannelBalance ============ */
  console.log('── Part 3: fetchChannelBalance ──');
  const call = (cfg, ch) => new Promise(r => G.fetchChannelBalance(cfg, ch, r));
  const rRel = await call(lc, lcCustom);
  ok(rRel.ok, '相对 balanceUrl 拼接 baseUrl 成功(旧实现直接 new URL → 500)');
  eq(String(rRel.balance), '42.50', '取值正确');
  eq(rRel.url, `http://127.0.0.1:${up.port}/v1/user/info`, '地址拼接口径');
  const rPreset = await call(lc, lc.channels.find(c => c.name === 'deepseek-alike'));
  eq(String(rPreset.balance), '88.80', '按渠道名命中的预设(相对地址)可用');
  const rNone = await call(lc, lc.channels.find(c => c.name === 'relay-plain'));
  eq(rNone.status, 400, '无预设无覆盖 → 400');
  const rProxy = await call(lc, lc.channels.find(c => c.name === 'relay-proxy'));
  eq(rProxy.status, 502, '必须走代理的渠道: 死代理 → 502(证明不再绕过 proxy)');
  const rBadPath = await call(lc, Object.assign({}, lcCustom, { balancePath: 'nope.deep' }));
  eq(rBadPath.status, 502, '取值路径不存在 → 502');
  const rBadUrl = await call(lc, Object.assign({}, lcCustom, { balanceUrl: 'http://:/bad' }));
  eq(rBadUrl.status, 400, '地址非法 → 400(旧实现 500 Invalid URL)');

/* ============ 4. Client endpoints (OpenAI semantics) ============ */
  console.log('── Part 4: /v1/dashboard/billing/* ──');
  const cfgE2E = readCfg(tmpCfg);
  cfgE2E._configFile = tmpCfg;
  const gw = await G.startServer(cfgE2E, { port: 0 });
  const port = gw.port;
  const H = { Authorization: 'Bearer sk-card-all' };
  const hitsBefore = up.hits.length;
  const rGrants = await get(port, '/v1/dashboard/billing/credit_grants?ch=relay-custom', H);
  eq(rGrants.status, 200, 'credit_grants 200');
  eq(rGrants.json && rGrants.json.object, 'credit_summary', 'credit_grants object 名');
  eq(rGrants.json && rGrants.json.total_available, 42.5, 'credit_grants total_available=上游余额');
  eq(rGrants.json && rGrants.json.unit, 'CNY', 'credit_grants 附带单位');
  const rSub = await get(port, '/dashboard/billing/subscription?ch=relay-custom', H); // 不带 /v1 前缀
  eq(rSub.status, 404, '白名单外别名 /dashboard/billing/* 已关闭(404)');
  const rSub2 = await get(port, '/v1/dashboard/billing/subscription?ch=deepseek-alike', H);
  eq(rSub2.status, 200, '带 /v1 前缀同样可用');
  const rAuto = await get(port, '/v1/dashboard/billing/credit_grants', H);
  eq(rAuto.status, 200, '不传 ?ch= → 自动选(default 渠道)');
  eq(rAuto.json && rAuto.json.channel, 'relay-custom', '自动选的渠道名(附在响应里)');
// Common aliases (one-api/new-api/relay panels): all should hit the balance lookup
  for (const alias of ['/v1/balance', '/v1/user/balance', '/v1/quota', '/v1/billing/usage', '/v1/usage', '/v1/wallet']) {
    const ra = await get(port, alias + '?ch=relay-custom', H);
    eq(ra.status, 200, '余额别名 ' + alias + ' 200');
  }
  // whitelist keeps only /v1 /v1beta /auth /profile /admin -> legacy non-/v1 aliases all 404
  for (const alias of ['/balance', '/user/balance', '/dashboard/billing/usage']) {
    const rb = await get(port, alias + '?ch=relay-custom', H);
    eq(rb.status, 404, '白名单外别名 ' + alias + ' 404');
  }
// The "balance path=/credits + JSON key=total_remain" case (base includes /v1 -> actually requests /v1/credits)
  const rV1Credits = await get(port, '/v1/credits?ch=relay-custom', H);
  eq(rV1Credits.status, 200, '/v1/credits 200(原为 404: 未路由)');
  eq(rV1Credits.json && rV1Credits.json.total_remain, 42.5, '/v1/credits 顶层 total_remain = 上游余额');
  eq(rV1Credits.json && rV1Credits.json.data && rV1Credits.json.data.total_remain, 42.5, '/v1/credits data.total_remain(嵌套键客户端)');
  eq(rV1Credits.json && rV1Credits.json.balance, '42.50', '/v1/credits 保留 balance 原值');
  const rV1CreditsAuto = await get(port, '/v1/credits', H);
  eq(rV1CreditsAuto.status, 200, '/v1/credits 不传 ch 也 200');

/* ============ 4b. Multi-channel aggregation + FX conversion ============ */
  console.log('── Part 4b: 多渠道聚合(汇率统一单位) ──');
  const near = (a, b, msg) => ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, msg + ' (got=' + a + ', want=' + b + ')');
  // no USD FX rate: only CNY channels are summed; USD channels tagged no_rate
  const agg1 = await get(port, '/v1/credits', H);
  eq(agg1.status, 200, '聚合: 200');
  eq(agg1.json && agg1.json.unit, 'CNY', '聚合: 默认基准币种 CNY');
  eq(agg1.json && agg1.json.channels && agg1.json.channels.length, 5, '聚合: 明细含全部 5 个可见渠道');
  near(agg1.json && agg1.json.total_remain, 131.3, '聚合: 未配 USD 汇率 → 只加总 CNY(42.5+88.8)');
  const usdItem = agg1.json && agg1.json.channels && agg1.json.channels.find(c => c.channel === 'usd-relay');
  ok(usdItem && usdItem.no_rate === true, '聚合: 未配汇率的币种标 no_rate');
  ok(((agg1.json && agg1.json.unconverted_units) || []).includes('USD'), '聚合: unconverted_units 报告 USD');
  eq(agg1.json && agg1.json.partial, true, '聚合: 有渠道失败 → partial=true');
  const plainItem = agg1.json && agg1.json.channels && agg1.json.channels.find(c => c.channel === 'relay-plain');
  ok(plainItem && plainItem.ok === false && /无余额接口预设/.test(plainItem.error || ''), '聚合: 没配余额接口的渠道带原因');
  ok(agg1.json && agg1.json.data && Array.isArray(agg1.json.data.channels), '聚合: data.* 嵌套同构(嵌套键客户端)');

// With an FX rate: USD is converted into the total
  const cfgFx = { ...cfgE2E, balanceFx: { base: 'CNY', rates: { CNY: 1, USD: 7.2 } } };
  const gwFx = await G.startServer(cfgFx, { port: 0 });
  const agg2 = await get(gwFx.port, '/v1/credits', H);
  near(agg2.json && agg2.json.total_remain, 203.3, '聚合: 配汇率后 USD 10×7.2 折算进合计(42.5+88.8+72)');
  eq(agg2.json && agg2.json.unit, 'CNY', '聚合: 合计币种=base');
  const usd2 = agg2.json && agg2.json.channels && agg2.json.channels.find(c => c.channel === 'usd-relay');
  near(usd2 && usd2.remain_base, 72, '聚合: 明细带折算值 remain_base');
  eq(usd2 && usd2.no_rate, undefined, '聚合: 配了汇率不再标 no_rate');
  ok(!((agg2.json && agg2.json.unconverted_units) || []).length, '聚合: 无 unconverted_units');
// The key card whitelist constrains aggregation too
  const aggWl = await get(gwFx.port, '/v1/credits', { Authorization: 'Bearer sk-card-one' });
  eq(aggWl.json && aggWl.json.channels && aggWl.json.channels.length, 1, '聚合: 绑定卡只见白名单渠道');
// Official OpenAI semantic paths stay single-channel without ch (official shape preserved, no aggregation)
  const sg = await get(gwFx.port, '/v1/dashboard/billing/credit_grants', H);
  eq(sg.json && sg.json.object, 'credit_summary', 'OpenAI 路径不带 ch 仍单渠道(不聚合)');
  const rNoKey = await get(port, '/v1/dashboard/billing/credit_grants');
  eq(rNoKey.status, 401, '实例有卡密时无 key → 401');
  const rNoCh = await get(port, '/v1/dashboard/billing/credit_grants?ch=nope', H);
  eq(rNoCh.status, 404, '渠道不存在 → 404');
  const rNoTarget = await get(port, '/v1/dashboard/billing/credit_grants?ch=relay-plain', H);
  eq(rNoTarget.status, 400, '该渠道无余额接口 → 400');
  const rWlOut = await get(port, '/v1/dashboard/billing/credit_grants?ch=deepseek-alike', { Authorization: 'Bearer sk-card-one' });
  eq(rWlOut.status, 403, '绑定卡查白名单外渠道 → 403');
  const rWlIn = await get(port, '/v1/dashboard/billing/credit_grants?ch=relay-custom', { Authorization: 'Bearer sk-card-one' });
  eq(rWlIn.status, 200, '绑定卡查白名单内渠道 → 200');
  // cache: three more consecutive calls must not add upstream requests
  const hitsAfterFirst = up.hits.length;
  await get(port, '/v1/dashboard/billing/credit_grants?ch=relay-custom', H);
  await get(port, '/v1/dashboard/billing/subscription?ch=relay-custom', H);
  eq(up.hits.length, hitsAfterFirst, '30s 缓存命中: 客户端连打不再打上游');
  ok(up.hits.length - hitsBefore > 0, '至少真实查过一次上游');
// 2026-10-27 route whitelist: /health closed; only /v1 /v1beta /auth /profile /admin remain
  eq((await get(port, '/health')).status, 404, '/health 已按白名单关闭');
  eq((await get(port, '/v1/models', H)).status, 200, '/v1/models 不受白名单影响');

/* ============ 5. Admin side + panel saves must not wipe fields ============ */
  console.log('── Part 5: 管理端余额路由 + 面板保存防抹 ──');
  adminMod.setDir(tmpDir);
  adminMod.setBalanceFn((c, ch, cb) => G.fetchChannelBalance(c, ch, cb));
  const reloads = [];
  adminMod.setPool({ reload: (n) => reloads.push(n) });
  const res1 = fakeRes();
  await adminMod.handleAdmin(lc, fakeReq(), res1, new URL('http://x/admin/api/balance/default/relay-custom'), '/admin/api/balance/default/relay-custom', '');
  await waitRes(res1);
  eq(res1.status, 200, 'admin 余额路由 200');
  eq(res1.json() && String(res1.json().balance), '42.50', 'admin 余额路由取值');
  const res2 = fakeRes();
  await adminMod.handleAdmin(lc, fakeReq(), res2, new URL('http://x/admin/api/balance/default/relay-plain'), '/admin/api/balance/default/relay-plain', '');
  await waitRes(res2);
  eq(res2.status, 400, 'admin 余额路由: 无预设 → 400');
// Old panels (unaware of the balance trio) saving a channel -> the fields must be preserved
  const res3 = fakeRes();
  const bodyOld = JSON.stringify({ name: 'relay-custom', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, proxy: '-', models: ['m2'], apiKey: '', default: true, useResponses: false, probe: false });
  await adminMod.handleAdmin(lc, { method: 'POST', headers: { 'x-agw-token': 'test-admin' }, on() {} }, res3, new URL('http://x/admin/api/channel/default'), '/admin/api/channel/default', bodyOld);
  eq(res3.status, 200, '面板保存渠道 200');
  const afterSave = readCfg(tmpCfg).channels.find(c => c.name === 'relay-custom');
  eq(afterSave.balanceUrl, '/v1/user/info', '旧面板保存: balanceUrl 未被抹掉');
  eq(afterSave.balanceUnit, 'CNY', '旧面板保存: balanceUnit 未被抹掉');
// New panel submits an empty string = explicit clear
  const res4 = fakeRes();
  const bodyClear = JSON.stringify({ name: 'relay-custom', type: 'openai', baseUrl: `http://127.0.0.1:${up.port}`, models: ['m2'], apiKey: '', balanceUrl: '', balancePath: '', balanceUnit: '' });
  await adminMod.handleAdmin(lc, { method: 'POST', headers: { 'x-agw-token': 'test-admin' }, on() {} }, res4, new URL('http://x/admin/api/channel/default'), '/admin/api/channel/default', bodyClear);
  const cleared = readCfg(tmpCfg).channels.find(c => c.name === 'relay-custom');
  eq(cleared.balanceUrl, undefined, '显式空串 = 清空 balanceUrl');
  eq(cleared.balanceUnit, undefined, '显式空串 = 清空 balanceUnit');
// maskedChannels must return all three fields (otherwise the panel can neither see nor edit them)
  const res5 = fakeRes();
  await adminMod.handleAdmin(lc, fakeReq(), res5, new URL('http://x/admin/api/config/default'), '/admin/api/config/default', '');
  const cfgOut = res5.json();
  const chOut = cfgOut && cfgOut.channels && cfgOut.channels.find(c => c.name === 'relay-proxy');
  eq(chOut && chOut.balanceUrl, '/v1/user/info', '面板读取: 回传 balanceUrl');
  eq(chOut && chOut.balancePath, 'data.balance', '面板读取: 回传 balancePath');
  ok(chOut && chOut.apiKey === undefined, '面板读取: apiKey 仍打码(不因新增字段泄漏)');

/* ============ Finalize ============ */
  await new Promise(r => setTimeout(r, 50));
  up.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log('──────────────────────────────');
  console.log(`余额透传: 通过 ${pass} 项, 失败 ${fail} 项`);
  if (fail) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
