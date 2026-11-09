'use strict';
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const MOCK = 43331, GW = 43332;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-sticky-'));
const cfgPath = path.join(dir, 'config.json');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got=' + JSON.stringify(a) + ', want=' + JSON.stringify(b) + ')'); }

// Single mock upstream that records which apiKey it saw
const mockChans = {};
http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    const auth = String(req.headers.authorization || '').replace('Bearer ', '');
    mockChans[auth] = (mockChans[auth] || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + auth }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
}).listen(MOCK, '127.0.0.1');

function reqJson(port, payload, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(headers || {}) },
    }, res => {
      const cs = []; res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(data); req.end();
  });
}

const waitPort = (port, tries = 120) => new Promise((res, rej) => {
  const tick = () => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.end(); res(); }); s.on('error', () => --tries > 0 ? setTimeout(tick, 200) : rej(new Error('port ' + port + ' never came up'))); }; tick();
});

(async () => {
  fs.writeFileSync(cfgPath, JSON.stringify({
    listen: { host: '127.0.0.1', port: GW },
    apiKeys: [
      { name: 'user3', key: 'sk-admin' },
      { name: 'user1', key: 'sk-key1' },
      { name: 'user2', key: 'sk-key2' },
    ],
    panel: { openBrowser: false }, modelSync: { enable: false },
    redact: { enable: false }, retrySame: 0, connRetry: 0,
    channels: [
      { name: 'chanA', type: 'openai', baseUrl: 'http://127.0.0.1:' + MOCK, apiKey: 'up-a', models: ['gpt'], default: true },
      { name: 'chanB', type: 'openai', baseUrl: 'http://127.0.0.1:' + MOCK, apiKey: 'up-b', models: ['gpt'] },
    ],
  }, null, 2));

  const gw = spawn('node', ['gateway.js', cfgPath], {
    cwd: __dirname + '/..',
    env: { ...process.env, AGW_SINGLE: '1', AGW_HOT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLog = [];
  gw.stdout.on('data', d => gwLog.push(d.toString()));
  gw.stderr.on('data', d => gwLog.push(d.toString()));

  try {
    await waitPort(GW);
    const H1 = { Authorization: 'Bearer sk-key1' };
    const H2 = { Authorization: 'Bearer sk-key2' };
    const HA = { Authorization: 'Bearer sk-admin' };

    /* (1) Same key+model sticks */
    let first = null;
    for (let i = 0; i < 4; i++) {
      const r = await reqJson(GW, { model: 'gpt', messages: [{ role: 'user', content: 'hi' }] }, H1);
      const j = JSON.parse(r.body);
      const ch = j.choices[0].message.content;
      if (!first) first = ch;
      else eq(ch, first, '(1) key1 sticky all→' + first.split('-')[1].slice(0,4) + ' (try ' + (i + 1) + ')');
    }

    /* (2) Different key gets independent sticky slot */
    let k2first = null;
    for (let i = 0; i < 3; i++) {
      const r = await reqJson(GW, { model: 'gpt', messages: [{ role: 'user', content: 'hi' }] }, H2);
      const j = JSON.parse(r.body);
      const ch = j.choices[0].message.content;
      if (!k2first) k2first = ch;
      else eq(ch, k2first, '(2) key2 sticky all→' + k2first.split('-')[1].slice(0,4) + ' (try ' + (i + 1) + ')');
    }
    // note: key1/key2 landing on the same channel is legitimate (RR start offset),
    // the invariant is only that each key sticks to ONE channel — already asserted above.

    /* (3) Admin key (userKey=null → stickyKey="anon|gpt") gets its own sticky */
    let afirst = null;
    for (let i = 0; i < 3; i++) {
      const r = await reqJson(GW, { model: 'gpt', messages: [{ role: 'user', content: 'hi' }] }, HA);
      const j = JSON.parse(r.body);
      const ch = j.choices[0].message.content;
      if (!afirst) afirst = ch;
      else eq(ch, afirst, '(3) admin sticky all→' + afirst.split('-')[1].slice(0,4) + ' (try ' + (i + 1) + ')');
    }

    console.log('\nsticky test: ' + pass + ' passed, ' + fail + ' failed');
    if (failures.length) {
      console.error('failures:');
      for (const f of failures) console.error('  ' + f);
      console.error('=== GATEWAY LOG ===');
      console.error(gwLog.join(''));
    }
  } finally {
    gw.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });