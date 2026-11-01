#!/usr/bin/env bash
# [DEPRECATED] old self-signed cert generator -- replaced by tls/gen-server.sh (with gen-ca.sh).
# Current flow: agw-tls setup -> tls/gen-ca.sh + tls/gen-server.sh (certs land in data/, SAN auto-includes all LAN IPs)
# Kept only for compatibility with old docs/muscle memory; do not use for new deployments.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CN="${1:-localhost}"
echo "⚠ This script is deprecated: the cert SAN hardcodes a single IP and cannot follow LAN address changes."
echo "  Use instead: bash tls/gen-server.sh        # outputs data/cert.pem + data/key.pem"
echo "               bash tls/gen-ca.sh            # create the CA first"
exit 1
