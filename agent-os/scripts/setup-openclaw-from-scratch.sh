#!/usr/bin/env bash
# Bootstrap Agent OS + OpenClaw on bare metal (CentOS/Linux) or inside the init container.
#
# Purpose:
#   One-time setup that prepares everything OpenClaw and the backend need before the
#   gateway starts: workspace dirs, SQLite seeds, skills, extensions, openclaw.json,
#   agent workspace templates (SOUL/AGENTS/MEMORY/TOOLS), and session dirs.
#
# Parity with Windows setup-openclaw-from-scratch.ps1 PLUS:
#   - both OpenClaw extensions (content-tools + bootstrap-watcher)
#   - Workflow Builder agent seed
#   - Job Applicant agents (optional, default on in Docker)
#   - browser tool allowlists + TOOLS.md browser sections
#   - Docker gateway auth / plugin baseUrl / session visibility
#
# Usage:
#   ./scripts/setup-openclaw-from-scratch.sh
#   ./scripts/setup-openclaw-from-scratch.sh --docker
#   ./scripts/setup-openclaw-from-scratch.sh --docker --skip-db-seed
#   ./scripts/setup-openclaw-from-scratch.sh --no-job-applicant
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_OS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_ROOT="${AGENT_OS_ROOT}/backend"

DOCKER_MODE=0
SKIP_DB_SEED=0
SKIP_OPENCLAW_SETUP=0
INSTALL_BROWSER=0
INSTALL_JOB_APPLICANT=1

for arg in "$@"; do
  case "$arg" in
    --docker) DOCKER_MODE=1; INSTALL_BROWSER=1 ;;
    --skip-db-seed) SKIP_DB_SEED=1 ;;
    --skip-openclaw-setup) SKIP_OPENCLAW_SETUP=1 ;;
    --install-browser) INSTALL_BROWSER=1 ;;
    --no-job-applicant) INSTALL_JOB_APPLICANT=0 ;;
    -h|--help)
      grep '^#' "$0" | head -25 | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$DOCKER_MODE" -eq 1 ]]; then
  export HOME="${HOME:-/root}"
  export OPENCLAW_DIR="${OPENCLAW_DIR:-/root/.openclaw}"
  export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/root/.openclaw/openclaw.json}"
  export AGENT_OS_DATA_DIR="${AGENT_OS_DATA_DIR:-/data/agent-os}"
  INSTALL_JOB_APPLICANT="${INSTALL_JOB_APPLICANT:-1}"
  INSTALL_BROWSER=1
fi

export HOME="${HOME:-${USERPROFILE:-}}"
export OPENCLAW_DIR="${OPENCLAW_DIR:-${HOME}/.openclaw}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_DIR}/openclaw.json}"
mkdir -p "${OPENCLAW_DIR}"

run_step() {
  echo ""
  echo "=== $1 ==="
}

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required on PATH"
command -v openclaw >/dev/null 2>&1 || fail "openclaw CLI is required (npm install -g openclaw@latest)"

cd "${AGENT_OS_ROOT}"

run_step "1. OpenClaw bootstrap"
if [[ "$SKIP_OPENCLAW_SETUP" -eq 0 ]]; then
  if [[ ! -f "${OPENCLAW_DIR}/openclaw.json" ]]; then
    openclaw setup || fail "openclaw setup failed"
  else
    echo "openclaw.json already exists — skipping openclaw setup"
  fi
else
  echo "Skipped (--skip-openclaw-setup)"
fi

run_step "2. Agent OS DB (seed agents + sample standup)"
if [[ "$SKIP_DB_SEED" -eq 0 ]]; then
  cd "${BACKEND_ROOT}"
  node scripts/seed-all.js
  node scripts/seed-expenses.js
  node scripts/seed-workflow-builder-agent.js
  cd "${AGENT_OS_ROOT}"
else
  echo "Skipped (--skip-db-seed)"
fi

run_step "3. Skills (agent-send, agent-os-content-tools)"
node scripts/install-agent-send-skill.js
node scripts/install-agent-os-content-tools-skill.js

run_step "4. OpenClaw extensions (content-tools + bootstrap watcher)"
node scripts/install-openclaw-extensions.js

run_step "5. OpenClaw config (agents, plugins, gateway, browser, tools)"
node scripts/apply-openclaw-agents-config.js

if [[ "$INSTALL_JOB_APPLICANT" -eq 1 ]]; then
  run_step "6. Job Applicant agents (jobdiscovery, fitscorer, resumetailor, applicationagent)"
  node scripts/setup-job-applicant-agents.js
else
  echo ""
  echo "=== 6. Job Applicant agents — skipped (--no-job-applicant) ==="
fi

if [[ "$DOCKER_MODE" -eq 1 ]]; then
  run_step "7. Docker/production OpenClaw overrides (auth, plugin baseUrl, session visibility)"
  node "${AGENT_OS_ROOT}/deploy/scripts/configure-openclaw-docker.js"
else
  echo ""
  echo "=== 7. Docker overrides — skipped (not --docker) ==="
fi

run_step "8. Fix Ollama models shape (if needed)"
node scripts/fix-openclaw-ollama-models.js

run_step "9. Workspace templates (SOUL.md, MEMORY.md, TOOLS.md per agent)"
node scripts/ensure-all-agent-workspaces.js

run_step "10. COO workspace (AGENTS.md)"
cd "${BACKEND_ROOT}"
node scripts/ensure-coo-workspace.js
cd "${AGENT_OS_ROOT}"

run_step "11. OpenClaw agent dirs (sessions)"
node scripts/ensure-openclaw-agent-dirs.js

run_step "12. Browser tool on all agents"
node scripts/ensure-browser-all-agents.js

run_step "13. Browser instructions in agent TOOLS.md"
node scripts/sync-browser-tools-md.js

if [[ "$INSTALL_BROWSER" -eq 1 ]]; then
  run_step "14. Browser automation (Playwright Chromium)"
  node scripts/enable-openclaw-browser.js
  if [[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]] && command -v npx >/dev/null 2>&1; then
    npx playwright install chromium 2>/dev/null || true
  fi
fi

if [[ -f "${AGENT_OS_ROOT}/deploy/scripts/verify-openclaw-parity.js" ]]; then
  run_step "15. Verify OpenClaw parity"
  node "${AGENT_OS_ROOT}/deploy/scripts/verify-openclaw-parity.js" || fail "OpenClaw parity check failed"
fi

echo ""
echo "Done. Bootstrap complete."
if [[ "$DOCKER_MODE" -eq 0 ]]; then
  echo "Start the gateway:  openclaw gateway --port 18789"
  echo "Then backend + frontend (see README Quick start)."
else
  echo "Init container finished — start openclaw + backend services."
fi
