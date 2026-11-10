'use strict';
const surface = require('./_surface');
/* User (card-key) management: per-card RPM/TPM limits and model/provider/instance permissions,
 * admin CRUD for those fields, and one card reaching several instances.
 * Real HTTP, in-process gateway. Run: node test/user_management_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { utf8 } = require('../util.js');
const G = require('../gateway.js');

const u8p = utf8();
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + msg); }
}
function request(port, p, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: surface.spath(p), headers, method }, res => {
      let out = '';
      res.on('data', c => out += u8p(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
function chat(port, key, model, extraHeaders = {}) {
  return request(port, '/v1/chat/completions',
    { 'Content-Type': 'application/json', authorization: 'Bearer ' + key, ...extraHeaders }, 'POST',
    JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }));
}
function passthru(port, key, p, body) {
  return request(port, p, { 'Content-Type': 'application/json', authorization: 'Bearer ' + key }, 'POST', JSON.stringify(body));
}
function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

(async () => {
  const mock = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1,
        model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const upstream = 'http://127.0.0.1:' + mock.address().port;
  const channels = [
    { name: 'c1', type: 'openai', baseUrl: upstream, apiKey: 'sk-up', models: ['m1'], default: true },
    { name: 'c2', type: 'openai', baseUrl: upstream, apiKey: 'sk-up', models: ['m2'] },
    { name: 'c3', type: 'openai', baseUrl: upstream, apiKey: 'sk-up', models: ['ratem'] },
  ];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-users-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: 'test-web-token',
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    redact: { enable: false },
    apiKeys: [
      { key: 'sk-open', name: 'open', enable: true },
      { key: 'sk-rpm', name: 'rpm2', enable: true, rpm: 2 },
      { key: 'sk-tpm', name: 'tpm7', enable: true, tpm: 7 },
      { key: 'sk-tpm-low', name: 'tpm3', enable: true, tpm: 3 },
      { key: 'sk-model', name: 'model-only', enable: true, models: ['m1'] },
      { key: 'sk-chan', name: 'provider-only', enable: true, channels: ['c2'] },
      { key: 'sk-branch', name: 'branch-ghost', enable: true, branches: ['ghost'] },
      { key: 'sk-wild', name: 'wild', enable: true, models: ['m*'], channels: ['c1'] },
      { key: 'sk-quota', name: 'exhausted', enable: true, quotaTokens: 4, usedTokens: 4 },
      { key: 'sk-admin', name: 'admin-key', role: 'admin', enable: true },
    ],
    channels,
  }));

  const cfgUM = G.loadConfig(cfgFile);
  surface.set(cfgUM);
  const started = await G.startServer(cfgUM, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const admin = { 'x-agw-token': 'test-web-token' };
  const jsonAdmin = { ...admin, 'Content-Type': 'application/json' };

  // ---- model permission ----
  let r = await chat(port, 'sk-open', 'm1');
  ok(r.status === 200, '无限制卡可用 m1 (got ' + r.status + ')');
  r = await chat(port, 'sk-open', 'm2');
  ok(r.status === 200, '无限制卡可用 m2 (got ' + r.status + ')');
  r = await chat(port, 'sk-model', 'm1');
  ok(r.status === 200, '模型白名单内 m1 可用 (got ' + r.status + ')');
  r = await chat(port, 'sk-model', 'm2');
  ok(r.status === 403 && r.body.includes('不允许使用模型'), '模型白名单外 m2 被拒 403 (got ' + r.status + ')');
  r = await request(port, '/v1/models', { authorization: 'Bearer sk-model' });
  let ids = (JSON.parse(r.body).data || []).map(x => x.id);
  ok(ids.join(',') === 'm1', '模型列表只含白名单 m1 (got ' + ids.join(',') + ')');
  r = await request(port, '/v1/models', { authorization: 'Bearer sk-open' });
  ids = (JSON.parse(r.body).data || []).map(x => x.id).sort();
  ok(ids.join(',') === 'm1,m2,ratem', '无限制卡看到全部模型 (got ' + ids.join(',') + ')');

  // ---- provider permission ----
  r = await chat(port, 'sk-chan', 'm2');
  ok(r.status === 200, '提供商白名单内 c2 的 m2 可用 (got ' + r.status + ')');
  r = await chat(port, 'sk-chan', 'm1');
  ok(r.status === 403 && r.body.includes('不允许使用提供商'), '只能走 c2 的卡请求 m1 被拒 403 (got ' + r.status + ')');
  r = await chat(port, 'sk-chan', 'm2', { 'x-agw-channel': 'c1' });
  ok(r.status === 403, '强制指定白名单外渠道 c1 被拒 403 (got ' + r.status + ')');
  r = await request(port, '/v1/models', { authorization: 'Bearer sk-chan' });
  ids = (JSON.parse(r.body).data || []).map(x => x.id);
  ok(ids.join(',') === 'm2', '模型列表只含 c2 的模型 (got ' + ids.join(',') + ')');
  r = await chat(port, 'sk-wild', 'm1');
  ok(r.status === 200, '通配模型 m* + c1 可用 m1 (got ' + r.status + ')');
  r = await chat(port, 'sk-wild', 'm2');
  ok(r.status === 403, '通配模型允许 m2 但提供商 c1 不含 m2, 403 (got ' + r.status + ')');
// passthrough endpoints obey the same model/provider allowlists
  r = await passthru(port, 'sk-model', '/v1/embeddings', { model: 'm2', input: 'x' });
  ok(r.status === 403 && r.body.includes('不允许使用模型'), '透传端点也校验模型白名单 (got ' + r.status + ')');
  r = await passthru(port, 'sk-chan', '/v1/embeddings', { model: 'm1', input: 'x' });
  ok(r.status === 403 && r.body.includes('不允许使用提供商'), '透传端点也校验提供商白名单 (got ' + r.status + ')');
  r = await passthru(port, 'sk-chan', '/v1/embeddings', { model: 'm2', input: 'x' });
  ok(r.status === 200, '透传端点允许白名单内提供商 (got ' + r.status + ')');

  // ---- instance permission ----
  r = await chat(port, 'sk-branch', 'm1');
  ok(r.status === 403 && r.body.includes('未授权访问实例'), '实例白名单不含 default 时被拒 403 (got ' + r.status + ')');
  r = await request(port, '/v1/branches', { authorization: 'Bearer sk-branch' });
  ok(r.status === 200 && JSON.parse(r.body).branches.length === 0, '分支列表对不可达实例为空');
  r = await request(port, '/v1/branches', { authorization: 'Bearer sk-open' });
  ok(r.status === 200 && JSON.parse(r.body).branches.includes('default'), '无限制卡可列出 default 实例');

  // ---- RPM ----
  r = await chat(port, 'sk-rpm', 'm1');
  ok(r.status === 200, 'RPM 第 1 次放行 (got ' + r.status + ')');
  r = await chat(port, 'sk-rpm', 'm1');
  ok(r.status === 200, 'RPM 第 2 次放行 (got ' + r.status + ')');
  r = await chat(port, 'sk-rpm', 'm1');
  ok(r.status === 429 && /RPM/.test(r.body), 'RPM 第 3 次 429 (got ' + r.status + ')');
  ok(Number(r.headers['retry-after']) > 0, 'RPM 429 带 Retry-After');
  r = await passthru(port, 'sk-rpm', '/v1/embeddings', { model: 'm1', input: 'x' });
  ok(r.status === 429 && /RPM/.test(r.body), '透传端点共享同一 RPM 窗口 (got ' + r.status + ')');

  // ---- TPM ----
  r = await chat(port, 'sk-tpm-low', 'ratem');
  ok(r.status === 429 && /TPM/.test(r.body), '单次预估超过 TPM 直接 429 (got ' + r.status + ')');
  r = await chat(port, 'sk-tpm', 'ratem');
  ok(r.status === 200, 'TPM 窗口内第 1 次放行 (got ' + r.status + ')');
  r = await chat(port, 'sk-tpm', 'ratem');
  ok(r.status === 200, 'TPM 窗口内第 2 次仍放行 (got ' + r.status + ')');
  r = await chat(port, 'sk-tpm', 'ratem');
  ok(r.status === 429 && /TPM/.test(r.body), 'TPM 窗口用满后 429 (got ' + r.status + ')');

  // ---- quota still wins over rate limits ----
  r = await chat(port, 'sk-quota', 'm1');
  ok(r.status === 429 && r.body.includes('额度已用尽'), '额度用尽卡被拒 429 (got ' + r.status + ')');

  // ---- admin role cannot chat ----
  r = await chat(port, 'sk-admin', 'm1');
  ok(r.status === 403, '管理卡不能聊天 (got ' + r.status + ')');

  // ---- admin CRUD ----
  r = await request(port, '/admin/api/keys/default', admin);
  ok(r.status === 200, '管理 API 可读卡密列表');
  let list = JSON.parse(r.body).keys;
  const rpmCard = list.find(k => k.key === 'sk-rpm');
  ok(rpmCard && rpmCard.rpm === 2, '列表回传 rpm');
  ok(rpmCard && rpmCard.rpmUsed === 2, '列表回传本分钟 RPM 已用次数 (got ' + (rpmCard && rpmCard.rpmUsed) + ')');
  const tpmCard = list.find(k => k.key === 'sk-tpm');
  ok(tpmCard && tpmCard.tpmUsed === 8, '列表回传本分钟 TPM 已用 tokens (got ' + (tpmCard && tpmCard.tpmUsed) + ')');
  const chanCard = list.find(k => k.key === 'sk-chan');
  ok(chanCard && chanCard.channels.join(',') === 'c2', '列表回传提供商白名单');

  r = await request(port, '/admin/api/keys/default', jsonAdmin, 'POST', JSON.stringify({
    name: '新建用户', quotaTokens: 1000, rpm: 10, tpm: 1000,
    models: ['m1'], channels: ['c1'], branches: ['default'], note: 'n',
  }));
  ok(r.status === 200, '发卡带限流/权限成功 (got ' + r.status + ')');
  const made = JSON.parse(r.body).key;
  ok(made.rpm === 10 && made.tpm === 1000, '新卡限流字段落库');
  ok(made.models.join(',') === 'm1' && made.channels.join(',') === 'c1' && made.branches.join(',') === 'default', '新卡三类权限落库');
  r = await request(port, '/v1/models', { authorization: 'Bearer ' + made.key });
  ids = (JSON.parse(r.body).data || []).map(x => x.id);
  ok(ids.join(',') === 'm1', '新卡立刻只能看到 m1 (got ' + ids.join(',') + ')');

  r = await request(port, '/admin/api/keys-update/default', jsonAdmin, 'POST', JSON.stringify({
    key: made.key, rpm: 0, tpm: 0, models: [], channels: [], branches: [],
  }));
  ok(r.status === 200, '改权限成功');
  r = await request(port, '/v1/models', { authorization: 'Bearer ' + made.key });
  ids = (JSON.parse(r.body).data || []).map(x => x.id).sort();
  ok(ids.join(',') === 'm1,m2,ratem', '清空白名单后看到全部模型 (got ' + ids.join(',') + ')');

  // resetRate clears a blocked window immediately
  await request(port, '/admin/api/keys-update/default', jsonAdmin, 'POST', JSON.stringify({ key: 'sk-rpm', resetRate: true }));
  r = await chat(port, 'sk-rpm', 'm1');
  ok(r.status === 200, 'resetRate 后限流窗口立即清空 (got ' + r.status + ')');

  r = await request(port, '/admin/api/keys/default/' + encodeURIComponent(made.key), admin, 'DELETE');
  ok(r.status === 200, '删除卡密成功');
  r = await chat(port, made.key, 'm1');
  ok(r.status === 401, '删除后的卡密立即失效 (got ' + r.status + ')');

  await new Promise(r => started.server.close(r));

  // ---- one card, several instances ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-users-multi-'));
  const p1 = await freePort(), p2 = await freePort();
  const sharedUp = upstream;
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: p1 }, webToken: 'test-web-token',
    panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false }, redact: { enable: false },
    apiKeys: [
      { key: 'sk-cross', name: 'cross', enable: true, branches: ['default', 'second'] },
      { key: 'sk-all', name: 'no-instance-grant', enable: true },
      { key: 'sk-only', name: 'only-default', enable: true, branches: ['default'] },
      { key: 'sk-second', name: 'only-second', enable: true, branches: ['second'] },
    ],
    channels: [{ name: 'c1', type: 'openai', baseUrl: sharedUp, apiKey: 'sk-up', models: ['m1'], default: true }],
  }));
  fs.writeFileSync(path.join(dir2, 'config.second.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: p2 }, panel: { openBrowser: false },
    modelSync: { enable: false }, probe: { enable: false }, redact: { enable: false },
    channels: [{ name: 'c1', type: 'openai', baseUrl: sharedUp, apiKey: 'sk-up', models: ['x1'], default: true }],
  }));
  const cfgMulti = G.loadConfig(path.join(dir2, 'config.json'));
  const multi = await G.startServer(cfgMulti, { host: '127.0.0.1', multi: true });
  const PS = surface.pair(dir2, 'second').user;
  surface.set(cfgMulti);

  r = await request(p1, '/second/v1/chat/completions',
    { 'Content-Type': 'application/json', authorization: 'Bearer sk-cross' }, 'POST',
    JSON.stringify({ model: 'x1', messages: [{ role: 'user', content: 'hi' }] }));
  ok(r.status === 200, '跨实例卡可访问 second (got ' + r.status + ')');
  r = await request(p1, '/second/v1/chat/completions',
    { 'Content-Type': 'application/json', authorization: 'Bearer sk-only' }, 'POST',
    JSON.stringify({ model: 'x1', messages: [{ role: 'user', content: 'hi' }] }));
  ok(r.status === 403, '实例白名单不含 second 的卡被拒 403 (got ' + r.status + ')');
  r = await request(p1, '/second/v1/chat/completions',
    { 'Content-Type': 'application/json', authorization: 'Bearer sk-all' }, 'POST',
    JSON.stringify({ model: 'x1', messages: [{ role: 'user', content: 'hi' }] }));
  ok(r.status === 403, '未勾选实例权限的卡不能跨实例 (got ' + r.status + ')');
  r = await request(p1, '/v1/branches', { authorization: 'Bearer sk-cross' });
  const brs = JSON.parse(r.body).branches || [];
  ok(brs.includes('default') && brs.includes('second'), '实例列表回传全部已授权实例 (got ' + brs.join(',') + ')');
  r = await request(p1, '/v1/branches', { authorization: 'Bearer sk-all' });
  const brs2 = JSON.parse(r.body).branches || [];
  ok(brs2.join(',') === 'default', '未勾选实例权限时只回传发卡实例 (got ' + brs2.join(',') + ')');
  r = await request(p1, '/second/v1/chat/completions',
    { 'Content-Type': 'application/json', authorization: 'Bearer sk-second' }, 'POST',
    JSON.stringify({ model: 'x1', messages: [{ role: 'user', content: 'hi' }] }));
  ok(r.status === 200, '实例白名单含 second 的卡可用 (got ' + r.status + ')');
  r = await chat(p1, 'sk-second', 'm1');
  ok(r.status === 403, '只允许 second 的卡回到 default 被拒 403 (got ' + r.status + ')');
  r = await request(p1, '/second/v1/models', { authorization: 'Bearer sk-cross' });
  ids = (JSON.parse(r.body).data || []).map(x => x.id);
  ok(ids.join(',') === 'x1', '跨实例卡看到 second 的模型 (got ' + ids.join(',') + ')');
  r = await request(p1, '/admin/api/keys/default', { 'x-agw-token': 'test-web-token' });
  const cross = (JSON.parse(r.body).keys || []).find(k => k.key === 'sk-cross');
  ok(cross && cross.usedTokens > 0, '跨实例调用记在发卡实例的用量上');

  for (const srv of multi.pool.servers.values()) { try { srv.server.close(); } catch (_) {} }
  await new Promise(r => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  console.log(`\nuser management: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
