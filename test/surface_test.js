'use strict';
/* surface_test.js -- the secret admin surface (2026-11-10):
 *   1) the card-holder API keeps its bare paths (/v1, /api/app, /plugins)
 *   2) the admin WebUI lives at /<sid>/admin/<token>: one-time link -> login page
 *      (admin card key + 2FA) -> session cookie
 *   3) no cookie / token on admin endpoints -> 401; unknown secret paths -> 404
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch (_) { return null; } };
const cookieOf = (r) => (r.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-surface-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: '',
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    adminAuth: { secondKey: 'SECOND2' },
    apiKeys: [
      { key: 'ADMINKEY', role: 'admin', enable: true },
      { key: 'USERKEY', role: 'user', enable: true },
    ],
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const st = panelAuth.ensure(cfg, 'default');
  const A = `/${st.sid}/admin`;

  // ---- 1) the card-holder API keeps its bare paths ----
  const models = await request(port, '/v1/models', { authorization: 'Bearer USERKEY' });
  ok(models.status === 200, '裸 /v1/models + 卡密 → 200 (got ' + models.status + ')');
  ok(Array.isArray(json(models) && json(models).data), '/v1/models 返回 OpenAI 形状');
  ok((await request(port, '/v1/models')).status === 401, '裸 /v1/models 无卡密 → 401');
  ok((await request(port, '/v1/models', { authorization: 'Bearer ADMINKEY' })).status === 200, '管理员卡密也可用于用户 API');
  const bs = await request(port, '/api/app/bootstrap');
  ok(bs.status === 200 && json(bs) && json(bs).ok === true, '裸 /api/app/bootstrap → 200');
  ok((await request(port, '/plugins')).status !== 404, '裸 /plugins 可达(非 404)');

  // ---- 2) the old panel entry points and probes are 404 ----
  for (const p of ['/admin', '/admin/entry', '/auth', '/auth/app.js', '/health', '/']) {
    const r = await request(port, p);
    ok(r.status === 404, '探测路径 ' + p + ' → 404 (got ' + r.status + ')');
    ok(!/OpenAGW 管理端|login-info|config\.json/.test(r.body), '探测路径 ' + p + ' 不泄露面板内容');
  }
  const badSid = 'A'.repeat(32), badTok = 'B'.repeat(43);
  ok((await request(port, `/${badSid}/admin/${badTok}`)).status === 404, '未知 sid 的管理链接 → 404');
  ok((await request(port, `/${badSid}/admin/login`)).status === 404, '未知 sid 的登录页 → 404');
  const fakePair = '/' + st.sid + '/' + 'x'.repeat(43) + '/v1/models';
  ok((await request(port, fakePair, { authorization: 'Bearer USERKEY' })).status === 404, '伪造的两段式前缀 → 404');

  // ---- 3) admin WebUI: link -> login page -> session ----
  ok((await request(port, A)).status === 401, '无会话访问 /<sid>/admin/ → 401');
  ok((await request(port, `${A}/app.js`)).status === 401, '无会话访问面板静态资源 → 401');
  ok((await request(port, `${A}/api/config/default`)).status === 401, '无 Cookie/Token 访问管理 API → 401');
  ok((await request(port, `${A}/login`)).status === 401, '没有一次性链接直接开登录页 → 401');

  const link = panelAuth.issue(cfg, 'default');
  const first = await request(port, `/${link.sid}/admin/${link.token}`);
  ok(first.status === 302, '一次性链接 → 302 (got ' + first.status + ')');
  ok((first.headers.location || '') === `/${link.sid}/admin/login`, '一次性链接跳登录页');
  ok(/agwSID(_\d+)?=/.test(first.headers['set-cookie'] || ''), '一次性链接签发待登录会话 cookie');
  const pending = cookieOf(first);

  ok((await request(port, `${A}/login`)).status === 401, '待登录会话之外无法开登录页');
  const loginPage = await request(port, `${A}/login`, { cookie: pending });
  ok(loginPage.status === 200 && /OpenAGW 管理端/.test(loginPage.body), '待登录会话可打开登录页');
  const info = await request(port, `${A}/login-info`, { cookie: pending });
  const ij = json(info) || {};
  ok(info.status === 200 && ij.keyRequired === true && ij.secondKey === true, 'login-info 指明需要卡密与第二密码');

  const post = (b) => request(port, `${A}/login`, { cookie: pending, 'content-type': 'application/json' }, 'POST', JSON.stringify(b));
  ok((await post({ key: 'WRONG', secondKey: 'SECOND2' })).status === 401, '错误卡密 → 401');
  ok((await post({ key: 'ADMINKEY', secondKey: 'WRONG' })).status === 401, '缺少/错误二次验证 → 401');
  const good = await post({ key: 'ADMINKEY', secondKey: 'SECOND2' });
  ok(good.status === 200 && json(good) && json(good).ok === true, '卡密 + 二次验证 → 登录成功');
  ok(!/set-cookie/i.test(JSON.stringify(good.headers)), '登录成功沿用同一会话 cookie');

  ok((await request(port, `${A}/`, { cookie: pending })).status === 200, '登录后会话可打开面板首页');
  const page = await request(port, `${A}/`, { cookie: pending });
  ok(/OpenAGW/.test(page.body) && /app\.js/.test(page.body), '面板 HTML 引用自身资源(app.js)');
  ok((await request(port, `${A}/app.js`, { cookie: pending })).status === 200, '登录后会话可读面板资源');
  ok((await request(port, `${A}/vendor/mw-v2.js`, { cookie: pending })).status === 200, '登录后会话可读组件库');
  ok((await request(port, `${A}/secret.json.bak`, { cookie: pending })).status === 404, '非白名单扩展名仍是 404');
  ok((await request(port, `${A}/../admin.js`, { cookie: pending })).status === 404, '路径穿越仍是 404');

  ok((await request(port, `${A}/api/config/default`, { cookie: pending })).status === 200, '会话 cookie 可访问管理 API');
  ok((await request(port, `${A}/api/entry`, { cookie: pending })).status === 404, 'entry API 已随用户前缀一起移除');

  // ---- 4) token callers bypass the login page but still need the second factor ----
  ok((await request(port, `${A}/api/config/default`, { 'x-agw-token': 'ADMINKEY' })).status === 401, '管理卡密 token 缺二次验证 → 401');
  ok((await request(port, `${A}/api/config/default`, { 'x-agw-token': 'ADMINKEY', 'x-admin-key2': 'SECOND2' })).status === 200, '管理卡密 token + 二次验证 → 200');

  // ---- 5) link replay: full session keeps working, a bare replay is 401 ----
  const replay = await request(port, `/${link.sid}/admin/${link.token}`, { cookie: pending });
  ok(replay.status === 302 && (replay.headers.location || '') === `${A}/`, '已登录时重放一次性链接 → 回到面板');
  ok((await request(port, `/${link.sid}/admin/${link.token}`)).status === 401, '无会话重放一次性链接 → 401');

  // ---- 6) a legacy session (no login flag) cannot open the panel on a card instance ----
  const map = panelAuth.sessionsOf(cfg, 'default');
  map.LEGACY0000000000000000000000 = { exp: Date.now() + 60000, panelSid: panelAuth.read(cfg, 'default').sid };
  panelAuth.sessionsSave(cfg, 'default');
  ok((await request(port, `${A}/`, { cookie: 'agwSID=LEGACY0000000000000000000000' })).status === 401, '旧式会话(未过登录页) → 401');
  ok((await request(port, `${A}/api/config/default`, { cookie: 'agwSID=LEGACY0000000000000000000000' })).status === 401, '旧式会话访问管理 API → 401');

  await new Promise(r => started.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nsurface test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
