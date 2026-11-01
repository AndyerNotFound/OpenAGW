#!/usr/bin/env bash
# ai-gateway watchdog -- detects a dead/unresponsive gateway and restarts it automatically
# Incident 2026-10-10: after the gateway was killed at 18:32 its PID got reused; agw.sh misjudged it as "already running" and could not start.
# Usage: setsid nohup bash ~/ai-gateway/watchdog.sh [interval secs, default 30] >/dev/null 2>&1 &
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.run/main.pid"
WDPIDFILE="$DIR/.run/watchdog.pid"
LOG="$DIR/log/watchdog.log"
INTERVAL="${1:-30}"
GUARD_EVERY="${GUARD_EVERY:-10}"   # 10 × 30s = run ops/guard.sh every 5 min (cert renew / key rotation)
tick=0
UNHEALTHY_LIMIT=3   # restart only after N consecutive /health failures while the process is alive
bad=0

log(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# Process alive AND really this gateway (guards against PID-reuse misjudgment)
alive() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  grep -q "ai-gateway/gateway[.]js" "/proc/$pid/cmdline" 2>/dev/null
}

# Main port (same logic as agw.sh get_main_port, works with encrypted configs)
get_port() {
  node -e 'try{const fs=require("fs");let raw=fs.readFileSync(process.argv[1],"utf8");try{const c=require(process.argv[2]+"/crypt.js");if(c.isEncText(raw))raw=c.decryptText(raw,c.loadPass())}catch(_){};console.log((JSON.parse(raw).listen||{}).port||16384)}catch(e){console.log("?")}' "$DIR/config.json" "$DIR" 2>/dev/null
}

health() {
  local p ca="$DIR/tls/ca.pem"
  p="$(get_port)"
  [ "$p" = "?" ] && return 1
  [ -f "$ca" ] && curl -sf -m 5 --cacert "$ca" "https://127.0.0.1:$p/health" >/dev/null 2>&1 && return 0
  curl -sf -m 5 "http://127.0.0.1:$p/health" >/dev/null 2>&1
}

# Prevent double runs
if [ -f "$WDPIDFILE" ]; then
  oldpid="$(cat "$WDPIDFILE" 2>/dev/null)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    echo "watchdog already running (pid $oldpid)"; exit 0
  fi
fi
echo $$ > "$WDPIDFILE"

log "── watchdog started (check every ${INTERVAL}s, pid $$) ──"
while true; do
  if alive; then
    if health; then
      bad=0
    else
      bad=$((bad+1))
      log "△ process alive but /health failing ($bad/$UNHEALTHY_LIMIT consecutive)"
      if [ "$bad" -ge "$UNHEALTHY_LIMIT" ]; then
        log "✗ $bad consecutive failures; running restart"
        out="$(bash "$DIR/agw.sh" restart 2>&1 | tail -n 1)"
        log "   restart result: $out"
        bad=0
      fi
    fi
  else
    log "✗ Gateway not running (dead/stale pid); auto-starting..."
    rm -f "$PIDFILE"
    out="$(bash "$DIR/agw.sh" start 2>&1 | tail -n 1)"
    log "   start result: $out"
    bad=0
  fi
  tick=$((tick+1))
  if [ "$GUARD_EVERY" -gt 0 ] && [ $((tick % GUARD_EVERY)) -eq 0 ]; then
    bash "$DIR/ops/guard.sh" >/dev/null 2>&1
  fi
  sleep "$INTERVAL"
done
