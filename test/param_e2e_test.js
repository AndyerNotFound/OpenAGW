'use strict';
/* End-to-end parameter fidelity over real HTTP.
 * Scenario: a same-dialect channel with response redaction ON. That used to force every request
 * through the canonical hub, so parameters the hub does not model (cache_control, top_k, logprobs,
 * metadata ...) never reached the upstream, and the response was rebuilt field by field.
 * Now the request keeps its exact shape, only content is masked, and the response comes back as-is
 * apart from the masked text.
 * Run: node test/param_e2e_test.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../gateway.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
function eq(a, b, m) { ok(a === b, m + ' (got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b) + ')'); }

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function startGateway(upPort, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-param-'));
  const cfgFile = path.join(dir, 'config.json');
  const cfgObj = Object.assign({
    listen: { host: '127.0.0.1', port: 0 },
    webToken: '', panel: { openBrowser: false }, modelSync: { enable: false }, probe: { enable: false },
    channels: [{ name: 'up', type: 'openai', baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'x', models: ['m'], default: true }],
  }, extra || {});
  fs.writeFileSync(cfgFile, JSON.stringify(cfgObj));
  const cfg = G.loadConfig(cfgFile);
  const started = await G.startServer(cfg, { host: '127.0.0.1', port: 0, multi: false });
  return { started, dir };
}

const KEY = 'sk-' + 'abcdefghijklmnop';
const PROJECT_BODY = () => ({
  model: 'm',
  stream: false,
  max_tokens: 64,
  temperature: 0.4,
  top_p: 0.9,
  top_k: 7,
  seed: 123,
  logprobs: true,
  top_logprobs: 3,
  user: 'u-1',
  metadata: { trace: 't-1' },
  response_format: { type: 'json_object' },
  messages: [{ role: 'user', content: [{ type: 'text', text: '联系我 alice@example.com 谢谢', cache_control: { type: 'ephemeral' } }] }],
});

(async () => {
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch (_) {}
      seen.push(j);
      if (j && j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'leak ' + KEY }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-1', object: 'chat.completion', model: 'm', system_fingerprint: 'fp_abc', service_tier: 'default',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'leak ' + KEY + ' end' },
            logprobs: { content: [{ token: 'leak', logprob: -0.1 }] } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
        }));
      }
    });
  });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const gw = await startGateway(up.address().port, { redact: { enable: true, response: true } });

  /* --- non-stream --- */
  const body = PROJECT_BODY();
  const r1 = await post(gw.started.port, '/v1/chat/completions', body);
  eq(r1.status, 200, 'e2e: HTTP 200');
  const sent = seen[0] || {};
  eq(sent.logprobs, true, 'e2e: logprobs 到达上游');
  eq(sent.top_k, 7, 'e2e: top_k 到达上游');
  eq(sent.seed, 123, 'e2e: seed 到达上游');
  eq(sent.top_logprobs, 3, 'e2e: top_logprobs 到达上游');
  eq(sent.user, 'u-1', 'e2e: user 到达上游');
  eq(sent.metadata && sent.metadata.trace, 't-1', 'e2e: metadata 到达上游');
  eq(sent.response_format && sent.response_format.type, 'json_object', 'e2e: response_format 到达上游');
  eq(sent.messages[0].content[0].cache_control.type, 'ephemeral', 'e2e: cache_control 断点保留');
  ok(sent.messages[0].content[0].text.indexOf('@') === -1, 'e2e: 正文邮箱在发出前已掩码');

  const got = JSON.parse(r1.raw);
  eq(got.system_fingerprint, 'fp_abc', 'e2e: 响应里的 provider 字段原样回传');
  eq(got.choices[0].logprobs.content[0].token, 'leak', 'e2e: 响应里的 logprobs 不被误杀');
  eq(got.usage.prompt_tokens_details.cached_tokens, 2, 'e2e: usage 明细回传');
  ok(got.choices[0].message.content.indexOf(KEY) === -1, 'e2e: 响应正文中的密钥已掩码');
  ok(got.choices[0].message.content.indexOf('end') !== -1, 'e2e: 掩码不吞掉其余字符');

  /* --- stream --- */
  const sbody = PROJECT_BODY(); sbody.stream = true;
  const r2 = await post(gw.started.port, '/v1/chat/completions', sbody);
  eq(r2.status, 200, 'e2e stream: HTTP 200');
  const sent2 = seen[1] || {};
  eq(sent2.top_k, 7, 'e2e stream: top_k 到达上游');
  eq(sent2.messages[0].content[0].cache_control.type, 'ephemeral', 'e2e stream: cache_control 保留');
  ok(r2.raw.indexOf(KEY) === -1, 'e2e stream: 流式响应没有泄漏密钥');
  ok(r2.raw.indexOf('leak') !== -1, 'e2e stream: 正常文本仍在');

  await new Promise(r => gw.started.server.close(r));
  await new Promise(r => up.close(r));
  fs.rmSync(gw.dir, { recursive: true, force: true });
  console.log(`\nparam e2e test: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
