'use strict';
/* Buffered gateway log writer (logfile.js, 2026-11-10).
 *
 * The panel now sets two sizes: the file's upper bound (记录上限) and how many bytes are batched before
 * one write reaches the disk (缓冲区大小). What must hold: nothing is lost, the file never stays over
 * the cap, rotation keeps whole lines and the newest ones, and the util.js sink takes lines away from
 * stdout only while it is installed.
 *
 * Run: node test/log_file_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const logfile = require('../logfile');
const { log, setLogSink } = require('../util');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  x ' + m); } }
const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-log-'));
const file = path.join(dir, 'nested', 'gateway.log');
try {
  ok(logfile.install(file, { maxBytes: 64 * 1024, bufferBytes: 8 * 1024 }), 'install creates the directory and owns the file');
  ok(logfile.stats().enabled, 'stats().enabled after install');

  logfile.write('A'.repeat(100) + '\n');
  ok(read(file) === '', 'below the buffer: nothing on disk yet');
  logfile.flush();
  ok(read(file).includes('A'.repeat(100)), 'flush() writes what was buffered');

  logfile.write('B'.repeat(8 * 1024));
  ok(fs.statSync(file).size >= 8 * 1024, 'a write reaching bufferBytes flushes by itself');

  for (let i = 0; i < 40; i++) logfile.write('L' + i + '-' + 'x'.repeat(4000) + '\n');
  logfile.flush();
  const size = fs.statSync(file).size;
  const txt = read(file);
  ok(size <= 64 * 1024, 'file stays under the cap after rotation (size ' + size + ')');
  ok(txt.charAt(0) === 'L', 'rotation starts on a whole line');
  ok(txt.includes('L39-'), 'rotation keeps the newest line');
  ok(!txt.includes('L0-'), 'rotation drops the oldest line');

  const clamped = logfile.normalize({ maxBytes: 1000, bufferBytes: 99 * 1024 * 1024 });
  ok(clamped.maxBytes === 32768, 'maxBytes clamped to the 32 KB floor');
  ok(clamped.bufferBytes === 32768, 'buffer clamped to the cap');
  const wide = logfile.normalize({ maxBytes: 1024 * 1024, bufferBytes: 8 * 1024 * 1024 });
  ok(wide.maxBytes === 1048576 && wide.bufferBytes === 1048576, 'buffer never exceeds the cap');

  const applied = logfile.configure({ maxBytes: 32 * 1024, bufferBytes: 8 * 1024 });
  ok(applied.maxBytes === 32768 && applied.bufferBytes === 8192, 'configure() hot-applies new sizes');

  let stdouts = 0;
  const realLog = console.log;
  console.log = () => { stdouts++; };
  setLogSink(s => logfile.write(s));
  log('sink-line-42', { k: 1 });
  logfile.flush();
  setLogSink(null);
  log('stdout-line-43');
  console.log = realLog;
  const after = read(file);
  ok(after.includes('sink-line-42 { k: 1 }'), 'log() writes through the sink');
  ok(stdouts === 1, 'nothing is duplicated on stdout while the sink is installed');
  ok(!after.includes('stdout-line-43'), 'with the sink removed, log() goes back to stdout');

  logfile.write('tail-line\n');
  logfile.stop();
  ok(!logfile.stats().enabled, 'stop() closes the writer');
  ok(read(file).includes('tail-line'), 'stop() flushes what was pending');
} finally {
  try { logfile.stop(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
