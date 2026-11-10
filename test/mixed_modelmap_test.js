'use strict';
const surface = require('./_surface');
/* modelMap + models 混合配置路由测试 (2026-11-03)
 * 修复前：chanA 用 modelMap 改名命中后，chanB 的 models 列表会被短路遮蔽，永远轮不到。
 * 修复后：两个渠道都进候选。
 *   chanA: modelMap { "gpt" -> "gpt-real-a" }  (对外名 gpt，上游真实名 gpt-real-a)
 *   chanB: models ["gpt"]                       (对外名 gpt，上游同名 gpt)
 * 断言：
 *   (1) 请求 "gpt" 两个渠道都被命中 (round-robin 交替)
 *   (2) chanA 上游收到 "gpt-real-a" (改名生效)
 *   (3) chanB 上游收到 "gpt" (原名透传)
 */
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-mixmap-'));
  require('./_surface').useDir(dir);
  const PA = 45700 + Math.floor(Math.random() * 200), PB = PA + 1, GW = PA + 2;

  const gotA = [], gotB = [];
  const mk = (tag, p, seen) => http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let model = '';
      try { model = JSON.parse(b).model || ''; } catch (_) {}
      seen.push(model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'from-' + tag }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  const ma = mk('A', PA, gotA), mb = mk('B', PB, gotB);
  await new Promise(r => ma.listen(PA, '127.0.0.1', r));
  await new Promise(r => mb.listen(PB, '127.0.0.1', r));

  const apiKeys = [];
  for (let i = 1; i <= 8; i++) apiKeys.push({ name: 'u' + i, key: 'sk-k' + i });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: GW },
    apiKeys,
    panel: { openBrowser: false }, modelSync: { enable: false },
    redact: { enable: false }, retrySame: 0, connRetry: 0,
    channels: [
      { name: 'chanA', type: 'openai', baseUrl: 'http://127.0.0.1:' + PA, apiKey: 'sk-a', modelMap: { gpt: 'gpt-real-a' }, default: true },
      { name: 'chanB', type: 'openai', baseUrl: 'http://127.0.0.1:' + PB, apiKey: 'sk-b', models: ['gpt'] },
    ],
  }, null, 2));

  const gw = spawn('node', ['gateway.js', path.join(dir, 'config.json')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AGW_SINGLE: '1', AGW_HOT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLog = [];
  gw.stdout.on('data', d => gwLog.push(d.toString()));
  gw.stderr.on('data', d => gwLog.push(d.toString()));

  const waitPort = (p, tries = 120) => new Promise((res, rej) => {
    const tick = () => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.end(); res(); }); s.on('error', () => --tries > 0 ? setTimeout(tick, 150) : rej(new Error('port ' + p + ' never came up'))); }; tick();
  });
  const reqJson = (key) => new Promise((resolve) => {
    const data = JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({
      host: '127.0.0.1', port: GW, path: surface.spath('/v1/chat/completions'), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + key },
    }, res => {
      const cs = []; res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(data); req.end();
  });

  try {
    await waitPort(GW);
    // 6 个 fresh key，round-robin 会在 chanA/chanB 间交替
    for (let i = 1; i <= 6; i++) {
      const r = await reqJson('sk-k' + i);
      if (r.status !== 200) { ok(false, 'request ' + i + ' failed: ' + r.status + ' ' + r.body.slice(0, 80)); }
    }

    ok(gotA.length > 0 && gotB.length > 0,
      '(1) 两个渠道都被命中: chanA=' + gotA.length + ' chanB=' + gotB.length);
    ok(gotA.length > 0 && gotA.every(m => m === 'gpt-real-a'),
      '(2) chanA 上游收到改名后的真实名: ' + JSON.stringify(gotA));
    ok(gotB.length > 0 && gotB.every(m => m === 'gpt'),
      '(3) chanB 上游收到原名: ' + JSON.stringify(gotB));

    console.log('\nmodelMap+models 混合路由 test: ' + pass + ' passed, ' + fail + ' failed');
    if (failures.length) {
      console.error('failures:', failures.join('\n  '));
      console.error('=== GATEWAY LOG ===\n' + gwLog.join(''));
    }
  } finally {
    gw.kill('SIGKILL'); ma.close(); mb.close();
    try { fs.rmSync(dir, { recursive: true }); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });