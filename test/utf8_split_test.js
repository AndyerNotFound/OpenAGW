'use strict';
/* UTF-8 split-chunk regression: a multi-byte char must survive TCP packet boundaries
   on BOTH legs (client->gateway request body, upstream->gateway reply). */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-utf8-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    gatewayKey: '', panel: { openBrowser: false }, modelSync: { enable: false },
    channels: [{ name: 'dummy', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-t', models: ['m'], default: true }],
  }));

// Raw-socket upstream: it splits its reply at the first byte of the first multi-byte char
  let sawBody = null;
  const upstream = await new Promise(resolve => {
    const srv = net.createServer(client => {
      let raw = Buffer.alloc(0);
      client.on('data', c => {
        raw = Buffer.concat([raw, c]);
        const i = raw.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = raw.slice(0, i + 4).toString('latin1');
        const body = raw.slice(i + 4);
        const m = head.match(/content-length: (\d+)/i);
        const total = m ? Number(m[1]) : 0;
        if (!total || body.length < total) return;
        sawBody = body;
        const reply = Buffer.concat([body, Buffer.from('\n{"ok":true}', 'utf8')]);
        client.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + reply.length + '\r\n\r\n');
        client.write(reply.slice(0, 1));
        setTimeout(() => { client.write(reply.slice(1)); client.end(); }, 60);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });

  const cfg = G.loadConfig(cfgFile);
  cfg.channels[0].baseUrl = 'http://127.0.0.1:' + upstream.port;
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  const port = started.port;

// Client splits its request body at the first byte of "你" (inside the 3-byte char)
  const payload = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '你好世界' }] });
  const buf = Buffer.from(payload, 'utf8');
  const cut = payload.indexOf('"content":"') + '"content":"'.length + 1;
  const resp = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ' + buf.length + '\r\nConnection: close\r\n\r\n');
      sock.write(buf.slice(0, cut));
      setTimeout(() => sock.write(buf.slice(cut)), 50);
    });
    let acc = Buffer.alloc(0);
    sock.on('data', c => { acc = Buffer.concat([acc, c]); });
    sock.on('error', reject);
    sock.on('close', () => resolve(acc.toString('utf8')));
  });

  ok(sawBody && !sawBody.toString('utf8').includes('\uFFFD'), '劈包请求体经网关后上游收到完整 UTF-8(无 U+FFFD)');
  ok(sawBody && sawBody.toString('utf8') === payload, '上游收到的请求体与客户端发出的一致');
  ok(!resp.includes('\uFFFD'), '网关响应(上游回包同样劈包)无 U+FFFD');
  ok(resp.includes(payload + '\n{"ok":true}'), '网关响应内容完整');

  await new Promise(r => started.server.close(r));
  upstream.srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nutf8 split test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
