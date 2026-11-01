'use strict';
/* Non-stream DSML cleaning regression.
 * Streaming SSE no longer cleans DSML; this file verifies the remaining
 * non-stream JSON path still scrubs parseable markup and backfills tool calls,
 * while unparseable "markup" is kept as text. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(a === b, m + ' (got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b) + ')'); }

function upstream(content) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const body = JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch (_) {}
        resolve({ status: res.statusCode, raw: txt, json: j });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

(async () => {
  const markup = '<｜DSML｜tool_calls><｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="city">北京</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const up = await upstream('好的，查询。' + markup + '完成。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-dsml-ns-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '', webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    dsmlClean: { enable: true, reasoning: true, backfill: true },
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + up.port, apiKey: 'x', models: ['m'], default: true }],
  }));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

  const r1 = await post(port, { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }], tools });
  eq(r1.status, 200, '非流式 DSML: HTTP 200');
  const m1 = r1.json && r1.json.choices && r1.json.choices[0] && r1.json.choices[0].message;
  eq(m1 && m1.content, '好的，查询。完成。', '非流式 DSML: 标记被清洗, 正文完整');
  ok(r1.raw.indexOf('DSML') < 0, '非流式 DSML: 标记未泄漏');
  eq(m1 && m1.tool_calls && m1.tool_calls[0].function.name, 'get_weather', '非流式 DSML: 回填工具名');
  eq(m1 && m1.tool_calls && m1.tool_calls[0].function.arguments, '{"city":"北京"}', '非流式 DSML: 回填参数');
  eq(r1.json && r1.json.choices[0].finish_reason, 'tool_calls', '非流式 DSML: finish_reason=tool_calls');

  up.srv.close();
  const up2 = await upstream('第一段<invoke> y z </invoke> 尾');
  const cfg2File = path.join(dir, 'config2.json');
  fs.writeFileSync(cfg2File, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '', webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    dsmlClean: { enable: true, reasoning: true, backfill: false },
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + up2.port, apiKey: 'x', models: ['m'], default: true }],
  }));
  const cfg2 = G.loadConfig(cfg2File);
  const started2 = await G.startServer(cfg2, { host: '127.0.0.1', port: 0, multi: false });
  const r2 = await post(started2.port, { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] });
  const m2 = r2.json && r2.json.choices && r2.json.choices[0] && r2.json.choices[0].message;
  eq(m2 && m2.content, '第一段<invoke> y z </invoke> 尾', '非流式 DSML: 无法解析的块按正文保留');

  await new Promise(r => started.server.close(r));
  await new Promise(r => started2.server.close(r));
  up2.srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\ndsml non-stream test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
