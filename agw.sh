#!/usr/bin/env bash
# [2026-10-21 eMudhra] node now uses the system cert store (emSign ECC Root CA - G3 removed)
export NODE_OPTIONS="${NODE_OPTIONS//--use-openssl-ca/} --use-openssl-ca"
export SSL_CERT_FILE="${SSL_CERT_FILE:-${PREFIX:-/data/data/com.termux/files/usr}/etc/tls/cert.pem}"
# OpenAGW gateway management script (single-process, multi-instance mode)
# One node process hosts every config*.json in the directory:
#   - the main port (default instance listen.port) routes by /<instance>/ path prefix; no prefix = default
#   - each instance keeps its original port listening (compatible with old clients)
#   - instance create/delete/edit/start/stop/rename all apply hot from the panel, no process restart
# Usage: agw.sh <start|stop|restart|status|list|logs>
#   (instance-name arg kept for compatibility, but unneeded in single-process mode)
set -u
# Dereference the symlink ($0 may be ~/bin/agw etc.), otherwise DIR would point at the symlink's directory
_self="$0"
while [ -L "$_self" ]; do
  _link="$(readlink "$_self")"
  case "$_link" in /*) _self="$_link" ;; *) _self="$(dirname "$_self")/$_link" ;; esac
done
DIR="$(cd "$(dirname "$_self")" && pwd)"
DATA="$DIR/data"
RUN="$DATA/.run"
LOG="$DATA/log"
mkdir -p "$RUN" "$LOG"
PIDFILE="$RUN/main.pid"
WORKERPID="$RUN/worker.pid"
LOGFILE="$LOG/gateway.log"
# Hot restart (default on): the master holds the listen handles, workers are swapped one at a time.
# AGW_HOT=0 starts a plain single-process gateway instead.
AGW_HOT="${AGW_HOT:-1}"

# PID-reuse guard: confirm the process really is the gateway of THIS dir
# (2026-10-10 incident: PID reused by u1s1-proxy caused a false "already running";
#  the old global "ai-gateway/gateway.js" match also killed gateways installed elsewhere —
#  this script only matches its own $DIR)
proc_is_gw() {
  local pid="$1" cmd cwd
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" || return 1
  case "$cmd" in
    *"$DIR/gateway.js"*) return 0 ;;
    "node gateway.js "*) ;;
    *) return 1 ;;
  esac
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)" || return 1
  [ "$cwd" = "$DIR" ]
}

gw_pids() {
  local p
  for p in /proc/[0-9]*; do
    proc_is_gw "${p#/proc/}" && echo "${p#/proc/}"
  done
}

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  proc_is_gw "$pid"
}

get_main_port() {
  node -e 'try{const fs=require("fs");let raw=fs.readFileSync(process.argv[1],"utf8");try{const c=require(process.argv[2]+"/crypt.js");if(c.isEncText(raw))raw=c.decryptText(raw,c.loadPass())}catch(_){};console.log((JSON.parse(raw).listen||{}).port||16384)}catch(e){console.log("?")}' "$DATA/config.json" "$DIR" 2>/dev/null
}

show_config() {
  node "$DIR/show-cfg.js" "$DATA/config.json" 2>/dev/null
}

health_ok() {
# The /health endpoint is closed (whitelist keeps only /v1 /v1beta /auth /profile /admin) -> probe the TCP port instead
  local port="$1"
  node -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1");
const f=c=>{try{s.destroy()}catch(_){}process.exit(c)};
s.setTimeout(2000);s.on("connect",()=>f(0));s.on("error",()=>f(1));s.on("timeout",()=>f(1));' "$port" 2>/dev/null
}

list_instances() {
  local f name
  [ -f "$DATA/config.json" ] && echo "default"
  for f in "$DATA"/config.*.json; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .json)"
    echo "${name#config.}"
  done
}

# Log rotation (added 2026-11-09): gateway.log is opened with >> for the whole life of the process, so a
# phone left running for weeks grew it without bound -- and every "agw logs" / panel refresh then had to
# walk a file that size. Rotate once, cold-start only: at this point no process holds the file open, so
# rewriting it is safe (renaming a live fd would keep writing the old inode and free nothing).
LOG_MAX_BYTES=8388608      # 8 MiB
LOG_KEEP_BYTES=2097152     # keep the newest 2 MiB
rotate_log() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || return 0
  local sz
  sz="$(stat -c %s "$f" 2>/dev/null || echo 0)"
  case "$sz" in ''|*[!0-9]*) return 0 ;; esac
  [ "$sz" -gt "$LOG_MAX_BYTES" ] || return 0
  local tmp
  tmp="$(mktemp "$f.rot.XXXXXX" 2>/dev/null)" || return 0
  # tail must be checked on its own: piping into sed hides a failed/short tail behind sed's exit
  # status, and a failed tail would then replace the log with an empty file.
  if tail -c "$LOG_KEEP_BYTES" "$f" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    # always drop the first line: at worst the window starts exactly on a boundary and one complete
    # line is lost, which is cheaper than telling the cases apart from tail bytes alone. If the whole
    # window is a single line, keep it instead of ending up with a zero-byte log.
    sed '1d' "$tmp" > "$tmp.cut" 2>/dev/null && [ -s "$tmp.cut" ] && mv "$tmp.cut" "$tmp"
    rm -f "$tmp.cut"
    # mktemp creates 600; keep the log's original mode (644 if stat cannot tell) so other readers
    # (containers, other uids) do not lose access
    local mode=""
    mode="$(stat -c %a "$f" 2>/dev/null)"
    chmod "${mode:-644}" "$tmp" 2>/dev/null
    mv "$tmp" "$f" || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

start_gw() {
  if is_running; then
    echo "• Gateway already running (pid $(cat "$PIDFILE"), main port $(get_main_port))"
    echo "  Single-process mode: add/remove/start/stop/rename instances in the panel (hot-applied, no restart)"
    return 0
  fi
# Clean up orphan processes of this dir only (other installs keep running)
  local op
  for op in $(gw_pids); do kill "$op" 2>/dev/null; done
  # wait for them to actually exit before rotating: a dying process still holds the old fd, and a
  # swap under it would send its last lines to an unlinked inode
  local w=0
  while [ "$w" -lt 10 ] && [ -n "$(gw_pids)" ]; do sleep 0.1; w=$((w+1)); done
  if [ ! -f "$DATA/config.json" ]; then echo "✗ Main config not found: $DATA/config.json"; return 1; fi
  rotate_log "$LOGFILE"
  AGW_HOT="$AGW_HOT" nohup node "$DIR/gateway.js" >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
# Wait for the process to come up + poll /health (loading takes seconds with many instances)
  local waited=0
  while [ $waited -lt 4 ] && ! is_running; do sleep 0.5; waited=$((waited+1)); done
  if ! is_running; then
    echo "✗ Gateway start failed; recent log:"
    tail -n 20 "$LOGFILE"
    rm -f "$PIDFILE"
    return 1
  fi
  local port try
  port="$(get_main_port)"
  for try in $(seq 1 24); do
    [ "$port" != "?" ] && health_ok "$port" && break
    sleep 0.5
  done
  if [ "$port" != "?" ] && health_ok "$port"; then
    echo "✓ Gateway started: pid $(cat "$PIDFILE"), main port $port, log $LOGFILE"
    [ "$AGW_HOT" = "1" ] && [ -f "$WORKERPID" ] && echo "  Hot-restart mode: master $(cat "$PIDFILE") + worker $(cat "$WORKERPID") (upgrade/reload keeps in-flight streams)"
    echo "  Instances: http://127.0.0.1:$port/<instance>/v1/... (no prefix = default)"
    echo "  Panel: run agw web login for a one-time login link"
  else
    echo "△ Gateway process started (pid $(cat "$PIDFILE")) but $port/health not ready; see log: $LOGFILE"
  fi
  show_config
}

# Hot restart: ask the master to swap the worker; the old worker drains in-flight responses, then exits.
# Returns non-zero when the swap cannot be done (caller falls back to a full stop+start).
hot_restart_gw() {
  [ "$AGW_HOT" = "1" ] || return 1
  is_running || return 1
  local pid oldw neww i port
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  oldw="$(cat "$WORKERPID" 2>/dev/null || echo 0)"
  kill -USR2 "$pid" 2>/dev/null || return 1
  for i in $(seq 1 60); do
    sleep 0.5
    neww="$(cat "$WORKERPID" 2>/dev/null || echo 0)"
    if [ "$neww" != "$oldw" ] && kill -0 "$neww" 2>/dev/null; then
      port="$(get_main_port)"
      if [ "$port" != "?" ] && health_ok "$port"; then
        echo "✓ Hot restart done (seamless): master $pid, new worker $neww (old worker drains then exits)"
        return 0
      fi
    fi
  done
  echo "△ Hot restart not done within 30s; falling back to full restart"
  return 1
}

stop_gw() {
  local pid
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$pid" ] && proc_is_gw "$pid"; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
    fi
    rm -f "$PIDFILE"
  fi
# Fallback orphan cleanup (this dir only)
  local op
  for op in $(gw_pids); do kill "$op" 2>/dev/null; sleep 0.3; kill -9 "$op" 2>/dev/null; done
  echo "✓ Gateway stopped"
}

status_gw() {
  if is_running; then
    local pid port
    pid="$(cat "$PIDFILE")"
    port="$(get_main_port)"
    echo "● Gateway running: pid $pid, main port $port"
    [ "$AGW_HOT" = "1" ] && [ -f "$WORKERPID" ] && echo "  worker: $(cat "$WORKERPID" 2>/dev/null) (hot-restart mode)"
    if health_ok "$port"; then echo "  health: OK"; else echo "  health: not ready"; fi
  else
    echo "○ Gateway not running"
  fi
  echo "Instance configs:"
  local n
  for n in $(list_instances); do echo "  - $n"; done
}

case "${1:-}" in
  start)        start_gw ;;
  stop)         stop_gw ;;
  restart)      hot_restart_gw || { stop_gw; sleep 1; start_gw; } ;;
  reload)       hot_restart_gw || { stop_gw; sleep 1; start_gw; } ;;
  status)       status_gw ;;
  list)         list_instances ;;
  logs)         tail -n "${2:-50}" "$LOGFILE" ;;
  __rotate)
    # Running this while the gateway is alive would move the file out from under its >> fd: writes
    # keep landing on the old inode, the panel stops seeing new lines until a restart, and nothing
    # frees the space. Refuse instead of producing a silent blackout.
    if is_running || [ -n "$(gw_pids)" ]; then
      echo "✗ gateway 正在运行, 拒绝轮转 (运行中轮转会让日志写进已被替换的 inode; 停服后 start 时会自动轮转)"
      exit 1
    fi
    rotate_log "$LOGFILE" ;;
  show)         show_config ;;
  config)       shift; node "$DIR/cfg-cli.js" "$@" ;;
  *)
    echo "OpenAGW gateway management (single-process multi-instance)"
    echo "Usage: $0 <start|stop|restart|reload|status|list|logs [lines]|show|config ...>"
    echo "      restart/reload: hot swap (master holds ports; old worker drains in-flight then exits) — no request failures"
    echo ""
    echo "Notes: one process hosts all instances; instance add/remove/start/stop/rename and channel management"
    echo "      take effect hot in the web panel: run agw web login for a one-time link"
    echo ""
    echo "Encrypted access (HTTPS): agw-tls for status | agw-tls setup to enable | agw-tls use for code"
    ;;
esac
