#!/usr/bin/env bash
# Generate self-signed TLS certs for nginx (dev / staging only).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../nginx/certs" && pwd)"
mkdir -p "${DIR}"

CN="${1:-agent-os.local}"
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "${DIR}/privkey.pem" \
  -out "${DIR}/fullchain.pem" \
  -subj "/CN=${CN}"

echo "Wrote ${DIR}/fullchain.pem and ${DIR}/privkey.pem (CN=${CN})"
