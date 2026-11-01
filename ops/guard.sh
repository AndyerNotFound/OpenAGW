#!/usr/bin/env bash
# Guard task run every 5 minutes (invoked by watchdog.sh):
#   1) Certificate: <7 days left / not issued by this CA / SAN missing current IP -> re-sign and restart (can run anytime)
#   2) Client keys: rotate only when due, and only inside the 03:00-05:00 window (via admin API, zero downtime, no restart)
# Concurrency guard: flock; always exit 0 so the watchdog never breaks.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"
LOG="$DATA/log/tls.log"
LOCK="$DATA/.run/guard.lock"
WINDOW_START="${WINDOW_START:-3}"
WINDOW_END="${WINDOW_END:-5}"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
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


mkdir -p "$DATA/.run" "$DATA/log"
exec 9>"$LOCK"
if ! flock -n 9; then exit 0; fi

# ---- 1) Certificates ----
out="$(bash "$ROOT/tls/renew.sh" --no-restart 2>&1)"
rc=$?
first="$(printf '%s\n' "$out" | head -n 1)"
case "$first" in
  renewed)
    log "Cert re-signed; restarting gateway"
    if bash "$ROOT/agw.sh" restart >/dev/null 2>&1 9>&-; then   # 9>&- : do not pass the lock fd to long-lived child processes
      sleep 3
      P="$(node -e 'try{const fs=require("fs"),c=require(process.argv[2]+"/crypt.js");let r=fs.readFileSync(process.argv[1],"utf8");if(c.isEncText(r))r=c.decryptText(r,c.loadPass());const j=JSON.parse(r),t=j.tls||{};process.stdout.write(t.enable?String((j.listen||{}).port||16384):"")}catch(e){}' "$DATA/config.json" "$ROOT")"
      if curl -sf -m 8 --cacert "$ROOT/tls/ca.pem" "$(probe_url "$ROOT")" >/dev/null 2>&1; then
        log "✓ HTTPS :$P healthy after restart"
        served="$(echo | openssl s_client -connect "127.0.0.1:$P" -servername localhost 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null)"
        onfile="$(openssl x509 -in "$DATA/cert.pem" -noout -fingerprint -sha256 2>/dev/null)"
        if [ -n "$served" ] && [ "$served" = "$onfile" ]; then log "✓ Server cert fingerprint matches the file"
        else log "✗ Server cert does not match the file (gateway not loading the new cert? served=${served:-?})"; fi
      else
        log "✗ HTTPS :${P:-?} health check failed after restart"
      fi
    else
      log "✗ Restart failed"
    fi
    ;;
  nochange) : ;;
  *)
    log "✗ Cert check failed (rc=$rc): $(echo "$out" | tail -n 3 | tr '\n' ' ')"
    ;;
esac

# ---- 2) Client key rotation (night window) ----
H=$(date +%H)
if [ "$H" -ge "$WINDOW_START" ] && [ "$H" -lt "$WINDOW_END" ]; then
  kout="$(node "$ROOT/ops/rotate-keys.js" --if-due 2>&1)"
  [ -n "$kout" ] && log "Key rotation: $(echo "$kout" | tr '\n' ' ' | cut -c1-400)"
fi

bash "$ROOT/tls/cleanup.sh" sweep >/dev/null 2>&1   # fallback sweep for expired temp files
date +%s > "$DATA/.run/guard.last"   # timestamp each run to confirm the scheduling chain

# ---- 3) Heartbeat (at most one per hour, confirms the scheduler chain is alive) ----
HB="$DATA/.run/guard.heartbeat"
now_s=$(date +%s)
last_s=$(cat "$HB" 2>/dev/null || echo 0)
if [ $((now_s - last_s)) -ge 3600 ]; then
  end="$(openssl x509 -in "$DATA/cert.pem" -noout -enddate 2>/dev/null | cut -d= -f2)"
  kd="$(node -e 'try{const s=require(process.argv[1]);const d=(new Date(s.lastRotate)).getTime();const left=Math.ceil(s.rotateDays-(Date.now()-d)/864e5);process.stdout.write(String(left))}catch(e){process.stdout.write("?")}' "$DATA/.keyrotation.json" 2>/dev/null)"
  log "heartbeat: cert expires ${end:-?} / next key rotation in ${kd:-?} days"
  echo "$now_s" > "$HB"
fi

exit 0
