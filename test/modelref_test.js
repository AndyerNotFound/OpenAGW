'use strict';
/* Model reference distribution test (OpenAGW distribution merge, ported from ai-gateway-core)
 * Coverage: (1) modelref parsing / tolerant channel matching / buildRefs conflict ids
 *           (2) /v1/models exposes composite ids only for name-conflicted models
 *           (3) plain model names still round-robin across all serving channels
 *           (4) a composite reference pins the exact channel, upstream sees the real model name
 *           (5) tolerant matching: case / hyphen variants of instance+channel resolve too
 * Run: node test/modelref_test.js
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const modelref = require(path.join(ROOT, 'modelref.js'));
const { modelsResponse } = require(path.join(ROOT, 'router.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

/* (1) unit: modelref */
eq(modelref.parseRef('default:chanB:shared-model').model, 'shared-model', 'parseRef splits model');
eq(modelref.parseRef('default:chanB:ns:model:v2').model, 'ns:model:v2', 'parseRef keeps colons inside model name');
eq(modelref.parseRef('plain-model'), null, 'parseRef rejects plain names');
ok(modelref.channelMatch('Chan-B', 'chan b'), 'channelMatch tolerates case/space/hyphen');
ok(!modelref.channelMatch('chanA', 'chanB'), 'channelMatch still distinguishes channels');
{
  const refs = modelref.buildRefs([{ name: 'default', channels: [
    { name: 'chanA', models: ['shared-model', 'only-a'] },
    { name: 'chanB', models: ['shared-model'] },
  ] }]);
  const ids = refs.entries.map(e => e.id).sort();
  eq(JSON.stringify(ids), JSON.stringify(['default:chanA:shared-model', 'default:chanB:shared-model', 'only-a']),
    'buildRefs: conflicted model gets composite ids, unique model stays plain');
  eq(JSON.stringify(refs.conflicts), JSON.stringify(['shared-model']), 'buildRefs reports conflicts');
}

/* (1b) unit: modelsResponse uses refs */
{
  const cfg = { _name: 'default', channels: [
    { name: 'chanA', models: ['shared-model', 'only-a'] },
    { name: 'chanB', models: ['shared-model'] },
  ] };
  const ids = modelsResponse(cfg, 'openai').data.map(m => m.id).sort();
  eq(JSON.stringify(ids), JSON.stringify(['default:chanA:shared-model', 'default:chanB:shared-model', 'only-a']),
    'modelsResponse lists composite ids for conflicts');
}

/* (2-5) end-to-end against two distinguishable mock upstreams */
const MOCK_A = 18083, MOCK_B = 18084, GW = 16387;
function mockUpstream(port, tag) {
  return http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let model = '';
      try { model = JSON.parse(b).model || ''; } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'from-' + tag + ' model=' + model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
    });
  });
}
function reqJson(port, method, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) } }, res => {
      const cs = []; res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const waitPort = (port, tries = 80) => new Promise((res, rej) => {
  const tick = () => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.end(); res(); }); s.on('error', () => --tries > 0 ? setTimeout(tick, 250) : rej(new Error('port ' + port + ' never came up'))); };
  tick();
});

(async () => {
  const ma = mockUpstream(MOCK_A, 'A'), mb = mockUpstream(MOCK_B, 'B');
  await new Promise(r => ma.listen(MOCK_A, '127.0.0.1', r));
  await new Promise(r => mb.listen(MOCK_B, '127.0.0.1', r));
  const cfgPath = path.join(ROOT, 'data', 'config.json');
  const backup = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath) : null;
  fs.writeFileSync(cfgPath, JSON.stringify({
    listen: { host: '127.0.0.1', port: GW },
    apiKeys: [{ key: 'sk-gw' }], panel: { openBrowser: false },
    modelSync: { enable: false },
    redact: { enable: true, response: false, extra: [] },
    channels: [
      { name: 'chanA', type: 'openai', baseUrl: 'http://127.0.0.1:' + MOCK_A, apiKey: 'sk-a', models: ['shared-model', 'only-a'], default: true },
      { name: 'chanB', type: 'openai', baseUrl: 'http://127.0.0.1:' + MOCK_B, apiKey: 'sk-b', models: ['shared-model'] },
    ],
  }, null, 2));
  const gw = spawn('node', ['gateway.js'], { cwd: ROOT, env: { ...process.env, AGW_SINGLE: '1', AGW_HOT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let gwLog = '';
  gw.stdout.on('data', d => gwLog += d); gw.stderr.on('data', d => gwLog += d);
  const AUTH = { Authorization: 'Bearer sk-gw' };
  try {
    await waitPort(GW);
    /* (2) /v1/models */
    const ml = await reqJson(GW, 'GET', '/v1/models', null, AUTH);
    const ids = JSON.parse(ml.body).data.map(m => m.id);
    ok(ids.includes('default:chanA:shared-model') && ids.includes('default:chanB:shared-model'), 'models list has both composite ids: ' + ids.join(','));
    ok(!ids.includes('shared-model'), 'conflicted plain name not listed');
    ok(ids.includes('only-a'), 'unique model stays plain');

    /* (3) plain name sticks to the winning channel (prompt-cache affinity) */
    let firstChan = null;
    for (let i = 0; i < 3; i++) {
      const r = await reqJson(GW, 'POST', '/v1/chat/completions', { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
      const cBody = JSON.parse(r.body).choices[0].message.content;
      if (!firstChan) firstChan = cBody;
      else eq(cBody, firstChan, 'sticky: same key+model sticks to channel (try ' + (i + 1) + ', got ' + cBody + ')');
    }

    /* (4) composite reference pins chanB; upstream receives the real name */
    for (let i = 0; i < 3; i++) {
      const r = await reqJson(GW, 'POST', '/v1/chat/completions', { model: 'default:chanB:shared-model', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
      eq(r.headers['x-ai-gateway-channel'], 'chanB', 'ref pins chanB (try ' + (i + 1) + ')');
      eq(JSON.parse(r.body).choices[0].message.content, 'from-B model=shared-model', 'upstream got real model name');
    }

    /* (5) tolerant matching */
    const rt = await reqJson(GW, 'POST', '/v1/chat/completions', { model: 'Default:CHANB:shared-model', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    eq(rt.headers['x-ai-gateway-channel'], 'chanB', 'case-tolerant ref resolves to chanB');
  } finally {
    gw.kill('SIGKILL'); ma.close(); mb.close();
    if (backup) fs.writeFileSync(cfgPath, backup); else fs.rmSync(cfgPath, { force: true });
  }
  console.log(`\nmodelref test: ${pass} passed, ${fail} failed`);
  if (failures.length) console.error('failures:', failures.join(' ; '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
