'use strict';
// Multi-user removal: credential login/registration and the user admin API must be gone,
// legacy config fields must not survive a load, and key cards must keep working.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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
    const req = http.request({ host: '127.0.0.1', port, path: p, headers, method }, res => {
      let out = '';
      res.on('data', c => out += u8p(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-nomulti-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '',
    webToken: 'test-web-token',
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    users: [{ uid: 'alice', name: 'Alice', passwordHash: 'scrypt:x:y' }],
    registration: { enable: true, defaultQuota: 5000, minPasswordLen: 6 },
    apiKeys: [{ key: 'sk-legacy-card', name: 'old', enable: true, quotaTokens: 0, usedTokens: 0, uid: 'alice' }],
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
  }));

  const cfg = G.loadConfig(cfgFile);
  ok(!('users' in cfg), '加载后不再保留 users 表');
  ok(!('registration' in cfg), '加载后不再保留 registration 设置');

  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const tok = { 'x-agw-token': 'test-web-token' };

  ok((await request(port, '/auth/login', {}, 'POST', '{"uid":"alice","password":"x"}')).status === 404, 'POST /auth/login 已移除');
  ok((await request(port, '/auth/register', {}, 'POST', '{"uid":"bob","password":"12345678"}')).status === 404, 'POST /auth/register 已移除');
  ok((await request(port, '/auth/register')).status === 404, 'GET /auth/register 已移除');
  ok((await request(port, '/auth/me', { Authorization: 'Bearer sk-legacy-card' })).status === 404, '/auth/me 已移除');
  ok((await request(port, '/auth/mykeys', { Authorization: 'Bearer sk-legacy-card' })).status === 404, '/auth/mykeys 已移除');
  ok((await request(port, '/admin/api/users/default', tok)).status === 404, 'GET /admin/api/users 已移除');
  ok((await request(port, '/admin/api/users/default', tok, 'POST', '{"password":"12345678"}')).status === 404, 'POST /admin/api/users 已移除');

  const cfgResp = await request(port, '/admin/api/config/default', tok);
  ok(cfgResp.status === 200, '管理配置接口仍可用');
  let cfgJson = {};
  try { cfgJson = JSON.parse(cfgResp.body); } catch (_) {}
  ok(!('registration' in cfgJson), '管理配置不再回传 registration');
  ok(!('users' in cfgJson), '管理配置不再回传 users');

  const created = await request(port, '/admin/api/keys/default', { ...tok, 'Content-Type': 'application/json' }, 'POST',
    JSON.stringify({ name: 'new-card', quotaTokens: 1000, uid: 'alice' }));
  ok(created.status === 200, '发卡接口仍可用');
  let newKey = '';
  try { newKey = (JSON.parse(created.body).key || {}).key || ''; } catch (_) {}
  ok(!!newKey, '发卡返回完整 key');
  ok(JSON.parse(created.body).key.uid === undefined, '新卡不再写入 uid 归属');

  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  ok(!('users' in saved) && !('registration' in saved), '落盘配置不含 users/registration');
  const diskCard = (saved.apiKeys || []).find(k => k.key === newKey);
  ok(!!diskCard, '新卡已写入配置');
  ok(!!diskCard && diskCard.uid === undefined, '落盘的新卡没有 uid 字段');
  ok((saved.apiKeys || []).some(k => k.key === 'sk-legacy-card'), '历史卡密数据保留');

  const legacy = await request(port, '/v1/models', { Authorization: 'Bearer sk-legacy-card' });
  ok(legacy.status === 200, '历史卡密仍然可用');

  if (started.server && started.server.close) started.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
