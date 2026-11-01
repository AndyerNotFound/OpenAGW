#!/usr/bin/env bash
# Scheduled temp-file cleanup: give certificates exported to public dirs (e.g. /sdcard/Download) an expiry deletion time.
#   bash tls/cleanup.sh add <path> <minutes>   schedule deletion (fractions allowed, e.g. 0.5)
#   bash tls/cleanup.sh list                show what is still queued
#   bash tls/cleanup.sh cancel <path>       cancel
#   bash tls/cleanup.sh sweep               delete whatever is due (guard calls this every 5 minutes as a fallback)
# Note: a precise timer runs in the background; even if Termux is killed nothing is missed -- guard sweeps as a fallback.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
JOBDIR="$DIR/.run/cleanup"
LOG="$DIR/log/cleanup.log"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"
mkdir -p "$JOBDIR" "$DIR/log"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
id_of() { printf '%s' "$1" | sha256sum | awk '{print substr($1,1,16)}'; }

add() {
  local p="$1" m="$2" id secs at
  [ -z "${p:-}" ] && { echo "✗ Missing path"; exit 1; }
  [ -e "$p" ] || { echo "✗ File not found: $p"; exit 1; }
  id="$(id_of "$p")"
  secs="$(awk -v m="$m" 'BEGIN{printf "%d", m*60}')"
  [ "$secs" -lt 1 ] && secs=1
  at=$(( $(date +%s) + secs ))
  printf '%s\n%s\n' "$p" "$at" > "$JOBDIR/$id.job"
  log "Scheduled deletion of $p (in ${secs}s)"
  setsid nohup sh -c "sleep $secs; bash '$DIR/tls/cleanup.sh' sweep" >/dev/null 2>&1 9>&- &
  echo "$id"
}

sweep() {
  local now f p at removed=0
  now="$(date +%s)"
  for f in "$JOBDIR"/*.job; do
    [ -e "$f" ] || continue
    p=""; at=0
    { IFS= read -r p; IFS= read -r at; } < "$f"
    [ -z "$p" ] && { rm -f "$f"; continue; }
    if [ "${at:-0}" -le "$now" ]; then
      if [ -e "$p" ]; then rm -f "$p" && { log "Deleted $p"; removed=$((removed+1)); }; fi
      rm -f "$f"
    fi
  done
  echo "$removed"
}

list_jobs() {
  local f p at now left n=0
  now="$(date +%s)"
  for f in "$JOBDIR"/*.job; do
    [ -e "$f" ] || continue
    { IFS= read -r p; IFS= read -r at; } < "$f"
    left=$(( ${at:-0} - now )); [ $left -lt 0 ] && left=0
    printf '  %-52s deleted in %s\n' "$p" "${left}s"; n=$((n+1))
  done
  [ $n -eq 0 ] && echo "  (no queued jobs)"
}

cancel() {
  local p="$1" id; id="$(id_of "$p")"
  if [ -f "$JOBDIR/$id.job" ]; then rm -f "$JOBDIR/$id.job"; log "Cancelled deletion of $p"; echo "✓ Cancelled"; else echo "(no such job)"; fi
}

case "${1:-}" in
  add)    add "${2:-}" "${3:-5}" ;;
  sweep)  sweep ;;
  list)   list_jobs ;;
  cancel) cancel "${2:-}" ;;
  *)      echo "Usage: cleanup.sh add <path> <minutes> | list | cancel <path> | sweep" ;;
esac
