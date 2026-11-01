'use strict';
const http = require('http');
const CHUNKS = Number(process.env.CHUNKS || 40);
const DELAY = Number(process.env.DELAY || 50);
const port = Number(process.env.UP_PORT || 39022);
http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let i = 0;
    const tick = setInterval(() => {
      i++;
      const piece = 'data: ' + JSON.stringify({
        id: 'chatcmpl-hot', object: 'chat.completion.chunk', created: Date.now(), model: 'hot-model',
        choices: [{ index: 0, delta: { content: '#' + i }, finish_reason: null }],
      }) + '\n\n';
      res.write(piece);
      if (i >= CHUNKS) {
        clearInterval(tick);
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-hot', object: 'chat.completion.chunk', created: Date.now(), model: 'hot-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, DELAY);
    res.on('close', () => clearInterval(tick));
  });
}).listen(port, '127.0.0.1', () => console.log('fake upstream on ' + port));
