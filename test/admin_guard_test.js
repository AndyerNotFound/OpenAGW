'use strict';
/* admin_guard_test.js -- guards on the admin surface (secret-path model, 2026-11-10):
 *  1) bare /admin and /auth are gone (404); the panel lives at /<sid>/admin/ and needs a session
 *  2) panel static files are extension-whitelisted (no arbitrary m3/ files)
 *  3) /admin/api/* without a cookie or token answers 401 and leaks nothing
 * Real HTTP, same style as panel_auth_test.js */
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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-guard-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: '',
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const st = panelAuth.ensure(cfg, 'default');
  const A = `/${st.sid}/admin`;

  // ---- 1) the old public entry points are closed ----
  for (const p of ['/admin', '/admin/', '/auth', '/auth/app.js', '/auth/' + st.sid + '/x']) {
    const r = await request(port, p);
    ok(r.status === 404, '旧入口 ' + p + ' → 404 (got ' + r.status + ')');
    ok(r.body === '' || !/OpenAGW 管理端|login-info/.test(r.body), '旧入口 ' + p + ' 不输出面板内容');
  }
  const badSid = 'A'.repeat(32);
  ok((await request(port, `/${badSid}/admin/`)).status === 404, '未知 sid → 404');

  // ---- 2) anonymous panel + assets + API ----
  const anonPanel = await request(port, `${A}/`);
  ok(anonPanel.status === 401, '匿名访问面板 → 401');
  ok(!anonPanel.body.includes('OpenAGW 管理端'), '401 页不含面板内容');
  ok((await request(port, `${A}/app.js`)).status === 401, '匿名访问面板资源 → 401');
  ok((await request(port, `${A}/vendor/mw-v2.js`)).status === 401, '匿名访问组件库 → 401');
  const denied = await request(port, `${A}/api/config/default`);
  ok(denied.status === 401, '匿名访问管理 API → 401');
  ok(!/webToken|config\.webToken|default 实例/i.test(denied.body), '401 响应不泄露配置线索');
  ok((await request(port, `${A}/api/config/default`, { 'x-agw-token': 'wrong' })).status === 401, '错误 token → 401');
  ok((await request(port, `${A}/login`)).status === 401, '没有一次性链接不能开登录页');
  ok((await request(port, `${A}/login-info`)).status === 401, '没有待登录会话不能读 login-info');

  // ---- 3) one-time link (keyless instance: no login page) ----
  const link = panelAuth.issue(cfg, 'default');
  const login = await request(port, `/${link.sid}/admin/${link.token}`);
  ok(login.status === 302, '一次性链接 → 302');
  ok((login.headers.location || '') === `/${link.sid}/admin/`, '无卡密实例直接进面板');
  const cookie = (login.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
  ok(/agwSID(_\d+)?=/.test(cookie), '签发会话 cookie');

  // ---- 4) panel asset policy with a session ----
  ok((await request(port, `${A}/`, { cookie })).status === 200, '会话 cookie 可打开面板');
  const js = await request(port, `${A}/app.js`, { cookie });
  ok(js.status === 200 && /text\/javascript/.test(js.headers['content-type'] || ''), 'app.js 可达');
  const bad = await request(port, `${A}/../admin.js`, { cookie });
  ok(bad.status === 404, '路径穿越 /<sid>/admin/../admin.js 不可达');
  const m3 = path.join(path.dirname(cfgFile), 'm3');
  fs.mkdirSync(m3, { recursive: true });
  fs.writeFileSync(path.join(m3, 'secret.json.bak'), '{"k":"sensitive"}');
  const bak = await request(port, `${A}/secret.json.bak`, { cookie });
  ok(bak.status === 404, 'm3/ 下非白名单扩展名文件不可被读取');

  // ---- 5) authorized API access still works ----
  const adminToken = panelAuth.read(cfg, 'default').adminToken;
  ok((await request(port, `${A}/api/config/default`, { 'x-agw-token': adminToken })).status === 200, 'adminToken 可访问管理 API');
  ok((await request(port, `${A}/api/config/default`, { cookie })).status === 200, '会话 cookie 可访问管理 API');

  // ---- 6) replay: with a session it bounces to the panel, without one it is 401 ----
  const replay = await request(port, `/${link.sid}/admin/${link.token}`, { cookie });
  ok(replay.status === 302 && replay.headers.location === `/${link.sid}/admin/`, '带会话重放 → 面板');
  ok((await request(port, `/${link.sid}/admin/${link.token}`)).status === 401, '无会话重放 → 401');

  await new Promise(r => started.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nadmin guard test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
