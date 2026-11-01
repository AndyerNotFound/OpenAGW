#!/bin/bash
# ai-gateway one-shot installer (Linux / macOS / Termux)
# Usage: curl -fsSL <raw-url>/install.sh | bash
#    or: bash install.sh [install-dir]
# Env: AGW_REPO=<source archive URL>  overrides the default GitHub archive (offline: file:///path/main.tar.gz)
set -e

DIR="${1:-$HOME/ai-gateway}"
ARCHIVE="${AGW_REPO:-https://github.com/AndyerNotFound/ai-gateway-AI/archive/refs/heads/main.tar.gz}"

echo "=== ai-gateway one-click install ==="
echo "Install dir: $DIR"
if [ "$ARCHIVE" != "https://github.com/AndyerNotFound/ai-gateway-AI/archive/refs/heads/main.tar.gz" ]; then echo "Source: $ARCHIVE"; fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not found. Install Node.js 18+ first:"
  echo "   Termux:  pkg install nodejs"
  echo "   Debian:  apt install nodejs"
  echo "   macOS:   brew install node"
  exit 1
fi
NV=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NV" -lt 18 ]; then echo "✗ Node too old ($(node -v)), need 18+"; exit 1; fi
echo "✓ node $(node -v)"

fetch_archive() {
  local url="$1" out="$2"
  case "$url" in
    file://*) cp "${url#file://}" "$out" ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$out"
      elif command -v wget >/dev/null 2>&1; then
        wget -q "$url" -O "$out"
      else
        echo "✗ curl or wget is required to download the source" >&2
        return 1
      fi
      ;;
  esac
}

mkdir -p "$DIR"
if [ -f "$DIR/gateway.js" ] && [ -f "$DIR/config.js" ] && [ -f "$DIR/panel-auth.js" ]; then
  echo "• Directory exists, skipping source download (re-run for upgrades after backing up config)"
else
  echo "Downloading source..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fetch_archive "$ARCHIVE" "$TMP/src.tgz"
  tar -xzf "$TMP/src.tgz" -C "$DIR" --strip-components=1
  rm -rf "$TMP"
  trap - EXIT
  echo "✓ Source ready"
fi
chmod +x "$DIR/agw.sh" "$DIR/agw-tls" "$DIR/agw.js" "$DIR/gen-cert.sh" "$DIR/watchdog.sh" 2>/dev/null || true

mkdir -p "$HOME/bin"
ln -sf "$DIR/agw.js" "$HOME/bin/agw"
case ":$PATH:" in *":$HOME/bin:"*) ;; *) echo "  ⚠ $HOME/bin not in PATH; add it to use agw" ;; esac

mkdir -p "$DIR/data"
CONFIG="$DIR/data/config.json"

# Old install.sh wrote config to $DIR/config.json; the new version reads $DIR/data/config.json -> auto-migrate to avoid silently losing config
if [ -f "$DIR/config.json" ] && [ ! -f "$CONFIG" ]; then
  mv "$DIR/config.json" "$CONFIG"
  echo "✓ Migrated legacy config: $DIR/config.json → $CONFIG"
elif [ -f "$DIR/config.json" ]; then
  echo "⚠ Legacy config found at $DIR/config.json (new version only reads $CONFIG); ignored, safe to delete"
fi

read_port() {
  node -e 'try{const fs=require("fs");let raw=fs.readFileSync(process.argv[1],"utf8");try{const c=require(process.argv[2]+"/crypt.js");if(c.isEncText(raw))raw=c.decryptText(raw,c.loadPass())}catch(_){};console.log((JSON.parse(raw).listen||{}).port||16384)}catch(e){console.log(16384)}' "$CONFIG" "$DIR"
}

probe_port() {
  node -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1");const f=c=>{try{s.destroy()}catch(_){}process.exit(c)};s.setTimeout(2000);s.on("connect",()=>f(0));s.on("error",()=>f(1));s.on("timeout",()=>f(1))' "$1" >/dev/null 2>&1
}

if [ -f "$CONFIG" ]; then
  echo "• Config exists, skipping init: $CONFIG"
else
  ask() {
    local prompt="$1" def="$2" val=""
    if [ -t 0 ]; then read -r -p "$prompt" val || true; fi
    printf '%s' "${val:-$def}"
  }
  echo ""
  echo "--- Initial config (non-interactive install uses defaults; edit $CONFIG later) ---"
  PORT=$(ask "Listen port [16384]: " "16384")
  GWKEY=$(ask "Gateway password (for client access; empty=no auth, REQUIRED for public use!): " "")
  CHTYPE=$(ask "First channel type [openai] (openai/claude/gemini): " "openai")
  CHURL=$(ask "Channel Base URL: " "https://api.deepseek.com")
  CHKEY=$(ask "Channel API Key: " "")
  cat > "$CONFIG" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "gatewayKey": "$GWKEY",
  "panel": { "openBrowser": true },
  "channels": [
    { "name": "default", "type": "$CHTYPE", "baseUrl": "$CHURL", "apiKey": "$CHKEY", "default": true }
  ]
}
EOF
  echo "✓ Config written to $CONFIG"
fi

PORT="$(read_port)"
PIDFILE="$DIR/data/.run/main.pid"
LOG="$DIR/data/log/gateway.log"

gw_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$DIR/gateway.js" || return 1
  printf '%s' "$pid"
}

# Validate the port first: if another program holds it, later probes get "answered" by it and you only find out it never started
if [ -z "$(gw_pid)" ] && probe_port "$PORT"; then
  echo "✗ Port $PORT is taken (not by this gateway)"
  echo "  Change listen.port in $CONFIG or stop the holder; diagnose: bash \"$DIR/agw.sh\" status"
  exit 1
fi

echo "Starting gateway..."
START_RC=0
bash "$DIR/agw.sh" start || START_RC=$?

READY=0
i=0
while [ "$i" -lt 30 ]; do
  if [ -n "$(gw_pid)" ] && probe_port "$PORT"; then READY=1; break; fi
  sleep 0.5
  i=$((i + 1))
done
if [ "$READY" != "1" ]; then
  echo "✗ Gateway not ready within 15s (pid file $PIDFILE, port $PORT, agw.sh returned $START_RC)"
  echo "  Recent log ($LOG):"
  tail -n 30 "$LOG" 2>/dev/null || true
  echo "  Diagnose: bash \"$DIR/agw.sh\" status | logs"
  bash "$DIR/agw.sh" stop >/dev/null 2>&1 || true
  exit 1
fi
if [ "$START_RC" != "0" ]; then
  echo "  ⚠ agw.sh start returned $START_RC but the process and port are fine; continuing"
fi

echo ""
echo "=== Install complete ==="
echo "  Gateway: http://127.0.0.1:$PORT"
echo "  Client base_url: http://127.0.0.1:$PORT/v1"
echo "  Panel login: agw web login"
echo "  Admin: agw start|stop|restart|status  (or bash $DIR/agw.sh ...)"
echo "  Log: $LOG"
GWKEY_SET=$(node -e 'try{const fs=require("fs");let raw=fs.readFileSync(process.argv[1],"utf8");try{const c=require(process.argv[2]+"/crypt.js");if(c.isEncText(raw))raw=c.decryptText(raw,c.loadPass())}catch(_){};const k=JSON.parse(raw).gatewayKey;console.log(k?"1":"0")}catch(e){console.log("0")}' "$CONFIG" "$DIR" 2>/dev/null || echo 0)
if [ "$GWKEY_SET" != "1" ]; then
  echo "  ⚠ gatewayKey is empty: local use only; set it before public/LAN deployment"
fi
