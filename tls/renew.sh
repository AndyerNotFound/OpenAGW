#!/usr/bin/env bash
# Certificate renewal wrapper: only touches the gateway when the certificate actually changed.
#   bash tls/renew.sh              check + re-sign if needed + restart + verify
#   bash tls/renew.sh --no-restart check/re-sign only (leave the restart to ops/guard.sh)
# Exit codes: 0=no change needed or done, 2=re-sign failed
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"
CERT="$ROOT/cert.pem"
CA="$DIR/ca.pem"

probe_url() {
  node -e '
    const fs=require("fs"),path=require("path");
    const D=process.argv[1];
    try{
      const c=require(path.join(D,"crypt.js"));
      let r=fs.readFileSync(path.join(D,"config.json"),"utf8");
      if(c.isEncText(r))r=c.decryptText(r,c.loadPass());
      const j=JSON.parse(r),t=j.tls||(j.listen&&j.listen.tls)||{};
      const hp=(j.listen||{}).port||16384;
      if(t.enable) process.stdout.write("https://127.0.0.1:"+hp+"/health");
      else process.stdout.write("http://127.0.0.1:"+hp+"/health");
    }catch(e){process.stdout.write("")}
  ' "$1"
}
tls_port() {
  node -e 'try{const fs=require("fs"),c=require(process.argv[2]+"/crypt.js");let r=fs.readFileSync(process.argv[1],"utf8");if(c.isEncText(r))r=c.decryptText(r,c.loadPass());const j=JSON.parse(r),t=j.tls||{};process.stdout.write(t.enable?String((j.listen||{}).port||16384):"")}catch(e){process.stdout.write("")}' "$ROOT/config.json" "$ROOT"
}

before="$(sha256sum "$CERT" 2>/dev/null | awk '{print $1}')"
out="$(bash "$DIR/gen-server.sh" --ensure 2>&1)"
rc=$?
if [ $rc -ne 0 ]; then
  echo "failed"; echo "$out" | tail -n 5
  exit 2
fi
after="$(sha256sum "$CERT" 2>/dev/null | awk '{print $1}')"

if [ "$before" = "$after" ]; then
  echo "nochange"
  exit 0
fi

echo "renewed"
echo "$out" | tail -n 6

[ "${1:-}" = "--no-restart" ] && exit 0

bash "$ROOT/agw.sh" restart >/dev/null 2>&1
sleep 3
P="$(tls_port)"
if [ -n "$P" ]; then
  if curl -sf -m 8 --cacert "$CA" "$(probe_url "$ROOT")" >/dev/null 2>&1; then
    echo "✓ Restart done, health check passed"
  else
    echo "✗ HTTPS :$P health check failed after restart"; exit 2
  fi
fi
