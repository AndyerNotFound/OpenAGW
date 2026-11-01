const fs = require("fs");
const f = process.argv[2];
if (!f || !fs.existsSync(f)) { console.error("File not found: " + f); process.exit(1); }
let cfg;
let raw = fs.readFileSync(f, "utf8");
try {
  const crypt = require("./crypt.js");
  if (crypt.isEncText(raw)) raw = crypt.decryptText(raw, crypt.loadPass());
} catch (_) {}
try { cfg = JSON.parse(raw); }
catch (e) { console.log("  (config parse failed: " + e.message.split("\n")[0] + ")"); process.exit(0); }
const port = (cfg.listen && cfg.listen.port) || 16384;
const gw = cfg.gatewayKey ? "set" : "none";
const proxies = Object.keys(cfg.proxies || {});
const chs = cfg.channels || [];
const tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
const tlsOn = tls.enable ? "enabled" : "none";
const tlsPort = tls.enable ? port + "(HTTPS-only)" : "-";
console.log("  ┌ port " + port + "  gateway-key:" + gw + "  TLS:" + tlsOn + (tls.enable ? "(" + tlsPort + ")" : "") + "  proxies:" + (proxies.length ? proxies.join(",") : "none"));
if (!chs.length) { console.log("  └ no channels!"); process.exit(0); }
const dup = {};
for (const ch of chs) for (const m of (ch.models || [])) dup[m] = (dup[m] || 0) + 1;
const rr = Object.entries(dup).filter(([m, c]) => c > 1).map(([m]) => m);
for (let i = 0; i < chs.length; i++) {
  const ch = chs[i];
  const m = (ch.models || []).map(x => rr.includes(x) ? x + "⚡" : x).join(", ") || "(none)";
  const px = ch.proxy ? ("proxy=" + ch.proxy) : "direct";
  const df = ch.default ? " [default]" : "";
  const last = i === chs.length - 1;
  console.log("  " + (last ? "└" : "├") + " [" + ch.type + "] " + ch.name + df + "  " + px);
  console.log("  " + (last ? " " : "│") + "   baseUrl: " + ch.baseUrl);
  if (ch.path) console.log("  " + (last ? " " : "│") + "   path:    " + ch.path);
  console.log("  " + (last ? " " : "│") + "   models:  " + m);
  if (ch.modelMap && Object.keys(ch.modelMap).length) console.log("  " + (last ? " " : "│") + "   modelMap: " + JSON.stringify(ch.modelMap));
}
if (rr.length) console.log("  (⚡=multi-channel round-robin + failover)");
