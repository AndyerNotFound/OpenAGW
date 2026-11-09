'use strict';
/**
 * mDNS responder + DNS-SD advertisement — zero dependencies (RFC 6762 / RFC 6763).
 *
 * Purpose: give the gateway a stable LAN address, `<name>.local`, instead of the DHCP
 * address that changes every time the phone rejoins a network.
 *
 * Deliberately small:
 *   - A records only (IPv4 LAN addresses); AAAA buys nothing for a local gateway.
 *   - Answer-only: nothing is cached, no browsing, no unicast DNS server.
 *   - The interface set is polled every 15 s, so a Wi-Fi change re-announces by itself.
 *   - SO_REUSEADDR, so a hot restart can overlap with the worker it replaces.
 *   - Packets come from the LAN and are treated as untrusted input: every read is
 *     bounds-checked and a malformed packet is dropped, never thrown.
 */
const dgram = require('dgram');
const os = require('os');
const { VERSION, log, logErr } = require('./util');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const DNS_A = 1, DNS_PTR = 12, DNS_TXT = 16, DNS_SRV = 33, DNS_ANY = 255;
const CLASS_IN = 1, CLASS_ANY = 255;
const CACHE_FLUSH = 0x8000;
const TTL_HOST = 120;
const TTL_SERVICE = 4500;
const PROBE_QUERIES = 3;
const PROBE_GAP_MS = 250;
const ANNOUNCE_REPEAT = 2;
const REFRESH_MS = 60000;
const POLL_MS = 15000;
const MAX_CONFLICTS = 6;

/* Interfaces that never carry the LAN: loopback, tunnels/VPN, cellular PDP, container bridges. */
const VIRTUAL_IF = /^(lo\d*|tun\d*|tap\d*|wg\d*|utun\d*|ppp\d*|ipsec\d*|sit\d+|dummy\d*|ifb\d*|clat\d*|vgate\d*|v4-|rmnet|ccmni|pdp|docker\d*|veth|virbr|br-)/i;

// ================= LAN addresses =================
function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // carrier-grade NAT
  return false;
}

// Advertisable LAN addresses, physical interfaces first. 198.18/15 (fake-ip DNS) is not private, so it never lands here.
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const a of ifs[name] || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !isPrivateIPv4(a.address)) continue;
      out.push({ iface: name, address: a.address });
    }
  }
  const rank = n => (/^(wlan|eth|ap|swlan|rndis|usb)/i.test(n) ? 0 : 1);
  out.sort((a, b) => rank(a.iface) - rank(b.iface) || a.iface.localeCompare(b.iface) || a.address.localeCompare(b.address));
  const seen = new Set();
  return out.filter(x => (seen.has(x.address) ? false : (seen.add(x.address), true)));
}

// Every address this host owns: a packet from one of them is our own multicast echoed back (or another
// gateway on the same phone) and must not be answered or mistaken for a name conflict.
function selfAddresses() {
  const s = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) s.add(a.address);
  }
  return s;
}

function sanitizeName(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  s = s.replace(/\.local\.?$/, '');
  s = s.replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, '');
  return s;
}

// ================= DNS wire format =================
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }

function encodeName(name) {
  const parts = [];
  for (const label of String(name).replace(/\.$/, '').split('.')) {
    if (!label) continue;
    const b = Buffer.from(label, 'utf8');
    if (b.length > 63) throw new Error('mDNS 名字段超过 63 字节: ' + label);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeName(buf, off) {
  const labels = [];
  let p = off, next = -1, jumps = 0;
  for (;;) {
    if (p >= buf.length) throw new Error('名字越界');
    const len = buf[p];
    if (len === 0) { p += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (p + 1 >= buf.length) throw new Error('压缩指针越界');
      if (next < 0) next = p + 2;
      const ptr = ((len & 0x3f) << 8) | buf[p + 1];
      if (++jumps > 16) throw new Error('压缩指针嵌套过深');
      if (ptr >= p) throw new Error('压缩指针未指向前文');
      p = ptr;
      continue;
    }
    if (len & 0xc0) throw new Error('非法标签长度');
    if (p + 1 + len > buf.length) throw new Error('标签越界');
    labels.push(buf.toString('utf8', p + 1, p + 1 + len));
    p += 1 + len;
    if (labels.length > 32) throw new Error('标签过多');
  }
  return { name: labels.join('.'), next: next < 0 ? p : next };
}

function parseMessage(buf) {
  if (!buf || buf.length < 12) return null;
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  if (qd > 64 || an > 256 || ns > 256 || ar > 256) return null;
  try {
    let off = 12;
    const questions = [];
    for (let i = 0; i < qd; i++) {
      const d = decodeName(buf, off); off = d.next;
      if (off + 4 > buf.length) return null;
      const type = buf.readUInt16BE(off), qclass = buf.readUInt16BE(off + 2);
      off += 4;
      questions.push({ name: d.name, type, cls: qclass & 0x7fff, unicast: !!(qclass & 0x8000) });
    }
    const readRRs = (count, sink) => {
      for (let i = 0; i < count; i++) {
        const d = decodeName(buf, off); off = d.next;
        if (off + 10 > buf.length) return false;
        const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2);
        const ttl = buf.readUInt32BE(off + 4), rdlen = buf.readUInt16BE(off + 8);
        off += 10;
        if (off + rdlen > buf.length) return false;
        sink.push({ name: d.name, type, cls: cls & 0x7fff, ttl, rdata: buf.subarray(off, off + rdlen) });
        off += rdlen;
      }
      return true;
    };
    const answers = [], authorities = [], additionals = [];
    if (!readRRs(an, answers) || !readRRs(ns, authorities) || !readRRs(ar, additionals)) return null;
    return { id: buf.readUInt16BE(0), flags: buf.readUInt16BE(2), questions, answers, authorities, additionals };
  } catch (_) {
    return null;
  }
}

function ipRdata(ip) {
  const b = Buffer.alloc(4);
  String(ip).split('.').forEach((n, i) => { b[i] = Number(n) & 0xff; });
  return b;
}
function srvRdata(port, target) {
  const h = Buffer.alloc(6);
  h.writeUInt16BE(0, 0);
  h.writeUInt16BE(0, 2);
  h.writeUInt16BE(port & 0xffff, 4);
  return Buffer.concat([h, encodeName(target)]);
}
function txtRdata(pairs) {
  const out = [];
  for (const [k, v] of Object.entries(pairs || {})) {
    if (v == null || v === '') continue;
    let s = Buffer.from(k + '=' + v, 'utf8');
    if (s.length > 255) s = s.subarray(0, 255);
    out.push(Buffer.from([s.length]), s);
  }
  if (!out.length) out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function rr(bufParts) { return Buffer.concat(bufParts); }
function encodeRecord(r, legacy, goodbye) {
  const ttl = goodbye ? 0 : (legacy ? Math.min(r.ttl, 10) : r.ttl);
  const cls = legacy ? CLASS_IN : (r.unique ? CLASS_IN | CACHE_FLUSH : CLASS_IN);
  return rr([encodeName(r.name), u16(r.type), u16(cls), u32(ttl), u16(r.rdata.length), r.rdata]);
}

function buildMessage({ id = 0, questions = [], answers = [], additionals = [], legacy = false, goodbye = false }) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(legacy ? id : 0, 0);
  head.writeUInt16BE(0x8400, 2);                      // response + authoritative
  head.writeUInt16BE(legacy ? questions.length : 0, 4);
  head.writeUInt16BE(answers.length, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(additionals.length, 10);
  const parts = [head];
  if (legacy) for (const q of questions) parts.push(encodeName(q.name), u16(q.type), u16(CLASS_IN));
  for (const r of answers) parts.push(encodeRecord(r, legacy, goodbye));
  for (const r of additionals) parts.push(encodeRecord(r, legacy, goodbye));
  return Buffer.concat(parts);
}

function queryMessage(name, type) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 4);
  return Buffer.concat([head, encodeName(name), u16(type), u16(CLASS_IN | 0x8000)]);
}

// ================= advertised records =================
function serviceName(st) { return (st.tls ? '_https' : '_http') + '._tcp.local'; }
function instanceName(st) { return st.instance + '.' + serviceName(st); }
function recordKey(r) { return r.name.toLowerCase() + '/' + r.type; }

function recordsOf(st) {
  const svc = serviceName(st);
  const inst = instanceName(st);
  const out = [];
  for (const ip of st.ips) out.push({ name: st.host, type: DNS_A, unique: true, ttl: TTL_HOST, rdata: ipRdata(ip) });
  out.push({ name: svc, type: DNS_PTR, unique: false, ttl: TTL_SERVICE, rdata: encodeName(inst) });
  out.push({ name: inst, type: DNS_SRV, unique: true, ttl: TTL_HOST, rdata: srvRdata(st.servicePort, st.host) });
  out.push({ name: inst, type: DNS_TXT, unique: true, ttl: TTL_SERVICE, rdata: txtRdata(st.txt) });
  out.push({ name: '_services._dns-sd._udp.local', type: DNS_PTR, unique: false, ttl: TTL_SERVICE, rdata: encodeName(svc) });
  return out;
}

function additionalsFor(answers, all) {
  const seen = new Set(answers.map(recordKey));
  const out = [];
  const push = r => { const k = recordKey(r); if (!seen.has(k)) { seen.add(k); out.push(r); } };
  if (answers.some(r => r.type === DNS_PTR)) {
    for (const r of all) if (r.type === DNS_SRV || r.type === DNS_TXT) push(r);
  }
  if (answers.some(r => r.type === DNS_SRV || r.type === DNS_TXT || r.type === DNS_PTR)) {
    for (const r of all) if (r.type === DNS_A) push(r);
  }
  return out;
}

// ================= state helpers =================
function later(st, fn, ms) {
  const t = setTimeout(() => { st.timers.delete(t); fn(); }, ms);
  if (t.unref) t.unref();
  st.timers.add(t);
  return t;
}
function clearTimers(st) {
  for (const t of st.timers) { try { clearTimeout(t); } catch (_) {} try { clearInterval(t); } catch (_) {} }
  st.timers.clear();
}

function applyName(st) {
  const suffix = st.suffix > 1 ? '-' + st.suffix : '';
  st.host = st.base + suffix + '.local';
  st.instance = st.label + (st.suffix > 1 ? ' ' + st.suffix : '');
}

function urlOf(st) {
  const scheme = st.tls ? 'https' : 'http';
  const defPort = st.tls ? 443 : 80;
  return scheme + '://' + st.host + (st.servicePort === defPort ? '' : ':' + st.servicePort) + '/v1';
}

function sendMulticast(st, packet) {
  if (!st.sock || st.state === 'stopped') return;
  if (st.bindPort !== MDNS_PORT) {   // test mode: stay on loopback, never touch the real mDNS group
    try { st.sock.send(packet, 0, packet.length, st.bindPort, '127.0.0.1', () => {}); } catch (_) {}
    return;
  }
  if (st.mcastIface && st.mcastIface !== st.sentVia) {
    try { st.sock.setMulticastInterface(st.mcastIface); st.sentVia = st.mcastIface; } catch (_) {}
  }
  try { st.sock.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, () => {}); } catch (_) {}
}

function sendTo(st, packet, rinfo) {
  if (!st.sock || st.state === 'stopped') return;
  try { st.sock.send(packet, 0, packet.length, rinfo.port, rinfo.address, () => {}); } catch (_) {}
}

function announce(st, times = ANNOUNCE_REPEAT) {
  if (st.state === 'stopped') return;
  const all = recordsOf(st);
  if (!all.length) return;
  const packet = buildMessage({ answers: all });
  for (let i = 0; i < times; i++) {
    if (i === 0) sendMulticast(st, packet);
    else later(st, () => sendMulticast(st, packet), i * 1000);
  }
}

// ================= interface tracking =================
function syncInterfaces(st) {
  st.self = selfAddresses();
  const ips = st.fixedIps ? st.fixedIps.slice() : lanAddresses().map(x => x.address);
  const changed = ips.join(',') !== st.ips.join(',');
  if (changed) {
    st.ips = ips;
    st.mcastIface = ips[0] || '';
    st.sentVia = '';
  }
  if (st.bindPort !== MDNS_PORT || !st.sock) return changed;
  const want = new Set(ips);
  for (const ip of [...st.joined]) {
    if (want.has(ip)) continue;
    st.joined.delete(ip);
    try { st.sock.dropMembership(MDNS_ADDR, ip); } catch (_) {}
  }
  for (const ip of ips) {
    if (st.joined.has(ip)) continue;
    try { st.sock.addMembership(MDNS_ADDR, ip); st.joined.add(ip); } catch (_) {}
  }
  return changed;
}

// ================= probing / conflict handling =================
function conflict(st, why) {
  if (st.state === 'stopped' || st.probeConflict) return;
  if (st.conflicts >= MAX_CONFLICTS) {
    logErr('[mdns] 名字冲突过多 (' + why + '), 停止广播; 在 config 里换一个 mdns.name');
    teardown(st);
    return;
  }
  st.conflicts++;
  if (st.state === 'probing') { st.probeConflict = why; return; }
  bumpName(st, why);
  probe(st);
}

function bumpName(st, why) {
  const old = st.host;
  st.suffix = st.suffix > 1 ? st.suffix + 1 : 2;
  applyName(st);
  logErr('[mdns] ⚠ 局域网已有其它设备使用 ' + old + ' (' + why + '), 改名为 ' + st.host);
}

// Our own records come back on loopback (and from the worker a hot restart replaced):
// identical SRV/TXT is us, not a second host claiming the name.
function isOwnRecord(st, a) {
  if (a.type === DNS_SRV) {
    if (a.rdata.length < 7) return false;
    let target = '';
    try { target = decodeName(a.rdata, 6).name.toLowerCase(); } catch (_) { return false; }
    return a.rdata.readUInt16BE(4) === st.servicePort && target === st.host.toLowerCase();
  }
  if (a.type === DNS_TXT) return a.rdata.equals(txtRdata(st.txt));
  return false;
}

function checkResponse(st, msg) {
  const host = st.host.toLowerCase();
  const inst = instanceName(st).toLowerCase();
  for (const a of msg.answers) {
    if (isOwnRecord(st, a)) continue;
    const n = a.name.toLowerCase();
    if (a.type === DNS_A && n === host) {
      if (a.rdata.length === 4) {
        const ip = [...a.rdata].join('.');
        if (!st.ips.includes(ip)) return conflict(st, 'A ' + ip);
      }
    } else if ((a.type === DNS_SRV || a.type === DNS_TXT) && n === inst && a.ttl > 0) {
      return conflict(st, a.type === DNS_SRV ? 'SRV' : 'TXT');
    }
  }
}

function probe(st) {
  if (st.state === 'stopped') return;
  st.state = 'probing';
  st.probeConflict = null;
  let sent = 0;
  const finish = () => {
    if (st.state !== 'probing') return;
    if (st.probeConflict) { bumpName(st, st.probeConflict); probe(st); return; }
    st.state = 'ok';
    if (!st.ips.length) log('[mdns] 域名 ' + st.host + ' 已就绪, 但当前没有局域网 IPv4 地址 (连上 Wi-Fi 后自动广播)');
    else log('[mdns] 域名 ' + st.host + ' → ' + urlOf(st) + '  服务 ' + instanceName(st) + (st.ips.length > 1 ? '  地址 ' + st.ips.join(', ') : ''));
    announce(st);
  };
  const step = () => {
    if (st.state !== 'probing') return;
    sendMulticast(st, queryMessage(st.host, DNS_ANY));
    sendMulticast(st, queryMessage(instanceName(st), DNS_SRV));
    sent++;
    if (sent < PROBE_QUERIES) later(st, step, PROBE_GAP_MS);
    else later(st, finish, PROBE_GAP_MS);
  };
  step();
}

// ================= answering =================
function coveredByKnownAnswer(msg, r) {
  const name = r.name.toLowerCase();
  return msg.answers.some(a => a.type === r.type && a.ttl >= (r.ttl >> 1) && a.name.toLowerCase() === name);
}

function onMessage(st, buf, rinfo) {
  if (st.state === 'stopped') return;
  if (rinfo.port === MDNS_PORT && st.self.has(rinfo.address)) return;   // our own multicast, or a sibling worker
  const msg = parseMessage(buf);
  if (!msg) return;
  if (msg.flags & 0x8000) { checkResponse(st, msg); return; }
  if (!msg.questions.length || st.state === 'probing') return;

  const all = recordsOf(st);
  const answers = [];
  for (const q of msg.questions) {
    if (q.cls !== CLASS_IN && q.cls !== CLASS_ANY) continue;
    const name = q.name.toLowerCase();
    for (const r of all) {
      if (r.name.toLowerCase() !== name) continue;
      if (q.type !== DNS_ANY && q.type !== r.type) continue;
      if (!answers.includes(r)) answers.push(r);
    }
  }
  if (!answers.length) return;

  const legacy = rinfo.port !== MDNS_PORT;                       // one-shot resolver: reply to its port, TTL <= 10
  const unicast = msg.questions.some(q => q.unicast);
  const list = (legacy || unicast) ? answers : answers.filter(r => !coveredByKnownAnswer(msg, r));
  if (!list.length) return;
  const packet = buildMessage({
    id: msg.id, questions: msg.questions, answers: list,
    additionals: additionalsFor(list, all), legacy,
  });
  if (legacy || unicast) sendTo(st, packet, rinfo);
  else later(st, () => sendMulticast(st, packet), 20 + Math.floor(Math.random() * 100));
}

// ================= lifecycle =================
function teardown(st) {
  if (st.state === 'stopped') return;
  st.state = 'stopped';
  clearTimers(st);
  const sock = st.sock;
  st.sock = null;
  if (sock) { try { sock.close(); } catch (_) {} }
  if (CURRENT === st) CURRENT = null;
}

function stopHandle(st, opts) {
  if (st.state === 'stopped') return;
  const goodbye = !opts || opts.goodbye !== false;
  const sock = st.sock;
  const sendGoodbye = () => {
    if (!sock) return;
    const packet = buildMessage({ answers: recordsOf(st), goodbye: true });
    try {
      if (st.bindPort !== MDNS_PORT) sock.send(packet, 0, packet.length, st.bindPort, '127.0.0.1', () => {});
      else sock.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, () => {});
    } catch (_) {}
  };
  if (goodbye && st.ips.length) {
    sendGoodbye();
    const again = setTimeout(sendGoodbye, 20);
    if (again.unref) again.unref();
  }
  clearTimers(st);
  st.state = 'stopped';
  st.sock = null;
  if (sock) setTimeout(() => { try { sock.close(); } catch (_) {} }, goodbye ? 80 : 0);
  if (CURRENT === st) CURRENT = null;
}

function start(opts) {
  const st = {
    base: sanitizeName(opts.name) || 'openagw',
    suffix: 1,
    host: '', instance: '',
    label: 'OpenAGW' + ((sanitizeName(opts.name) || 'openagw') === 'openagw' ? '' : ' ' + (sanitizeName(opts.name) || 'openagw')),
    servicePort: Number(opts.port) || 0,
    tls: !!opts.tls,
    txt: Object.assign({ path: '/v1', version: VERSION, tls: opts.tls ? '1' : '0' }, opts.txt || {}),
    bindPort: Number(opts.bindPort) || MDNS_PORT,
    fixedIps: Array.isArray(opts.addresses) ? opts.addresses.slice() : null,
    ips: [], self: selfAddresses(), joined: new Set(), mcastIface: '', sentVia: '',
    state: 'starting', sock: null, timers: new Set(), conflicts: 0, probeConflict: null,
    tick: 0,
  };
  applyName(st);

  const handle = {
    get name() { return st.base + (st.suffix > 1 ? '-' + st.suffix : ''); },
    get host() { return st.host; },
    get instance() { return st.instance; },
    get service() { return serviceName(st); },
    get port() { return st.servicePort; },
    get tls() { return st.tls; },
    get ips() { return st.ips.slice(); },
    get state() { return st.state; },
    get url() { return urlOf(st); },
    get conflictsSeen() { return st.conflicts; },
    stop(o) { stopHandle(st, o); },
  };

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  st.sock = sock;
  sock.on('error', (e) => {
    logErr('[mdns] socket 错误: ' + e.message + (e.code === 'EADDRINUSE' ? ' (5353 已被其它 mDNS 服务占用)' : ''));
    if (st.state === 'starting') teardown(st);
  });
  sock.on('message', (buf, rinfo) => {
    try { onMessage(st, buf, rinfo); } catch (e) { logErr('[mdns] 处理查询失败: ' + e.message); }
  });
  sock.bind(st.bindPort, () => {
    if (st.state === 'stopped') { try { sock.close(); } catch (_) {} return; }
    try { sock.setMulticastTTL(255); } catch (_) {}
    try { sock.setMulticastLoopback(true); } catch (_) {}
    syncInterfaces(st);
    const begin = () => {
      if (st.state === 'stopped') return;
      if (opts.probe === false) {
        st.state = 'ok';
            announce(st);
      } else {
        probe(st);
      }
    };
    const timer = setInterval(() => {
      if (st.state === 'stopped') return;
      const moved = syncInterfaces(st);
      st.tick++;
      if (st.state === 'ok' && (moved || st.tick >= Math.round(REFRESH_MS / POLL_MS))) {
        st.tick = 0;
        announce(st, moved ? ANNOUNCE_REPEAT : 1);
      }
    }, POLL_MS);
    if (timer.unref) timer.unref();
    st.timers.add(timer);
    begin();
  });
  return handle;
}

// ================= process-wide singleton =================
let CURRENT = null;
let CURRENT_KEY = '';

function keyOf(o) {
  return [o.enable ? 1 : 0, o.name, o.port, o.tls ? 1 : 0].join('|');
}

/**
 * Apply the desired advertisement. Idempotent: the same enable/name/port/tls keeps the
 * running responder (a conflict-renamed one included); anything else restarts it.
 * Returns the live handle, or null when disabled.
 */
function apply(opts = {}) {
  const name = sanitizeName(opts.name) || 'openagw';
  const o = {
    enable: !!opts.enable,
    name,
    port: Number(opts.port) || 0,
    tls: !!opts.tls,
    txt: opts.txt || {},
    bindPort: opts.bindPort,
    addresses: opts.addresses,
    probe: opts.probe,
  };
  const key = keyOf(o);
  if (key === CURRENT_KEY && CURRENT && CURRENT.state !== 'stopped') return CURRENT;
  if (CURRENT) CURRENT.stop({ goodbye: true });
  CURRENT = null;
  CURRENT_KEY = key;
  if (!o.enable) return null;
  if (!o.port) { logErr('[mdns] 没有可广播的主端口, 跳过'); return null; }
  CURRENT = start(o);
  return CURRENT;
}

function current() { return CURRENT; }
function stopAll(opts) {
  if (CURRENT) CURRENT.stop(opts);
  CURRENT = null;
  CURRENT_KEY = '';
}

module.exports = {
  apply, current, stopAll,
  sanitizeName, lanAddresses, isPrivateIPv4,
  // exported for the tests: wire format without a socket
  encodeName, decodeName, parseMessage, buildMessage, queryMessage,
  _types: { DNS_A, DNS_PTR, DNS_TXT, DNS_SRV, DNS_ANY },
};
