#!/usr/bin/env bash
# Build, bootstrap, and start Agent OS (Docker Compose or Podman Compose).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${DEPLOY_DIR}"

COMPOSE="${COMPOSE_CMD:-docker compose}"
if command -v podman-compose >/dev/null 2>&1 && [[ "${USE_PODMAN:-0}" == "1" ]]; then
  COMPOSE="podman-compose"
fi

if [[ ! -f .env ]]; then
  echo "Copy .env.example to .env and edit secrets first." >&2
  exit 1
fi

if [[ ! -f nginx/certs/fullchain.pem ]]; then
  echo "TLS certs missing — generating dev self-signed certs..."
  bash scripts/generate-dev-certs.sh
fi

echo "Building images..."
${COMPOSE} build

echo "Running one-shot bootstrap (init profile)..."
${COMPOSE} --profile init run --rm init

echo "Starting stack..."
${COMPOSE} up -d "$@"

echo ""
echo "Stack started. Check: ${COMPOSE} ps"
echo "Health: curl -k https://localhost/health  (or http://localhost:8080 with docker-compose.dev.yml)"
