'use strict';
/* admin_guard_test.js -- guards on the admin surface:
 *  1) /admin page itself requires auth (was 200 to anyone)
 *  2) /auth/* static files are extension-whitelisted (no arbitrary m3/ files)
 *  3) /admin/api/* 401 response does not leak config hints
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

  // ---- Hole 1: /admin page requires auth ----
  const anonAdmin = await request(port, '/admin');
  ok(anonAdmin.status === 401, '匿名访问 /admin 页面返回 401');
  ok(!anonAdmin.body.includes('AI Gateway'), '401 页不含管理页面内容');
  const link = panelAuth.issue(cfg, 'default');
  const login = await request(port, `/auth/${link.sid}/${link.token}`);
  const cookie = (login.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
  ok((await request(port, '/admin', { cookie })).status === 200, '带会话 cookie 可访问 /admin 页面');

  // ---- Hole 2: /auth/* static files extension whitelist ----
  const bad = await request(port, '/auth/../admin.js');
  ok(bad.status === 404 || bad.status === 401, '路径穿越 /auth/../admin.js 不可达');
  const js = await request(port, '/auth/app.js');
  ok(js.status === 200 || js.status === 404, 'app.js 可达或明确 404');
  // the real check: a non-whitelisted extension inside m3/ must be refused
  const m3 = path.join(path.dirname(cfgFile), 'm3');
  fs.mkdirSync(m3, { recursive: true });
  fs.writeFileSync(path.join(m3, 'secret.json.bak'), '{"k":"sensitive"}');
  const bak = await request(port, '/auth/secret.json.bak');
  ok(bak.status === 404, 'm3/ 下非白名单扩展名文件不可被匿名读取');

  // ---- Hole 3: 401 body must not leak config hints ----
  const denied = await request(port, '/admin/api/config/default');
  ok(denied.status === 401, '匿名访问管理 API 返回 401');
  ok(!/webToken|config\.webToken|default 实例/i.test(denied.body), '401 响应不泄露配置线索');

  // ---- regression: authorized access still works ----
  const adminToken = panelAuth.read(cfg, 'default').adminToken;
  ok((await request(port, '/admin/api/config/default', { 'x-agw-token': adminToken })).status === 200, 'adminToken 仍可访问管理 API');
  ok((await request(port, '/admin/api/config/default', { cookie })).status === 200, '会话 cookie 仍可访问管理 API');

  await new Promise(r => started.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nadmin guard test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
