#!/usr/bin/env bash
# Issue the ai-gateway server certificate with the local CA.
#   bash gen-server.sh            generate/update cert.pem + key.pem (SAN automatically includes all non-loopback IPv4 addresses)
#   bash gen-server.sh --ensure   re-sign only when expired / not issued by this CA / SAN missing current IP (good for cron)
#   bash gen-server.sh --force    re-sign unconditionally
#   EXTRA_SAN="DNS:agw.local"     append extra SANs
# Note: on Termux the `ip` command cannot bind netlink (Android 11+); probe addresses with ifconfig instead.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
CA_PEM="$DIR/ca.pem"; CA_KEY="$DIR/ca.key"
OUT_CERT="$ROOT/data/cert.pem"; OUT_KEY="$ROOT/data/key.pem"
DAYS="${DAYS:-397}"
EXTRA_SAN="${EXTRA_SAN:-}"
MODE="${1:-}"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"

[ -f "$CA_PEM" ] || { echo "✗ Missing $CA_PEM; run: bash $DIR/gen-ca.sh first"; exit 1; }

# Prints "interface IP", preferring wlan/eth (primary LAN addresses)
detect_if_ip() {
  ifconfig 2>/dev/null | awk '/^[a-zA-Z0-9_.-]+:/{ifn=$1; sub(":","",ifn)} /inet /{print ifn, $2}' |
    grep -vE ' (127\.|$)' | awk '{print ($1 ~ /^(wlan|eth|ap|swlan)/ ? 0 : 1), $1, $2}' |
    sort -k1,1n -k2,2 | awk '{print $2" "$3}' || true
}
detect_ips() { detect_if_ip | awk '{print $2}' | sort -u; }

build_san() {
  local s="DNS:localhost,IP:127.0.0.1,IP:::1" ip
  for ip in $(detect_ips); do s="$s,IP:$ip"; done
  [ -n "$EXTRA_SAN" ] && s="$s,$EXTRA_SAN"
  printf '%s' "$s"
}

SAN="$(build_san)"
NEED=1

if [ "$MODE" != "--force" ] && [ -f "$OUT_CERT" ] && [ -f "$OUT_KEY" ]; then
  if openssl verify -CAfile "$CA_PEM" "$OUT_CERT" >/dev/null 2>&1 &&
     openssl x509 -in "$OUT_CERT" -noout -checkend 604800 >/dev/null 2>&1; then
    CUR="$(openssl x509 -in "$OUT_CERT" -noout -ext subjectAltName 2>/dev/null | tr -d ' \n')"
    OK=1
    case "$CUR" in *"DNS:localhost"*) ;; *) OK=0 ;; esac
    for ip in $(detect_ips); do
      case "$CUR" in *"IPAddress:$ip"*) ;; *) OK=0 ;; esac
    done
    [ "$OK" = "1" ] && NEED=0
  fi
fi

if [ "$NEED" = "0" ]; then
  echo "✓ Cert is valid and covers all current IPs; no re-sign needed"
  openssl x509 -in "$OUT_CERT" -noout -subject -enddate -ext subjectAltName
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CN="$(detect_if_ip | awk 'NR==1{print $2}')"
CN="${CN:-localhost}"

cat > "$TMP/ext.cnf" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF

openssl req -new -newkey rsa:2048 -nodes -keyout "$TMP/key.pem" -out "$TMP/req.csr" \
  -subj "/O=ai-gateway Local/CN=$CN" 2>/dev/null
openssl x509 -req -in "$TMP/req.csr" -CA "$CA_PEM" -CAkey "$CA_KEY" -CAcreateserial \
  -days "$DAYS" -sha256 -extfile "$TMP/ext.cnf" -out "$TMP/cert.pem" 2>/dev/null
openssl verify -CAfile "$CA_PEM" "$TMP/cert.pem"

if [ -f "$OUT_CERT" ]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  cp -p "$OUT_CERT" "$DIR/legacy/cert.pem.$TS" 2>/dev/null || true
  cp -p "$OUT_KEY"  "$DIR/legacy/key.pem.$TS"  2>/dev/null || true
  echo "• Old cert archived to $DIR/legacy/ ($TS)"
fi

install -m 644 "$TMP/cert.pem" "$OUT_CERT"
install -m 600 "$TMP/key.pem"  "$OUT_KEY"

echo "✓ New certificate installed"
echo "  Cert: $OUT_CERT"
echo "  Key: $OUT_KEY (600)"
openssl x509 -in "$OUT_CERT" -noout -subject -enddate -ext subjectAltName
