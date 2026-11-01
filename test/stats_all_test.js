'use strict';
// /admin/api/stats-all: one call for the app's statistics tab.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { utf8 } = require('../util.js');
const G = require('../gateway.js');

const u8p = utf8();
let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function request(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, res => {
      let out = ''; res.on('data', c => out += u8p(c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-statsall-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: 'stats-token',
    panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['m'], default: true }],
    apiKeys: [],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  cfg._stats.requests = 7; cfg._stats.errors = 1;
  cfg._stats.byChannel = { dummy: { requests: 7, errors: 1, inputTokens: 1200, outputTokens: 800 } };
  cfg._stats.byModel = { 'gpt-4o': { requests: 7, inputTokens: 1200, outputTokens: 800, cached: 0 } };

  const r = await request(started.port, '/admin/api/stats-all', { 'x-agw-token': 'stats-token' });
  ok(r.status === 200, 'stats-all 200');
  let j = {};
  try { j = JSON.parse(r.body); } catch (_) {}
  ok(j.totals && j.totals.requests === 7, 'totals.requests 汇总');
  ok(j.totals && j.totals.inputTokens === 1200 && j.totals.outputTokens === 800, 'totals token 汇总');
  ok(Array.isArray(j.instances) && j.instances.length === 1, '实例列表');
  ok(j.instances && j.instances[0].name === 'default', '实例名');
  ok(j.instances && j.instances[0].byChannel && j.instances[0].byChannel.dummy, '实例内渠道数据');
  ok(j.byModel && j.byModel['gpt-4o'] && j.byModel['gpt-4o'].requests === 7, '全局模型汇总');

  const noauth = await request(started.port, '/admin/api/stats-all');
  ok(noauth.status === 401, '无 token 401');

  if (started.server && started.server.close) started.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
