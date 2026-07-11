# Agent OS backend API
FROM node:22-bookworm-slim

# python3: custom workflow script sandbox (Python); make/g++: better-sqlite3 native build
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 python3-minimal \
    make g++ ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-os

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend ./backend
COPY scripts ./scripts
COPY openclaw-workspace-templates ./openclaw-workspace-templates
COPY openclaw-skills ./openclaw-skills
COPY openclaw-extensions ./openclaw-extensions
COPY deploy ./deploy

WORKDIR /opt/agent-os/backend

ENV NODE_ENV=production
ENV HOME=/root
ENV OPENCLAW_DIR=/root/.openclaw
ENV OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json
ENV AGENT_OS_DATA_DIR=/data/agent-os
ENV CUSTOM_SCRIPT_PYTHON=python3
ENV CUSTOM_SCRIPT_NODE=node
ENV CUSTOM_SCRIPT_LLM_REVIEW=1
ENV CUSTOM_SCRIPT_LLM_REVIEW_REQUIRED=1
ENV CUSTOM_SCRIPT_LLM_REVIEW_MAX_TOKENS=768

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

CMD ["node", "src/index.js"]
