'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { utf8 } = require('../util.js');
const G = require('../gateway.js');
const panelAuth = require('../panel-auth.js');
const adminMod = require('../admin.js');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-panel-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '',
    webToken: '',
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
  }));

  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const firstState = panelAuth.read(cfg, 'default');
  ok(!!firstState && firstState.sid.length >= 16, '启动时生成 session-id');
  ok((await request(port, '/auth')).status === 401, '无令牌不能打开面板');

  const link = panelAuth.issue(cfg, 'default');
  const first = await request(port, `/auth/${link.sid}/${link.token}`);
  ok(first.status === 302 && /^\/auth\/?$/.test(first.headers.location || ''), '一次性链接首次登录 302 → /auth');
  ok(/agwSID(_\d+)?=/.test(first.headers['set-cookie'] || ''), '登录后签发会话 cookie');
  ok(!/Secure/i.test(first.headers['set-cookie'] || ''), '纯 HTTP 登录不签 Secure cookie');
  ok((await request(port, `/auth/${link.sid}/${link.token}`)).status === 401, '同一链接不能重放');
  ok(/^agwSID(_\d+)?=/.test((first.headers['set-cookie'] || []).join(';')), '会话 cookie 名固定前缀 agwSID(端口化命名)');

  const cookie = (first.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
  ok((await request(port, '/auth', { cookie })).status === 200, '会话 cookie 可再次打开面板');
  ok((await request(port, '/admin/api/config/default')).status === 401, '无令牌/无 cookie 的管理 API 返回 401');
  ok((await request(port, '/admin/api/config/default', { cookie })).status === 200, '会话 cookie 可访问管理 API');
  const adminToken = panelAuth.read(cfg, 'default').adminToken;
  ok((await request(port, '/admin/api/config/default', { 'x-agw-token': adminToken })).status === 200, '本地 adminToken 可访问管理 API');
  cfg.webToken = 'legacy-api-token';
  cfg.listen.port = 18899; // 多网关共存: cookie 名按端口区分, 互不覆盖
  const tlsLink = panelAuth.issue(cfg, 'default');
  const tlsLogin = await request(port, `/auth/${tlsLink.sid}/${tlsLink.token}`, { 'x-forwarded-proto': 'https' });
  ok(tlsLogin.status === 302 && /Secure/.test(tlsLogin.headers['set-cookie'] || ''), 'HTTPS 标记下登录 cookie 带 Secure');
  ok(((tlsLogin.headers['set-cookie'] || []).join(';')).startsWith('agwSID_18899='), '会话 cookie 名按监听端口区分');
  ok((await request(port, '/auth', { cookie: 'agwSID=' + ((tlsLogin.headers['set-cookie'] || []).join('').match(/agwSID_18899=([^;]+)/) || [])[1] })).status === 200, '旧固定名 cookie 仍然兼容');
  cfg.listen.port = 0;
  ok((await request(port, '/auth?key=legacy-api-token')).status === 401, 'webToken 不能绕过面板一次性链接');
  ok((await request(port, '/admin/api/config/default', { 'x-agw-token': 'legacy-api-token' })).status === 200, 'webToken 仍可用于管理 API');

  const rot = await request(port, '/admin/api/web-token/rotate', {
    'x-agw-token': 'legacy-api-token', 'content-type': 'application/json',
  }, 'POST', '{}');
  ok(rot.status === 200, 'webToken 可一键轮换');
  let newToken = '';
  try { newToken = JSON.parse(rot.body).webToken || ''; } catch (_) {}
  ok(newToken.length >= 32 && newToken !== 'legacy-api-token', '轮换返回新的 32+ 位 token');
  ok((await request(port, '/admin/api/config/default', { 'x-agw-token': 'legacy-api-token' })).status === 401, '旧 token 立即失效（宽限期已移除）');
  const rotOld = await request(port, '/admin/api/web-token/rotate', { 'x-agw-token': 'legacy-api-token' }, 'POST', '{}');
  ok(rotOld.status === 401, '旧 token 不能再轮换出永久新 token');
  const sessTok = ((first.headers['set-cookie'] || []).join('').match(/agwSID_18899=([^;]+)/) || [])[1] || '';
  const rotSess = await request(port, '/admin/api/web-token/rotate', { cookie: 'agwSID=' + sessTok }, 'POST', '{}');
  ok(rotSess.status === 401, '面板会话不能轮换 webToken');
  ok((await request(port, '/admin/api/config/default', { 'x-agw-token': newToken })).status === 200, '新 token 可访问管理 API');
  try {
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    ok(!Object.keys(saved).some(k => k.startsWith('_')), '轮换保存不写入 _configFile/_name 内部字段');
  } catch (e) {
    ok(false, '轮换后的 config.json 可解析: ' + e.message);
  }
  ok((await request(port, '/admin/api/config/default', { 'x-agw-token': 'wrong-token' })).status === 401, '错误 token 仍返回 401');
  cfg.webToken = '';
  const remote = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };
  ok(!adminMod.checkAdminAuth(cfg, remote, new URLSearchParams()), '远程无令牌不能访问管理 API');
  ok(adminMod.checkAdminAuth(cfg, { headers: { 'x-agw-token': adminToken }, socket: remote.socket }, new URLSearchParams()), '远程可用 adminToken 访问管理 API');

  const oldSid = panelAuth.read(cfg, 'default').sid;
  panelAuth.revoke(cfg, 'default');
  ok(panelAuth.read(cfg, 'default').sid !== oldSid, '注销后 session-id 轮换');
  ok((await request(port, '/auth', { cookie })).status === 401, '注销后旧 cookie 失效');

  const oldSid2 = panelAuth.read(cfg, 'default').sid;
  panelAuth.init(cfg, 'default');
  ok(panelAuth.read(cfg, 'default').sid !== oldSid2, '重启初始化会轮换 session-id');

  const firstToken = panelAuth.issue(cfg, 'default');
  const secondToken = panelAuth.issue(cfg, 'default');
  ok(!panelAuth.verify(cfg, 'default', firstToken.sid, firstToken.token), '新登录命令会作废旧 token');
  ok(panelAuth.verify(cfg, 'default', secondToken.sid, secondToken.token), '新 token 可用');

  await new Promise(r => started.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\npanel auth test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
