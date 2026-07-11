#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-gateway}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

mkdir -p "${OPENCLAW_DIR:-/root/.openclaw}"

start_vnc_if_enabled() {
  if [[ "${ENABLE_VNC:-0}" != "1" ]]; then
    return 0
  fi
  export DISPLAY="${DISPLAY:-:99}"
  if ! pgrep -x Xvfb >/dev/null 2>&1; then
    echo "[openclaw] Starting Xvfb on ${DISPLAY}..."
    Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
    sleep 2
  fi
  if ! pgrep -x x11vnc >/dev/null 2>&1; then
    echo "[openclaw] Starting x11vnc on :5900..."
    x11vnc -display "${DISPLAY}" -forever -shared -rfbport 5900 -nopw -bg
  fi
}

case "${MODE}" in
  gateway)
    start_vnc_if_enabled
    echo "[openclaw] Starting gateway on port ${GATEWAY_PORT}..."
    exec openclaw gateway --port "${GATEWAY_PORT}"
    ;;
  bootstrap)
    echo "[openclaw] Running bootstrap..."
    exec /opt/agent-os/scripts/setup-openclaw-from-scratch.sh --docker --install-browser
    ;;
  *)
    echo "Unknown mode: ${MODE} (use gateway|bootstrap)" >&2
    exit 1
    ;;
esac
