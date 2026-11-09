'use strict';
/* Plugins over real HTTP: /api/app/bootstrap, /plugins dispatch, and the closed
 * prefixes that must stay closed. In-process gateway, port 0.
 * Run: node test/plugins_e2e_test.js
 */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-plug-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    apiKeys: [{ key: 'sk-e2e-key', name: 'e2e' }],
    plugins: [{ id: 'hello', enable: true }],
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;

  // ---- bootstrap ----
  const bs = await request(port, '/api/app/bootstrap');
  ok(bs.status === 200, '/api/app/bootstrap 200');
  const b = JSON.parse(bs.body);
  ok(b.ok === true, 'bootstrap.ok');
  ok(typeof b.core === 'string' && b.core.length > 0, 'bootstrap.core 版本串');
  ok(b.appApi === 1, 'bootstrap.appApi = 1');
  ok(b.branch === 'default', 'bootstrap.branch = default');
  ok(b.auth && b.auth.cardkey === true, 'bootstrap.auth.cardkey 已启用');
  ok(Array.isArray(b.layout.bottomBar) && b.layout.bottomBar.length === 3, 'bootstrap.layout 默认三格');
  ok(Array.isArray(b.plugins) && b.plugins.length === 1, 'bootstrap.plugins 只列启用的插件');
  const p0 = b.plugins[0];
  ok(p0.id === 'hello', 'bootstrap 插件 id');
  ok(typeof p0.sha256 === 'string' && p0.sha256.length === 64, 'bootstrap 插件 sha256 公示');
  ok(Array.isArray(p0.permissions) && p0.permissions.includes('storage'), 'bootstrap 插件权限公示');
  ok(Array.isArray(p0.capabilities), 'bootstrap 插件 capabilities 字段存在');
  ok(b.adminUi && b.adminUi.version === 1 && Array.isArray(b.adminUi.pages), 'bootstrap.adminUi 结构');
  ok(Array.isArray(b.capabilities), 'bootstrap.capabilities 结构');
  ok(Array.isArray(b.themes) && b.themes[0].locked === true, 'bootstrap.themes 必有锁定默认主题');

  // ---- plugin dispatch ----
  const ping = await request(port, '/plugins/hello/ping?key=sk-e2e-key');
  ok(ping.status === 200, '/plugins/<id>/<route> 可达');
  const pj = JSON.parse(ping.body);
  ok(pj.ok === true && pj.msg === 'pong', '插件路由返回业务内容');
  ok(pj.instance === 'default', '插件看得到自己的实例名');

  const list = await request(port, '/plugins', { accept: 'application/json' });
  ok(list.status === 200 && JSON.parse(list.body).plugins.some(p => p.id === 'hello'), '/plugins 列表返回启用插件');

  const miss = await request(port, '/plugins/hello/nothing-here');
  ok(miss.status === 404, '插件内未知路径 404');
  const unknown = await request(port, '/plugins/not-installed/x');
  ok(unknown.status === 404, '未启用插件 404');

  // ---- prefixes that must stay closed ----
  const health = await request(port, '/health');
  ok(health.status === 404, '/health 仍然关闭');
  const models = await request(port, '/api/app/models');
  ok(models.status === 404, '/api/app/<未实现> 返回 404 而不是穿透');

  await new Promise(r => started.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nplugins e2e: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
