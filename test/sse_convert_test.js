'use strict';
/* Cross-format SSE conversion + response redaction at pathological chunk boundaries.
 * Upstream writes one byte at a time (UTF-8 characters and CRLF get split) and the
 * final event has no trailing newline. Nothing may be lost on the conversion path. */
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');
const { SSEParser } = require('../sse.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(a === b, m + ' (got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b) + ')'); }

function sse(obj, eol) { eol = eol || '\n'; return 'data: ' + JSON.stringify(obj) + eol + eol; }
function delta(t) { return { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }; }
function finish() { return { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }; }

function rawUpstream(scripts) {
  const queue = scripts.slice();
  let qi = 0;
  return new Promise(resolve => {
    const srv = net.createServer(sock => {
      let buf = Buffer.alloc(0);
      sock.on('data', c => {
        buf = Buffer.concat([buf, c]);
        if (buf.indexOf('\r\n\r\n') < 0) return;
        const body = Buffer.from(queue[qi++] || '', 'utf8');
        sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ' + body.length + '\r\nConnection: close\r\n\r\n');
        let i = 0;
        const tick = setInterval(() => {
          if (i >= body.length) { clearInterval(tick); sock.end(); return; }
          sock.write(body.slice(i, i + 1));
          i++;
        }, 1);
        sock.on('close', () => clearInterval(tick));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x', 'x-api-key': 'x' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, raw });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function parseOpenAIText(raw) {
  const events = [];
  const p = new SSEParser(e => events.push(e));
  p.push(raw); p.end();
  let text = '', dones = 0, bad = 0, finishReason = null;
  for (const ev of events) {
    if (ev.data.trim() === '[DONE]') { dones++; continue; }
    try {
      const j = JSON.parse(ev.data);
      const c0 = j.choices && j.choices[0];
      if (c0 && c0.delta && typeof c0.delta.content === 'string') text += c0.delta.content;
      if (c0 && c0.finish_reason) finishReason = c0.finish_reason;
    } catch (_) { bad++; }
  }
  return { text, dones, bad, finishReason, events };
}

function parseClaudeText(raw) {
  const events = [];
  const p = new SSEParser(e => events.push(e));
  p.push(raw); p.end();
  let text = '', bad = 0, stopped = false;
  for (const ev of events) {
    try {
      const j = JSON.parse(ev.data);
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') text += j.delta.text;
      if (j.type === 'message_stop') stopped = true;
    } catch (_) { bad++; }
  }
  return { text, bad, stopped, events };
}

async function startGateway(upPort, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-ssec-'));
  const cfgFile = path.join(dir, 'config.json');
  const cfgObj = Object.assign({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '', webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    dsmlClean: { enable: true, reasoning: true, backfill: false },
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'x', models: ['m'], default: true }],
  }, extra || {});
  fs.writeFileSync(cfgFile, JSON.stringify(cfgObj));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  return { started, dir };
}

(async () => {
  const text = '转换路径：中文🚀 <div>a < b</div> 结尾';
  const script = sse(delta('转换路径：')) + sse(delta('中文🚀 ')) + sse(delta('<div>a < b</div> ')) + sse(delta('结尾')) + 'data: ' + JSON.stringify(finish()) + '\ndata: [DONE]';
  const script2 = 'data:' + JSON.stringify(delta('跨')) + '\n' + 'data:' + JSON.stringify(delta('行')) + '\n' + 'data:' + JSON.stringify(finish()) + '\ndata: [DONE]';
  const markup = '<｜DSML｜tool_calls><｜DSML｜invoke name="x"><｜DSML｜parameter name="q">1</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const script3 = sse(delta('前')) + sse(delta(markup)) + sse(delta('后')) + sse(finish()) + 'data: [DONE]';
  const up = await rawUpstream([script, script2, script3]);
  const gw1 = await startGateway(up.port);
  const r1 = await post(gw1.started.port, '/v1/messages', {
    model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }],
  });
  const c1 = parseClaudeText(r1.raw);
  eq(r1.status, 200, 'Claude 转换: HTTP 200');
  eq(c1.text, text, 'Claude 转换: 逐字节劈包后正文完整');
  ok(c1.stopped, 'Claude 转换: 收到 message_stop');
  eq(c1.bad, 0, 'Claude 转换: 无坏事件');

  const r1b = await post(gw1.started.port, '/v1/messages', {
    model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }],
  });
  const c1b = parseClaudeText(r1b.raw);
  eq(c1b.text, '跨行', 'Claude 转换: 缺失空行的背靠背事件逐条还原');

  const r1c = await post(gw1.started.port, '/v1/messages', {
    model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }],
  });
  const c1c = parseClaudeText(r1c.raw);
  eq(c1c.text, '前' + markup + '后', 'Claude 转换: 流式 DSML 不再清洗, 标记原样到达');

  const up2 = await rawUpstream([
    sse(delta('前段 sk-abc')) + sse(delta('defghijklmnopqrstuvwx')) + sse(delta(' 后段')) + 'data: ' + JSON.stringify(finish()) + '\ndata: [DONE]',
    sse(delta('结尾 ')) + sse(delta('sk-')) + sse(delta('abcdefghijklmnopqrstuvwx')) + 'data: ' + JSON.stringify(finish()) + '\ndata: [DONE]',
  ]);
  const gw2 = await startGateway(up2.port, { redact: { enable: true, response: true } });
  const r2 = await post(gw2.started.port, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const o2 = parseOpenAIText(r2.raw);
  eq(r2.status, 200, '响应脱敏: HTTP 200');
  eq(o2.text, '前段 *** 后段', '响应脱敏: 跨分块的密钥被完整掩码, 其余字符不丢');
  ok(!r2.raw.includes('sk-abcdefghijklmnopqrstuvwx'), '响应脱敏: 原始密钥未泄漏');
  eq(o2.dones, 1, '响应脱敏: 一个 [DONE]');

  const r3 = await post(gw2.started.port, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const o3 = parseOpenAIText(r3.raw);
  eq(o3.text, '结尾 ***', '响应脱敏: 流末尾的密钥在 flush 时仍被掩码');

  const claudeUp = await rawUpstream([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
    + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"结尾<"}}\n\n'
    + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const gw3 = await startGateway(claudeUp.port, { channels: [{ name: 'cl', type: 'claude', baseUrl: 'http://127.0.0.1:' + claudeUp.port, apiKey: 'x', models: ['m'], default: true }] });
  const r4 = await post(gw3.started.port, '/v1/messages', { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const c4 = parseClaudeText(r4.raw);
  eq(c4.text, '结尾<', 'Claude 直通: 流尾未闭合的普通字符不丢');
  ok(!r4.raw.includes('[DONE]'), 'Claude 直通: 不追加 [DONE]');
  ok(r4.raw.includes('event: content_block_delta'), 'Claude 直通: 延迟字符补发时保留 event 名');
  let badName = 0;
  for (const ev of c4.events) {
    try { const j = JSON.parse(ev.data); if (j.type === 'content_block_delta' && ev.event !== 'content_block_delta') badName++; } catch (_) {}
  }
  eq(badName, 0, 'Claude 直通: 每个 content_block_delta 的 event 名与 data.type 一致');
  const stopAt = r4.raw.indexOf('event: message_stop');
  const lastDeltaAt = r4.raw.lastIndexOf('event: content_block_delta');
  ok(stopAt > 0 && lastDeltaAt >= 0 && lastDeltaAt < stopAt, 'Claude 直通: 延迟字符在 message_stop 之前补发');

  await new Promise(r => gw1.started.server.close(r));
  await new Promise(r => gw2.started.server.close(r));
  await new Promise(r => gw3.started.server.close(r));
  up.srv.close(); up2.srv.close(); claudeUp.srv.close();
  fs.rmSync(gw1.dir, { recursive: true, force: true });
  fs.rmSync(gw2.dir, { recursive: true, force: true });
  fs.rmSync(gw3.dir, { recursive: true, force: true });
  console.log(`\nsse convert test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
