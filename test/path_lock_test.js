'use strict';
/* Channel-level `path` lock + fixed passthrough behavior.
 * - path set: every request (chat, messages, responses, images, unknown /v1/*)
 *   goes to baseUrl + path; client path and query are ignored.
 * - path unset: conversion endpoints use their dialect path, other /v1/*
 *   requests pass through with client path + query.
 * - legacy openaiExtras=true/false is ignored (parameter removed; fixed on).
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(a === b, m + ' (got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b) + ')'); }

function chatBody(model) {
  return JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}
function responsesBody() {
  return JSON.stringify({ id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: 'm', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
}

(async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw });
      let text;
      let parsed = null; try { parsed = JSON.parse(raw); } catch (_) {}
      if (req.url.indexOf('/images/') >= 0 || req.url.indexOf('/foo/') >= 0) text = JSON.stringify({ data: [{ url: 'x' }] });
      else if (parsed && (parsed.input !== undefined || parsed.instructions !== undefined)) text = responsesBody();
      else text = chatBody('m');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-path-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '', webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    openaiExtras: { enable: false, upstreamResponses: true },   // legacy, must be ignored
    channels: [
      { name: 'lock', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort + '/relay', path: 'custom/chat?fixed=1', apiKey: 'x', models: ['lock'] },
      { name: 'plain', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort + '/plain', apiKey: 'x', models: ['plain'], default: true },
    ],
  }));
  const cfg = G.loadConfig(cfgFile);
  eq(cfg.channels[0].path, '/custom/chat?fixed=1', '配置加载: path 自动补前导 /');
  eq(cfg.channels[1].path, null, '配置加载: 未配置 path = null');

  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;
  const post = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });

  const r1 = await post('/v1/chat/completions?client=1', JSON.stringify({ model: 'lock', stream: false, messages: [{ role: 'user', content: 'hi' }] }));
  eq(r1.status, 200, '锁定 path: chat 200');
  eq(hits[hits.length - 1].url, '/relay/custom/chat?fixed=1', '锁定 path: chat 走 baseUrl+path, 忽略客户端 query');

  const r2 = await post('/v1/images/generations?client=2', JSON.stringify({ model: 'lock', prompt: 'x' }));
  eq(r2.status, 200, '锁定 path: images 200');
  eq(hits[hits.length - 1].url, '/relay/custom/chat?fixed=1', '锁定 path: 扩展端点也走固定 path');

  const r3 = await post('/v1/messages', JSON.stringify({ model: 'lock', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
  eq(r3.status, 200, '锁定 path: 跨格式 Claude 200');
  eq(hits[hits.length - 1].url, '/relay/custom/chat?fixed=1', '锁定 path: 跨格式转换也走固定 path');

  const r4 = await post('/v1/chat/completions', JSON.stringify({ model: 'plain', stream: false, messages: [{ role: 'user', content: 'hi' }] }));
  eq(r4.status, 200, '未锁定: chat 200');
  eq(hits[hits.length - 1].url, '/plain/v1/chat/completions', '未锁定: chat 使用方言固定路径');

  const r5 = await post('/v1/images/generations?x=1', JSON.stringify({ model: 'plain', prompt: 'x' }));
  eq(r5.status, 200, '未锁定: images 200');
  eq(hits[hits.length - 1].url, '/plain/v1/images/generations?x=1', '未锁定: 扩展端点透传 path+query');

  const r6 = await post('/v1/responses', JSON.stringify({ model: 'plain', input: 'hi' }));
  eq(r6.status, 200, 'Responses: 即使旧 openaiExtras=false 也启用');
  eq(hits[hits.length - 1].url, '/plain/v1/responses', 'Responses: 固定启用 + 上游路径');

  const r7 = await post('/v1/foo/bar?z=1', JSON.stringify({ model: 'plain', x: 1 }));
  eq(r7.status, 200, '未知 /v1/*: 透传 200');
  eq(hits[hits.length - 1].url, '/plain/v1/foo/bar?z=1', '未知 /v1/*: 默认透传 path+query');

  await new Promise(r => started.server.close(r));
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\npath lock test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
