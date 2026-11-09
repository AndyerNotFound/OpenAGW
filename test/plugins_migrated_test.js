'use strict';
/* Migrated ai-gateway-core plugins over real HTTP: balance / probe / legacy-import.
 * Checks the compatibility layer (src/router.js), params.authAdmin(), ctx.upstreamRequest,
 * ctx.gateway.instanceChannels / listInstances, and the admin guard on plugin routes.
 * Run: node test/plugins_migrated_test.js
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- mock upstream: /models for probe, credit_grants for balance ----
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/dashboard/billing/credit_grants')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ total_available: 12.5 }));
    }
    if (req.url.startsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-migrated-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    panel: { openBrowser: false },
    modelSync: { enable: false },
    probe: { enable: false },
    apiKeys: [{ key: 'sk-mig-key', name: 'mig' }],
    plugins: [
      { id: 'balance', enable: true },
      { id: 'probe', enable: true, config: { enable: true, intervalMin: 60, mode: 'models' } },
      { id: 'legacy-import', enable: true },
    ],
    channels: [{ name: 'mock', type: 'openai', baseUrl: 'http://127.0.0.1:' + mockPort, apiKey: 'sk-up', models: ['m'], default: true, probe: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const adminToken = panelAuth.read(cfg, 'default').adminToken;
  const admin = { 'x-agw-token': adminToken };

  // ---- bootstrap discloses the three ported plugins ----
  const bs = JSON.parse((await request(port, '/api/app/bootstrap')).body);
  const ids = bs.plugins.map(p => p.id).sort();
  ok(JSON.stringify(ids) === JSON.stringify(['balance', 'legacy-import', 'probe']), 'bootstrap: 三个迁移插件都被公示 (got ' + ids + ')');
  ok(bs.plugins.every(p => p.sha256.length === 64), 'bootstrap: 每个插件都有 sha256');

  // ---- balance: admin guard + upstream query ----
  let r = await request(port, '/plugins/balance/query?ch=mock');
  ok(r.status === 401, 'balance: 无管理员凭据 401');
  r = await request(port, '/plugins/balance/query?ch=mock', admin);
  ok(r.status === 200, 'balance: 带 x-agw-token 可查 (got ' + r.status + ' ' + r.body.slice(0, 80) + ')');
  if (r.status === 200) {
    const j = JSON.parse(r.body);
    ok(j.ok === true && j.balance === 12.5, 'balance: 上游值取到 12.5');
    ok(j.unit === 'USD', 'balance: 预设单位 USD');
  }
  r = await request(port, '/plugins/balance/query?ch=nope', admin);
  ok(r.status === 404, 'balance: 未知渠道 404');

  // ---- probe: status / run ----
  r = await request(port, '/plugins/probe/status');
  ok(r.status === 200, 'probe: status 可达');
  let pj = JSON.parse(r.body);
  ok(pj.enable === true && pj.mode === 'models', 'probe: 运行配置回显');

  r = await request(port, '/plugins/probe/run', {}, 'POST', '{}');
  ok(r.status === 401, 'probe: 触发探测需要管理员');
  r = await request(port, '/plugins/probe/run', admin, 'POST', '{}');
  ok(r.status === 200, 'probe: 管理员可触发');
  await sleep(600);
  pj = JSON.parse((await request(port, '/plugins/probe/status')).body);
  ok(pj.channels.mock && pj.channels.mock.total >= 1, 'probe: 记录了一次探测');
  ok(pj.channels.mock.rate === 100, 'probe: 成功率 100%');

  // ---- legacy-import: convert an old config ----
  const oldCfg = { channels: [{ name: 'old', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-old', models: ['x'] }], proxies: {}, apiKeys: [{ key: 'a' }] };
  r = await request(port, '/plugins/legacy-import/admin/convert', {}, 'POST', JSON.stringify({ text: JSON.stringify(oldCfg), name: 'imported' }));
  ok(r.status === 401, 'legacy-import: 无管理员凭据 401');
  r = await request(port, '/plugins/legacy-import/admin/convert', Object.assign({ 'Content-Type': 'application/json' }, admin), 'POST', JSON.stringify({ text: JSON.stringify(oldCfg), name: 'imported' }));
  ok(r.status === 200, 'legacy-import: 带凭据转换成功 (got ' + r.status + ' ' + r.body.slice(0, 120) + ')');
  if (r.status === 200) {
    const j = JSON.parse(r.body);
    ok(j.ok === true && j.name === 'imported', 'legacy-import: 实例名回显');
    ok(j.config.channels.length === 1 && j.config.channels[0].name === 'old', 'legacy-import: 渠道被转换保留');
    ok(j.summary.skipped.some(s => s.includes('apiKeys')), 'legacy-import: 不支持的字段进 skipped');
  }

  await new Promise(r => started.server.close(r));
  await new Promise(r => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nmigrated plugins: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); }); // never leave the gateway socket open on failure
