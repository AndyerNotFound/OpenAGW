'use strict';
/* Key role system: one key one role.
 *   user  key: chat / plugin user side OK; admin surface 401
 *   admin key: admin surface OK (Bearer / x-agw-token); chat 403
 * Real HTTP, in-process gateway (same style as admin_guard_test.js).
 * Run: node test/key_roles_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { utf8 } = require('../util.js');
const G = require('../gateway.js');
const panelAuth = require('../panel-auth.js');

const u8p = utf8();
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + msg); }
}
function request(port, p, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers, method }, res => {
      let out = '';
      res.on('data', c => out += u8p(c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

(async () => {
  // mock upstream that answers any chat with a fixed reply
  const mock = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1,
        model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-roles-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    plugins: [{ id: "balance", enable: true }],
    apiKeys: [
      { key: 'sk-user-1', name: '普通用户', role: 'user', quotaTokens: 100000 },
      { key: 'sk-admin-1', name: '管理员密钥', role: 'admin', enable: true },
      { key: 'sk-legacy-1', name: '老卡密(无role字段)', quotaTokens: 50000 },
    ],
    channels: [{ name: 'c1', type: 'openai', baseUrl: 'http://127.0.0.1:' + mock.address().port, apiKey: 'sk-up', models: ['m'], default: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;

  const chat = (key) => request(port, '/v1/chat/completions',
    { 'Content-Type': 'application/json', authorization: 'Bearer ' + key }, 'POST',
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));

  // ---- user key: chat works ----
  let r = await chat('sk-user-1');
  ok(r.status === 200, '用户key可聊天 (got ' + r.status + ')');

  // ---- user key: admin surface blocked ----
  r = await request(port, '/admin/api/instances', { authorization: 'Bearer sk-user-1' });
  ok(r.status === 401, '用户key访问 /admin/api/instances 401 (got ' + r.status + ')');
  r = await request(port, '/admin/api/keys/default', { authorization: 'Bearer sk-user-1' });
  ok(r.status === 401, '用户key访问卡密管理 401 (got ' + r.status + ')');
  r = await request(port, '/admin/api/config/default', { 'x-agw-token': 'sk-user-1' });
  ok(r.status === 401, '用户key放 x-agw-token 也不认 (got ' + r.status + ')');

  // ---- admin key: admin surface works ----
  r = await request(port, '/admin/api/instances', { authorization: 'Bearer sk-admin-1' });
  ok(r.status === 200, '管理key经 Bearer 访问管理API 200 (got ' + r.status + ')');
  r = await request(port, '/admin/api/instances', { 'x-agw-token': 'sk-admin-1' });
  ok(r.status === 200, '管理key经 x-agw-token 访问管理API 200 (got ' + r.status + ')');

  // ---- admin key: chat blocked ----
  r = await chat('sk-admin-1');
  ok(r.status === 403, '管理key不能聊天 403 (got ' + r.status + ')');
  ok(r.body.includes('管理员密钥不能用于 API 访问'), '403 文案明确 (got ' + r.body.slice(0, 60) + ')');

  // ---- legacy key without role field: treated as user ----
  r = await chat('sk-legacy-1');
  ok(r.status === 200, '无role字段的旧卡密按用户卡处理 (got ' + r.status + ')');
  r = await request(port, '/admin/api/instances', { authorization: 'Bearer sk-legacy-1' });
  ok(r.status === 401, '旧卡密进不了管理面 (got ' + r.status + ')');

  // ---- disabled admin key rejected ----
  const cfg2 = G.loadConfig(cfgFile);
  const k2 = cfg2.apiKeys.find(k => k.key === 'sk-admin-1');
  k2.enable = false;
  const adminToken = panelAuth.read(cfg, 'default').adminToken;
  await request(port, '/admin/api/keys-update/default', { 'x-agw-token': adminToken }, 'POST',
    JSON.stringify({ key: 'sk-admin-1', enable: false }));
  r = await request(port, '/admin/api/instances', { authorization: 'Bearer sk-admin-1' });
  ok(r.status === 401, '禁用后的管理key失效 (got ' + r.status + ')');
  await request(port, '/admin/api/keys-update/default', { 'x-agw-token': adminToken }, 'POST',
    JSON.stringify({ key: 'sk-admin-1', enable: true }));

  // ---- key listing carries role ----
  r = await request(port, '/admin/api/keys/default', { 'x-agw-token': 'sk-admin-1' });
  ok(r.status === 200, '管理key可读卡密列表 (got ' + r.status + ')');
  const list = JSON.parse(r.body).keys;
  ok(list.find(k => k.key === 'sk-user-1').role === 'user', '列表标注用户角色');
  ok(list.find(k => k.key === 'sk-admin-1').role === 'admin', '列表标注管理角色');
  ok(list.find(k => k.key === 'sk-legacy-1').role === 'user', '旧卡密按用户标注');

  // ---- issuing a new key with role admin via panel auth ----
  r = await request(port, '/admin/api/keys/default', { 'x-agw-token': adminToken }, 'POST',
    JSON.stringify({ name: '新管理密钥', role: 'admin', quotaTokens: 0 }));
  ok(r.status === 200, '发卡可指定角色 (got ' + r.status + ')');
  const newKey = JSON.parse(r.body).key;
  ok(newKey.role === 'admin', '新卡角色是 admin');
  r = await request(port, '/admin/api/instances', { authorization: 'Bearer ' + newKey.key });
  ok(r.status === 200, '新管理卡立即可用 (got ' + r.status + ')');
  r = await chat(newKey.key);
  ok(r.status === 403, '新管理卡不能聊天 (got ' + r.status + ')');

  // ---- role switch via keys-update ----
  r = await request(port, '/admin/api/keys-update/default', { 'x-agw-token': adminToken }, 'POST',
    JSON.stringify({ key: newKey.key, role: 'user' }));
  ok(r.status === 200, '角色可改回用户 (got ' + r.status + ')');
  r = await chat(newKey.key);
  ok(r.status === 200, '改回用户后能聊天 (got ' + r.status + ')');
  r = await request(port, '/admin/api/instances', { authorization: 'Bearer ' + newKey.key });
  ok(r.status === 401, '改回用户后管理面关闭 (got ' + r.status + ')');

  // ---- plugin admin route also honours roles ----
  r = await request(port, '/plugins/balance/query?ch=c1', { authorization: 'Bearer sk-user-1' });
  ok(r.status === 401, '用户key走插件管理路由 401 (got ' + r.status + ')');

  await new Promise(r => started.server.close(r));
  await new Promise(r => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nkey roles: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
