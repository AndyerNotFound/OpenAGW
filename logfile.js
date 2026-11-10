'use strict';
/* ================= Buffered gateway log writer =================
 * The gateway logged by writing to stdout, and agw.sh redirected that into data/log/gateway.log.
 * Two knobs were therefore unreachable from the panel: how large the file may grow (a fixed 8 MiB
 * limit in agw.sh, only applied on the next cold start) and how often the process touches the disk
 * (every console.log was one write syscall -- constant flash traffic on a phone).
 *
 * This module owns the file instead. Lines collect in a string buffer that is flushed when it
 * reaches bufferBytes or after FLUSH_MS, and once the file passes maxBytes it is cut back to the
 * newest half on a line boundary. Both sizes are panel-adjustable and applied hot; values are
 * clamped to the ranges the panel offers, so a hand-edited config cannot ask for a 1-byte buffer.
 *
 * Only installed when AGW_LOG_FILE is set (agw.sh does that), so embedding hosts (nodejs-mobile)
 * and a bare `node gateway.js` keep logging to stdout / docker logs.
 */
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 1000;
const DEF = { maxBytes: 8 * 1024 * 1024, bufferBytes: 64 * 1024 };
const RANGE = { maxBytes: [32 * 1024, 32 * 1024 * 1024], bufferBytes: [8 * 1024, 8 * 1024 * 1024] };

let file = '';
let fd = -1;
let maxBytes = DEF.maxBytes;
let bufferBytes = DEF.bufferBytes;
let chunks = [];
let pending = 0;   // bytes waiting in chunks
let size = 0;      // bytes the file holds
let timer = null;
let broken = false;
let writes = 0;
let rotations = 0;

function pick(v, key, def) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return def;
  const [lo, hi] = RANGE[key];
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
/* Keep the buffer at most as large as the cap: a 32 KB cap with an 8 MB buffer would just grow the
 * file past the cap by that much before the first rotation. */
function normalize(o) {
  const src = o && typeof o === 'object' ? o : {};
  const max = pick(src.maxBytes, 'maxBytes', DEF.maxBytes);
  const buf = pick(src.bufferBytes, 'bufferBytes', DEF.bufferBytes);
  return { maxBytes: max, bufferBytes: Math.min(buf, max) };
}

function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/* The file is opened in append mode on purpose: rotation truncates in place (see rotate()), and an
 * append fd always writes at the current end, so the process never keeps a stale offset. */
function install(f, opts) {
  stop();
  const n = normalize(opts);
  maxBytes = n.maxBytes; bufferBytes = n.bufferBytes;
  file = String(f || '');
  broken = false;
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'a');
    size = fs.fstatSync(fd).size;
    return true;
  } catch (e) {
    fd = -1; broken = true; file = '';
    try { process.stderr.write('[logfile] 无法打开日志文件: ' + e.message + '\n'); } catch (_) {}
    return false;
  }
}

/* Hot-apply from the panel: sizes only, the fd stays. A shrunken buffer flushes what is waiting. */
function configure(opts) {
  const n = normalize(opts);
  maxBytes = n.maxBytes; bufferBytes = n.bufferBytes;
  if (pending >= bufferBytes) flush();
  return { maxBytes, bufferBytes };
}

function rotate() {
  const keep = Math.max(1024, Math.floor(maxBytes / 2));
  const read = { start: 0, text: '' };
  try {
    const rfd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(rfd);
      read.start = Math.max(0, st.size - keep);
      const buf = Buffer.allocUnsafe(st.size - read.start);
      if (buf.length) fs.readSync(rfd, buf, 0, buf.length, read.start);
      read.text = buf.toString('utf8');
    } finally { fs.closeSync(rfd); }
  } catch (_) { return; }
  let tail = read.text;
  if (read.start > 0) { const nl = tail.indexOf('\n'); tail = nl >= 0 ? tail.slice(nl + 1) : tail; }
  try {
    const out = Buffer.from(tail, 'utf8');
    fs.ftruncateSync(fd, 0);
    if (out.length) fs.writeSync(fd, out);
    size = out.length;
    rotations++;
  } catch (_) {}
}

function flush() {
  clearTimer();
  if (!chunks.length) return;
  const text = chunks.join('');
  chunks = []; pending = 0;
  if (fd < 0) return;
  let n = 0;
  try {
    n = Buffer.byteLength(text);
    fs.writeSync(fd, text);
    writes++; size += n;
  } catch (e) {
    broken = true;
    try { process.stderr.write('[logfile] 写入失败: ' + e.message + '\n'); } catch (_) {}
    return;
  }
  if (size > maxBytes) rotate();
}

/* Returns false only when no file is owned, so util.js can fall back to stdout. */
function write(str) {
  if (fd < 0 || broken) return false;
  const s = String(str == null ? '' : str);
  if (!s) return true;
  chunks.push(s);
  pending += Buffer.byteLength(s);
  if (pending >= bufferBytes) flush(); else schedule();
  return true;
}

function stop() {
  clearTimer();
  flush();
  if (fd >= 0) { try { fs.closeSync(fd); } catch (_) {} }
  fd = -1; chunks = []; pending = 0; size = 0;
}

function stats() {
  return { enabled: fd >= 0, file, maxBytes, bufferBytes, size, pending, writes, rotations, broken };
}

module.exports = { install, configure, write, flush, stop, stats, normalize, DEF, RANGE };
