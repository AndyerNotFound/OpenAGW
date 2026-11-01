#!/usr/bin/env bash
# Generate the ai-gateway local private CA (run once). Skipped if it exists; --force rebuilds and invalidates every installed device.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CA_KEY="$DIR/ca.key"
CA_PEM="$DIR/ca.pem"

if [ -f "$CA_PEM" ] && [ -f "$CA_KEY" ] && [ "${1:-}" != "--force" ]; then
  echo "• CA already exists, skipped (--force rebuilds it and invalidates all installed devices)"
  openssl x509 -in "$CA_PEM" -noout -subject -enddate
  exit 0
fi

openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -keyout "$CA_KEY" -out "$CA_PEM" \
  -subj "/O=ai-gateway Local/CN=ai-gateway Local Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" 2>/dev/null
chmod 600 "$CA_KEY"
chmod 644 "$CA_PEM"

echo "✓ Private CA generated"
openssl x509 -in "$CA_PEM" -noout -subject -enddate
echo ""
echo "  For distribution (public; never share the ca.key private key):"
echo "    $CA_PEM"
echo "  Install on other LAN devices: rename ca.pem to ai-gateway-ca.crt and install it as a CA certificate"
