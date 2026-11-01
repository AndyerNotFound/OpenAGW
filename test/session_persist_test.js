'use strict';
// Session persistence across hot restarts (worker swap): a browser cookie issued before a
// hot restart must still authenticate the panel APIs afterwards. Regression for:
// "热重启后面板登录丢失 -> 页面刷新/重启后无法加载网关信息(401)".
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
function request(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, res => {
      let body = '';
      res.on('data', c => body += u8p(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-sessp-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '', webToken: '',
    modelSync: { enable: false }, probe: { enable: false },
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const link = panelAuth.issue(cfg, 'default');
  const first = await request(port, `/auth/${link.sid}/${link.token}`);
  ok(first.status === 302, '一次性链接登录 302');
  const cookie = (first.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; ');
  ok(!!cookie, '签发会话 cookie');
  ok((await request(port, '/admin/api/instances', { cookie })).status === 200, 'cookie 可访问管理 API');
  const sidBefore = panelAuth.read(cfg, 'default').sid;
  // simulate a hot restart: re-create the in-memory cfg (as a fresh worker would) from the same state file
  const cfg2 = G.loadConfig(cfgFile);
  const st2 = panelAuth.ensure(cfg2, 'default');
  ok(st2.sid === sidBefore, '重启(ensure)后 session-id 不变');
  ok((st2.sessions && Object.keys(st2.sessions).length > 0), '会话已持久化到状态文件');
  const okAfter = await request(port, '/admin/api/instances', { cookie });
  ok(okAfter.status === 200, '同一 cookie 在(模拟)热重启后仍可访问管理 API');
  await new Promise(r => started.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nsession persist test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
