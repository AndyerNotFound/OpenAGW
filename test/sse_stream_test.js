'use strict';
/* SSE chunking / forwarding / pass-through regression.
 * Pathological upstreams: one byte per TCP write, CRLF / bare CR line endings,
 * a final event without a trailing newline, `data:` without a space, heartbeats,
 * back-to-back events without a blank line, and invalid JSON payloads.
 * Streaming no longer cleans DSML: every byte of content (including markup) must survive. */
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');
const { SSEParser, SSEDecoder } = require('../sse.js');
const { makeDirectPipe } = require('../dsml.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b) + ')'); }

function unitTests() {
  const evs = [];
  const p = new SSEParser(e => evs.push(e));
  p.push('\uFEFFdata: {"a":"中');
  p.push('文"}\r');
  p.push('\n\r\ndata:[DONE]');
  p.end();
  eq(evs.length, 2, 'SSEParser: BOM + split CRLF + EOF flush');
  eq(evs[0].data, '{"a":"中文"}', 'SSEParser: multibyte payload intact');
  eq(evs[1].data, '[DONE]', 'SSEParser: data without space');

  const evs2 = [];
  const p2 = new SSEParser(e => evs2.push(e));
  p2.push('data: one\r'); p2.push('\r'); p2.push('data: two\n'); p2.end();
  eq(evs2.map(e => e.data).join('|'), 'one|two', 'SSEParser: bare CR line endings');

  const got = [];
  const d = new SSEDecoder(x => got.push(x));
  d.push('data: {"n":1}\ndata: {"n":2}\ndata: {"n":3}\n');
  d.end();
  eq(got.join(','), '{"n":1},{"n":2},{"n":3}', 'SSEDecoder: back-to-back JSON without blank lines');

  const got2 = [];
  const d2 = new SSEDecoder(x => got2.push(x));
  d2.push('data: {\ndata:   "text": "ok"\ndata: }\n\n');
  d2.end();
  eq(got2[0], '{\n  "text": "ok"\n}', 'SSEDecoder: multi-line JSON stays one event');

  const out = [];
  const fake = { write: s => { out.push(s); return true; }, end: () => {} };
  const pipe = makeDirectPipe(fake, [], false, false, true, { isSSE: true, appendDone: false });
  pipe.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"甲"}}\n\n');
  pipe.end();
  ok(!out.join('').includes('[DONE]'), '非 OpenAI 客户端不追加 [DONE]');

  const pipeText = (content) => {
    const chunks = [];
    const fr = { write: s => { chunks.push(s); return true; }, end: () => {} };
    const pp = makeDirectPipe(fr, [], false, false, true, { isSSE: true, appendDone: true });
    pp.push('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
    pp.push('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    pp.end();
    let text = '';
    const ee = [];
    const q = new SSEParser(e => ee.push(e));
    q.push(chunks.join('')); q.end();
    for (const e of ee) {
      if (e.data.trim() === '[DONE]') continue;
      try { const j = JSON.parse(e.data); const c = j.choices && j.choices[0]; if (c && c.delta && typeof c.delta.content === 'string') text += c.delta.content; } catch (_) {}
    }
    return text;
  };
  eq(pipeText('1 < 2 | 3'), '1 < 2 | 3', 'SSE 流: 普通比较符原样转发');
  eq(pipeText('if n < 16 the parameter is ignored'), 'if n < 16 the parameter is ignored', 'SSE 流: 普通文本不被清洗');
  eq(pipeText('a<｜DSML｜invoke name="x">b'), 'a<｜DSML｜invoke name="x">b', 'SSE 流: DSML 标记不再清洗, 原样转发');
  eq(pipeText('前缀<invoke name="x"> 正文 <b>粗</b> 后续'), '前缀<invoke name="x"> 正文 <b>粗</b> 后续', 'SSE 流: 标记与普通标签原样转发');
  eq(pipeText('x <invoke> y z </invoke> w'), 'x <invoke> y z </invoke> w', 'SSE 流: 完整标记原样转发');
  eq(pipeText('a</invoke> b'), 'a</invoke> b', 'SSE 流: 结束标记原样转发');

  {
    const out = [];
    const fake = { write: s => { out.push(s); return true; }, end: () => {} };
    const pp = makeDirectPipe(fake, [], true, true, true, { isSSE: true, appendDone: true });
    const markup = '<｜DSML｜tool_calls><｜DSML｜invoke name="x"><｜DSML｜parameter name="q">1</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    pp.push('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: markup }, finish_reason: null }] }) + '\n\n');
    pp.end();
    ok(out.join('').includes('DSML'), '流式安全阀: 即使调用方误传 dsmlOn=true 也不清洗');
  }

  const g1 = [];
  const fg1 = { write: s => { g1.push(s); return true; }, end: () => {} };
  const pg1 = makeDirectPipe(fg1, [], false, false, true, { isSSE: false, appendDone: true });
  pg1.push('data: {"a":1}\n\n'); pg1.end();
  eq((g1.join('').match(/\[DONE\]/g) || []).length, 1, '误标 Content-Type 的流: 补一个 [DONE]');
  const g2 = [];
  const fg2 = { write: s => { g2.push(s); return true; }, end: () => {} };
  const pg2 = makeDirectPipe(fg2, [], false, false, true, { isSSE: false, appendDone: true });
  pg2.push('data: {"a":1}\n\ndata: [DONE]\n\n'); pg2.end();
  eq((g2.join('').match(/\[DONE\]/g) || []).length, 1, '误标 Content-Type 的流: 不重复 [DONE]');
}

function sse(obj, eol) { eol = eol || '\n'; return 'data: ' + JSON.stringify(obj) + eol + eol; }
function delta(t) { return { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }; }
function finish(reason) { return { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason || 'stop' }] }; }

function rawUpstream(scripts) {
  const queue = Object.keys(scripts).map(k => scripts[k]);
  let qi = 0;
  return new Promise(resolve => {
    const srv = net.createServer(sock => {
      let buf = Buffer.alloc(0);
      sock.on('data', c => {
        buf = Buffer.concat([buf, c]);
        const at = buf.indexOf('\r\n\r\n');
        if (at < 0) return;
        const script = queue[qi++] || '';
        const body = Buffer.from(script, 'utf8');
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

function requestStream(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions?' + route, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const events = [];
        const p = new SSEParser(e => events.push(e));
        p.push(raw); p.end();
        let text = '', dones = 0, bad = 0, finishReason = null, toolName = '', toolArgs = '';
        for (const ev of events) {
          if (ev.data.trim() === '[DONE]') { dones++; continue; }
          try {
            const j = JSON.parse(ev.data);
            const c0 = j.choices && j.choices[0];
            if (c0 && c0.delta && typeof c0.delta.content === 'string') text += c0.delta.content;
            if (c0 && Array.isArray(c0.delta && c0.delta.tool_calls)) for (const tc of c0.delta.tool_calls) {
              if (tc.function && tc.function.name) toolName = tc.function.name;
              if (tc.function && typeof tc.function.arguments === 'string') toolArgs += tc.function.arguments;
            }
            if (c0 && c0.finish_reason) finishReason = c0.finish_reason;
          } catch (_) { bad++; }
        }
        resolve({ status: res.statusCode, raw, events, text, dones, bad, finishReason, toolName, toolArgs });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

(async () => {
  unitTests();

  const plain = '开头中文🚀 middle <div>a < b</div> 结尾';
  const dsmlText = '好的，我来查询。';
  const dsmlMarkup = '<｜DSML｜tool_calls><｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="city">北京</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const dsmlTail = '查询完成，北京晴天。';
  const scripts = {
    crlf: sse(delta('你')) + sse(delta('好🚀')) + sse(delta('，世界')) + 'data: ' + JSON.stringify(finish()) ,
    spaces: sse(delta('A')) + sse(delta(' ')) + sse(delta('B')) + sse(delta('\n')) + sse(delta('C')) + sse(finish()),
    dsml: sse(delta(dsmlText)) + sse(delta(dsmlMarkup)) + sse(delta(' ')) + sse(delta(dsmlTail)) + sse(finish()),
    nospace: 'event: message\ndata:' + JSON.stringify(delta('无空格')) + '\n\n: heartbeat\n\n' + 'data:' + JSON.stringify(finish()) + '\n\n',
    broken: 'data: {not json}\n\n' + sse(delta('后续内容')) + sse(finish()),
    joined: 'data: ' + JSON.stringify(delta('一')) + '\ndata: ' + JSON.stringify(delta('二')) + '\ndata: ' + JSON.stringify(finish()) + '\n',
    cr: (sse(delta('甲'), '\r') + sse(delta('乙'), '\r') + sse(finish(), '\r')),
    eof: sse(delta('最后一')) + sse(delta('个字')) + 'data: ' + JSON.stringify(finish()) + '\ndata: [DONE]',
    unknown: sse(delta('三段')) ,
    backfill: sse(delta('准备调用')) + sse(delta('<｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="city">北京</｜DSML｜parameter></｜DSML｜invoke>')) + 'data: [DONE]',
  };
  scripts.unknown = scripts.unknown + sse(delta('合一')) + sse(finish()) + 'data: [DONE]\n\n';

  const up = await rawUpstream(scripts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-sse-'));
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
  const base = { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] };

  const r1 = await requestStream(port, 'crlf', base);
  eq(r1.status, 200, 'CRLF 流式请求 200');
  eq(r1.text, '你好🚀，世界', 'CRLF + 逐字节劈包: 内容一字不差');
  eq(r1.dones, 1, 'CRLF: 恰好一个 [DONE]');
  eq(r1.bad, 0, 'CRLF: 客户端无坏事件');

  const r2 = await requestStream(port, 'spaces', base);
  eq(r2.text, 'A B\nC', '仅空白增量不被清洗丢弃');

  const r3 = await requestStream(port, 'dsml', base);
  eq(r3.text, dsmlText + dsmlMarkup + ' ' + dsmlTail, 'SSE 流不再清洗 DSML: 正文与标记原样到达');
  ok(r3.raw.includes('DSML'), 'SSE 流: DSML 标记按原样转发');

  const r4 = await requestStream(port, 'nospace', base);
  eq(r4.text, '无空格', 'data: 无空格 + event 字段 + 心跳');
  eq(r4.dones, 1, 'data: 无空格时由网关补齐 [DONE]');

  const r5 = await requestStream(port, 'broken', base);
  ok(r5.raw.includes('data: {not json}'), '非法 JSON 事件原样转发(未丢失)');
  eq(r5.text, '后续内容', '非法 JSON 之后的内容仍完整');

  const r6 = await requestStream(port, 'joined', base);
  eq(r6.text, '一二', '缺失空行的背靠背事件逐条还原');
  eq(r6.dones, 1, '缺失空行: 只补一个 [DONE], 不重复');

  const r7 = await requestStream(port, 'cr', base);
  eq(r7.text, '甲乙', '裸 CR 行尾: 内容完整');

  const r8 = await requestStream(port, 'eof', base);
  eq(r8.text, '最后一个字', '末事件无换行 + [DONE] 无换行: 不丢字');
  eq(r8.dones, 1, '末事件无换行: 仍只有一个 [DONE]');

  const r9 = await requestStream(port, 'unknown', base);
  eq(r9.text, '三段合一', '普通内容 + [DONE] 收尾');
  eq(r9.dones, 1, '普通内容: 一个 [DONE]');

  const toolReq = Object.assign({}, base, {
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  });
  const r10 = await requestStream(port, 'backfill', toolReq);
  eq(r10.text, '准备调用<｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="city">北京</｜DSML｜parameter></｜DSML｜invoke>', 'SSE 流: 文本调用标记不再回填/清洗');
  eq(r10.toolName, '', 'SSE 流: 不合成 tool_calls');
  eq(r10.toolArgs, '', 'SSE 流: 不合成工具参数');
  eq(r10.finishReason, null, 'SSE 流: 不伪造 finish_reason');
  eq(r10.dones, 1, 'SSE 流: 仍有且只有一个 [DONE]');
  ok(!r10.raw.includes('"tool_calls"'), 'SSE 流: 线上没有 tool_calls');

  await new Promise(r => started.server.close(r));
  up.srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nsse stream test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
