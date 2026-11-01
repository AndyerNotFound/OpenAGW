#!/usr/bin/env node
'use strict';
/* Encryption-aware TLS switch. cfg-cli.js loadCfg does a plain JSON.parse,
it crashes on AGWENC1-encrypted configs and would write configs as plaintext -- hence this separate script.
Usage:
node tls/apply-tls.js [instance]            # enable TLS on listen.port (single-port pure HTTPS)
node tls/apply-tls.js [instance] --off      # turn TLS off

Policy: one entry per instance, never a plaintext twin.
  - default: serves HTTPS on listen.port (tls.port is ignored / dropped)
  - other instances: once TLS is on they stop listening on their own port and are reachable only
    through the main port's HTTPS + /<name>/ -- so default must have TLS enabled too
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const crypt = require(path.join(ROOT, 'crypt.js'));
const argv = process.argv.slice(2);
const off = argv.includes('--off');
const pos = argv.filter(a => !a.startsWith('--'));
const inst = pos[0] || 'default';
const file = path.join(ROOT, 'data', inst === 'default' ? 'config.json' : `config.${inst}.json`);

if (!fs.existsSync(file)) { console.error(`✗ Config not found: ${file}`); process.exit(1); }

const raw = fs.readFileSync(file, 'utf8');
const encrypted = crypt.isEncText(raw);
const pass = crypt.loadPass();
let text = raw;
if (encrypted) {
  if (!pass) { console.error('✗ Config is encrypted but no passphrase found (.agwkey or AGW_CRYPT_PASS)'); process.exit(1); }
  text = crypt.decryptText(raw, pass);
}

let cfg;
try { cfg = JSON.parse(text); } catch (e) { console.error(`✗ Config parse failed: ${e.message}`); process.exit(1); }

const httpPort = Number((cfg.listen && cfg.listen.port) || 16384);

if (off) {
  cfg.tls = { enable: false };
  console.log('• TLS disabled (HTTP keeps serving)');
} else {
  const certFile = path.join(ROOT, 'data', 'cert.pem');
  const keyFile = path.join(ROOT, 'key.pem');
  for (const f of [certFile, keyFile]) {
    if (!fs.existsSync(f)) { console.error(`✗ Missing ${f}; run first: bash tls/gen-server.sh`); process.exit(1); }
  }
  cfg.tls = { enable: true, cert: 'cert.pem', key: 'key.pem' };
  if (inst === 'default') console.log(`• TLS enabled: port ${httpPort} serves HTTPS only (no plaintext entry)`);
  else {
    console.log(`• TLS enabled: instance ${inst} no longer listens on its own port ${httpPort}; reached only via main port /${inst}/`);
    const mainRaw = fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8');
    let mainCfg;
    try {
      const mt = crypt.isEncText(mainRaw) ? crypt.decryptText(mainRaw, pass) : mainRaw;
      mainCfg = JSON.parse(mt);
    } catch (_) { mainCfg = null; }
    if (!(mainCfg && mainCfg.tls && mainCfg.tls.enable)) {
      console.log('  ⚠ default has TLS off: this instance is unreachable; enable TLS on default first (agw-tls setup)');
    }
  }
}

const out = JSON.stringify(cfg, null, 2) + '\n';
const payload = encrypted ? crypt.encryptText(out, pass) : out;
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, payload, { mode: 0o600 });

const back = fs.readFileSync(tmp, 'utf8');
const check = encrypted ? crypt.decryptText(back, pass) : back;
if (check !== out) { fs.unlinkSync(tmp); throw new Error('Read-back verification failed; write aborted'); }

fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
console.log(`✓ Written back to ${path.basename(file)} (${encrypted ? 'kept encrypted' : 'plaintext'})`);
console.log(`  重启生效: ~/ai-gateway/agw.sh restart`);
