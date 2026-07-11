# Local MCP random SSE test server (optional dev / workflow testing)
FROM node:22-bookworm-slim

WORKDIR /app
COPY tools/local-mcp-random-sse/server.js ./server.js

ENV MCP_RANDOM_PORT=3099
EXPOSE 3099

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${MCP_RANDOM_PORT}/health" || exit 1

CMD ["node", "server.js"]
