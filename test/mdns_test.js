'use strict';
/* mDNS / DNS-SD: wire format, the advertised record set, answering real UDP queries,
 * name-conflict renaming, and the http/https switch.
 * Run: node test/mdns_test.js
 */
const dgram = require('dgram');
const mdns = require('../mdns.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got=' + JSON.stringify(a) + ', want=' + JSON.stringify(b) + ')'); }

const T = mdns._types;

/* ---------- 1. name sanitizing ---------- */
eq(mdns.sanitizeName('OpenAGW'), 'openagw', '名字转小写');
eq(mdns.sanitizeName('my gw.local'), 'my-gw', '空格转连字符并去掉 .local');
eq(mdns.sanitizeName('--bad--'), 'bad', '去掉首尾连字符');
eq(mdns.sanitizeName('..'), '', '全是点时返回空(调用方回退 openagw)');
eq(mdns.sanitizeName('a'.repeat(60)).length, 40, '超长名字截到 40 字符');
eq(mdns.sanitizeName('网关'), '', '非 ASCII 不进入主机名');

/* ---------- 2. DNS wire format ---------- */
const rt = mdns.decodeName(mdns.encodeName('openagw._http._tcp.local'), 0);
eq(rt.name, 'openagw._http._tcp.local', '名字编解码往返');
eq(mdns.encodeName('local').length, 7, '单标签长度: 1+5+1');

// compression pointer: "x.local" at 12, then a pointer to offset 12
const tail = Buffer.concat([Buffer.from([1, 0x78]), mdns.encodeName('local')]);
const compressed = Buffer.concat([Buffer.alloc(12), tail, Buffer.from([0xc0, 12])]);
const dec = mdns.decodeName(compressed, 12 + tail.length);
eq(dec.name, 'x.local', '压缩指针解出完整名字');
eq(dec.next, 12 + tail.length + 2, '压缩指针后游标只前进 2 字节');

// malformed input never throws
let threw = false;
try { mdns.decodeName(Buffer.from([0xc0, 0x0c]), 0); } catch (_) { threw = true; }
ok(threw, '自指压缩指针被拒绝(不进入死循环)');
eq(mdns.parseMessage(Buffer.from([1, 2, 3])), null, '过短报文返回 null');
eq(mdns.parseMessage(Buffer.alloc(12, 0xff)), null, '计数溢出报文返回 null');

// a hand-built query parses with its unicast bit
const q = mdns.queryMessage('openagw.local', T.DNS_A);
const qp = mdns.parseMessage(q);
eq(qp.questions.length, 1, '查询解析出 1 个问题');
eq(qp.questions[0].name, 'openagw.local', '查询名字');
eq(qp.questions[0].unicast, true, 'QU 位被识别');

/* ---------- helpers: ask the responder over real UDP ---------- */
function ask(port, packet, timeoutMs) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.close(); } catch (_) {} resolve(v); };
    s.on('message', (buf) => finish(mdns.parseMessage(buf)));
    s.on('error', () => finish(null));
    s.send(packet, 0, packet.length, port, '127.0.0.1', () => {});
    setTimeout(() => finish(null), timeoutMs || 800);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return fn(); }
function rrOf(msg, name, type) {
  if (!msg) return null;
  const all = msg.answers.concat(msg.additionals || []);
  return all.find(r => r.name.toLowerCase() === String(name).toLowerCase() && r.type === type) || null;
}
function txtPairs(rdata) {
  const out = {};
  let p = 0;
  while (p < rdata.length) { const n = rdata[p]; p++; const s = rdata.toString('utf8', p, p + n); p += n; const i = s.indexOf('='); if (i > 0) out[s.slice(0, i)] = s.slice(i + 1); }
  return out;
}

/* ---------- 3. live responder (loopback, port 15353) ---------- */
(async () => {
  const IP = '192.0.2.55';
  const PORT = 15353;
  const h = mdns.apply({ enable: true, name: 'test-gw', port: 16384, tls: false, bindPort: PORT, addresses: [IP], probe: false });
  ok(!!h, 'apply 返回句柄');
  await waitFor(() => h.state === 'ok', 2000);
  eq(h.state, 'ok', '关闭探测后直接进入 ok');
  eq(h.host, 'test-gw.local', '主机名 test-gw.local');
  eq(h.url, 'http://test-gw.local:16384/v1', 'URL 带 /v1');
  eq(h.ips[0], IP, '地址表来自注入的局域网 IP');

  const ptr = await ask(PORT, mdns.queryMessage('_http._tcp.local', T.DNS_PTR));
  ok(!!ptr, 'PTR 查询有应答');
  const svc = rrOf(ptr, '_http._tcp.local', T.DNS_PTR);
  ok(!!svc, '应答含 _http._tcp.local PTR');
  eq(svc ? mdns.decodeName(svc.rdata, 0).name : '', 'OpenAGW test-gw._http._tcp.local', 'PTR 指向服务实例名');
  const srv = rrOf(ptr, 'OpenAGW test-gw._http._tcp.local', T.DNS_SRV);
  ok(!!srv, '附加段含 SRV');
  eq(srv ? srv.rdata.readUInt16BE(4) : -1, 16384, 'SRV 端口 = 网关端口');
  eq(srv ? mdns.decodeName(srv.rdata, 6).name : '', 'test-gw.local', 'SRV 目标 = 主机名');
  const txt = rrOf(ptr, 'OpenAGW test-gw._http._tcp.local', T.DNS_TXT);
  const pairs = txt ? txtPairs(txt.rdata) : {};
  eq(pairs.path, '/v1', 'TXT path=/v1');
  eq(pairs.tls, '0', 'TXT tls=0 (明文)');
  const a = rrOf(ptr, 'test-gw.local', T.DNS_A);
  eq(a ? [...a.rdata].join('.') : '', IP, '附加段含 A 记录');

  const idQuery = mdns.queryMessage('test-gw.local', T.DNS_A);
  idQuery.writeUInt16BE(0x1234, 0);
  const aOnly = await ask(PORT, idQuery);
  ok(!!rrOf(aOnly, 'test-gw.local', T.DNS_A), 'A 查询直接应答');
  eq(aOnly ? aOnly.id : -1, 0x1234, 'legacy 单播应答沿用查询 ID');
  const aTtl = rrOf(aOnly, 'test-gw.local', T.DNS_A);
  ok(aTtl && aTtl.ttl <= 10, 'legacy 应答 TTL 压到 10 秒以内');

  eq(await ask(PORT, mdns.queryMessage('_https._tcp.local', T.DNS_PTR), 500), null, '明文实例不应答 _https._tcp');
  eq(await ask(PORT, mdns.queryMessage('test-gw.local', 28), 500), null, 'AAAA 查询不应答(只发 IPv4)');
  eq(await ask(PORT, mdns.queryMessage('other.local', T.DNS_A), 500), null, '别人的名字不抢答');

  /* ---------- 4. name conflict: another host answers A with a different IP ---------- */
  const fake = mdns.buildMessage({
    answers: [{ name: 'test-gw.local', type: T.DNS_A, unique: true, ttl: 120, rdata: Buffer.from([10, 0, 0, 77]) }],
  });
  const s = dgram.createSocket('udp4');
  await new Promise(r => s.send(fake, 0, fake.length, PORT, '127.0.0.1', r));
  await sleep(1500);
  try { s.close(); } catch (_) {}
  eq(h.host, 'test-gw-2.local', 'A 记录冲突后改名 test-gw-2.local');
  eq(h.name, 'test-gw-2', '句柄 name 同步');
  const after = await ask(PORT, mdns.queryMessage('test-gw-2.local', T.DNS_A));
  ok(!!rrOf(after, 'test-gw-2.local', T.DNS_A), '改名后新名字可解析');

  /* ---------- 5. TLS instance advertises _https._tcp on its own port ---------- */
  const h2 = mdns.apply({ enable: true, name: 'test-gw', port: 8443, tls: true, bindPort: PORT, addresses: [IP], probe: false });
  await waitFor(() => h2.state === 'ok', 2000);
  ok(h2 !== h, '端口/协议变化后重建响应器');
  const ptr2 = await ask(PORT, mdns.queryMessage('_https._tcp.local', T.DNS_PTR));
  const srv2 = rrOf(ptr2, 'OpenAGW test-gw._https._tcp.local', T.DNS_SRV);
  ok(!!srv2, 'TLS 实例应答 _https._tcp');
  eq(srv2 ? srv2.rdata.readUInt16BE(4) : -1, 8443, 'TLS SRV 端口');
  eq(txtPairs(rrOf(ptr2, 'OpenAGW test-gw._https._tcp.local', T.DNS_TXT).rdata).tls, '1', 'TXT tls=1');
  eq(await ask(PORT, mdns.queryMessage('_http._tcp.local', T.DNS_PTR), 500), null, 'TLS 实例不再应答 _http._tcp');

  /* ---------- 6. disable removes the responder ---------- */
  mdns.stopAll({ goodbye: false });
  eq(mdns.current(), null, 'stopAll 之后没有活动响应器');
  eq(await ask(PORT, mdns.queryMessage('_https._tcp.local', T.DNS_PTR), 500), null, '停止后不再应答');

  console.log(`\nmdns test: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('failures:'); for (const f of failures) console.error('  ' + f); process.exitCode = 1; }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
