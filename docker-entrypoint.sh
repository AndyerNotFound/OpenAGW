#!/bin/sh
# ai-gateway container entrypoint: init the data volume on first start, then exec the given command (default node gateway.js)
set -e
DATA=/app/data
mkdir -p "$DATA/log" "$DATA/.run"
if [ ! -f "$DATA/config.json" ]; then
  echo "[entrypoint] first start: generating default config $DATA/config.json"
  echo "[entrypoint] ⚠ For public deployment set a gatewayKey and run node /app/agw.js web login for a one-time panel login link"
  cat > "$DATA/config.json" <<'CONF'
{
  "listen": { "host": "0.0.0.0", "port": 16384 },
  "gatewayKey": "",
  "panel": { "openBrowser": false },
  "channels": [
    { "name": "default", "type": "openai", "baseUrl": "https://api.deepseek.com", "apiKey": "change-this-to-your-API-Key", "default": true }
  ]
}
CONF
  chmod 600 "$DATA/config.json" 2>/dev/null || true
fi
# give a readable error when no args (no CMD) instead of exec'ing an empty command
if [ "$#" -eq 0 ]; then
  echo "[entrypoint] no executable command; default should be: node gateway.js" >&2
  exit 1
fi
exec "$@"
