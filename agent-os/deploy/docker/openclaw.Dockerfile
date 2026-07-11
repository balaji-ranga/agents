# OpenClaw gateway + Playwright Chromium for browser automation
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    # Playwright/Chromium runtime deps (Debian bookworm)
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libdbus-1-3 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 fonts-liberation xvfb x11vnc \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" \
  && npx playwright install chromium \
  && npx playwright install-deps chromium || true

WORKDIR /opt/agent-os
COPY . .

RUN cd backend && npm ci --omit=dev

ENV HOME=/root
ENV OPENCLAW_DIR=/root/.openclaw
ENV OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

COPY deploy/docker/openclaw-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789 5900

ENTRYPOINT ["/entrypoint.sh"]
CMD ["gateway"]
