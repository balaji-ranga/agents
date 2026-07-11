# Agent OS — Container deployment

Production stack for Agent OS: **nginx**, **frontend**, **backend**, **OpenClaw gateway**, plus optional **init**, **MCP**, **Ollama**, and **browser-login** services.

Works with **Docker Compose** and **Podman Compose** on CentOS/RHEL and other Linux hosts.

## Containers

| Service | Required | Port (host) | Purpose |
|---------|----------|-------------|---------|
| `nginx` | Yes | 80, 443 | TLS, `/` → frontend, `/api` → backend |
| `frontend` | Yes | internal | React SPA (Vite build) |
| `backend` | Yes | internal | API, cron, workflows, SQLite |
| `openclaw` | Yes | internal | Gateway :18789, browser tool, skills/plugins |
| `init` | First run | — | One-shot bootstrap (`--profile init`) |
| `mcp-random-sse` | Optional | internal | Dev MCP + SSE test server |
| `ollama` | Optional | internal | Local LLM fallback for OpenClaw |
| `novnc` | Optional | 6080 | Desktop for manual job-portal login |

## Volumes (persist)

| Volume | Mount | Contents |
|--------|-------|----------|
| `agent_os_data` | backend `/data/agent-os` | SQLite (`agent-os.db`) |
| `openclaw_home` | backend + openclaw `/root/.openclaw` | `openclaw.json`, workspaces, browser profile, media, sessions |
| `ollama_data` | ollama | Local models (optional profile) |

## OpenClaw feature parity (Docker init vs local setup)

The `init` container runs `setup-openclaw-from-scratch.sh --docker`, which matches (and extends) the Windows `setup-openclaw-from-scratch.ps1`:

| Feature | Local / Windows | Docker init |
|---------|-----------------|-------------|
| Skills: agent-send, agent-os-content-tools | ✓ | ✓ |
| Extensions: content-tools + bootstrap-watcher | partial (PS: content-tools only) | ✓ both |
| `openclaw.json` agents (Bala, COO, Workflow Builder, …) | ✓ | ✓ |
| Job Applicant agents + job tools | manual (`setup-job-applicant-agents.js`) | ✓ default |
| Content tools plugin + `baseUrl` → backend | manual env | ✓ `http://backend:3001` |
| Content tools plugin `apiKey` ↔ backend `TOOLS_API_KEY` | `ensure-tools-api-key.js` | ✓ init via `configure-openclaw-docker.js` |
| Gateway token auth | manual `.env` | ✓ from `OPENCLAW_GATEWAY_TOKEN` |
| Browser tool + Playwright Chromium | manual PS script | ✓ |
| Browser TOOLS.md sections | manual sync script | ✓ |
| Session visibility (`tools.sessions.visibility`) | manual one-off | ✓ `agent` |
| Ollama fallback provider | ✓ | ✓ (use `optional-ollama` profile) |
| Hot-reload workspace MD (bootstrap watcher) | ✓ | ✓ |
| Custom workflow scripts (Python/JS sandbox) | ✓ | ✓ (`python3` in backend image) |
| Per-agent tool grants / allowlists | backend startup sync | ✓ backend startup |

Verify after init:

```bash
docker compose --profile init run --rm init
# or against running volume:
docker compose run --rm openclaw node deploy/scripts/verify-openclaw-parity.js
```

Skip Job Applicant in init: add `--no-job-applicant` to the bootstrap command in `openclaw-entrypoint.sh` or run init with a custom command.

## Quick start

```bash
cd agent-os/deploy
cp .env.example .env
# Edit: AGENT_OS_PUBLIC_URL, OPENCLAW_GATEWAY_TOKEN, OPENAI_API_KEY, admin password

./scripts/generate-dev-certs.sh agent-os.example.com   # or use real certs in nginx/certs/

# Bootstrap + build + start
./scripts/up.sh

# Or step by step:
docker compose build
docker compose --profile init run --rm init
docker compose up -d
```

**Dev (HTTP only, no TLS):**

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
# UI: http://localhost:8080
```

## Bootstrap script

`scripts/setup-openclaw-from-scratch.sh` (repo root) is the Linux/bash equivalent of `setup-openclaw-from-scratch.ps1`.

It runs inside the **`init`** container (or on bare metal) and:

1. `openclaw setup` (if no config)
2. Seeds SQLite (`seed-all.js`, `seed-expenses.js`)
3. Installs skills + extensions
4. Writes `openclaw.json` (agents, plugins, browser, gateway)
5. Applies Docker overrides (`configure-openclaw-docker.js`) — gateway token, plugin `baseUrl`, plugin `apiKey`
6. Workspace templates + COO AGENTS.md + session dirs
7. Optional Playwright Chromium (`--install-browser`)

Re-run after upgrades that change agents/skills:

```bash
docker compose --profile init run --rm init
docker compose restart openclaw backend
```

## Environment & LLM secrets

All secrets live in **`deploy/.env`** (gitignored). Compose injects them as **runtime environment variables** — they are **not** baked into images. At init, **`OPENCLAW_GATEWAY_TOKEN`** and **`TOOLS_API_KEY`** are also written into `openclaw.json` (gateway auth + content-tools plugin).

### Shared keys: backend ↔ OpenClaw

| Key | Backend | OpenClaw |
|-----|---------|----------|
| `OPENCLAW_GATEWAY_TOKEN` | `OPENCLAW_GATEWAY_TOKEN` env | `gateway.auth.token` in openclaw.json |
| `TOOLS_API_KEY` | `TOOLS_API_KEY` env | `plugins.entries['agent-os-content-tools'].config.apiKey` |

Both sides must match or COO/content-tools calls fail with 401.

**First deploy / auto-generate:**

```bash
cd agent-os/deploy
cp .env.example .env
# up.sh runs this before init if TOOLS_API_KEY is missing:
node ../scripts/ensure-tools-api-key.js --env-file .env --skip-openclaw
docker compose --profile init run --rm init
```

**Local dev (non-Docker):**

```bash
cd agent-os
node scripts/ensure-tools-api-key.js
# syncs backend/.env + ~/.openclaw/openclaw.json
```

**Rotate or fix a mismatch:**

```bash
# 1. Set the same value in deploy/.env (or re-run ensure-tools-api-key.js)
# 2. Re-apply openclaw.json plugin config:
docker compose run --rm openclaw node deploy/scripts/configure-openclaw-docker.js
# 3. Recreate services so env is picked up:
docker compose up -d --force-recreate openclaw backend
```

### OpenClaw gateway (`openclaw` container)

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Default OpenAI-compatible provider |
| `OPENAI_PRIMARY_*`, `OPENAI_SECONDARY_*` | Aliases / fallback endpoint |
| `ANTHROPIC_API_KEY` | Claude models (e.g. `anthropic/claude-opus-4-6`) |
| `OPENCLAW_MODEL_PRIMARY` | Default agent model slug (also in `openclaw.json` at init) |
| `OLLAMA_BASE_URL`, `OLLAMA_API_KEY` | Local Ollama fallback |
| `OPENROUTER_*` | If using OpenRouter-backed models in OpenClaw config |

### Backend (`backend` container)

Gets the same gateway LLM vars plus:

| Variable | Purpose |
|----------|---------|
| `OPENAI_COO_MODEL`, `OPENAI_INTENT_MODEL` | COO / intent classifier |
| `REPLICATE_API_TOKEN` | Video generation content tool |
| `OPENROUTER_*` | Dev/test scripts only |
| `CUSTOM_SCRIPT_*` | Python/JS workflow script sandbox (`python3` in image); includes LLM security review at registration |
| `CUSTOM_SCRIPT_LLM_REVIEW` | `1` = LLM certifies scripts after regex scan (uses backend `OPENAI_*` / Ollama) |
| `CUSTOM_SCRIPT_LLM_REVIEW_REQUIRED` | `1` = reject registration if LLM review unavailable |

**Workflow Brain nodes:** published workflows require API keys **on each Brain node** in the editor — platform `.env` keys are not used at run time (see `backend/.env.example`).

### Critical production values

- `AGENT_OS_PUBLIC_URL` — public HTTPS URL (workflow webhooks, callbacks)
- `OPENCLAW_GATEWAY_TOKEN` — must match `gateway.auth.token` in openclaw.json (set by init)
- `TOOLS_API_KEY` — must match `plugins.entries['agent-os-content-tools'].config.apiKey` (set by init)
- `VITE_API_URL=/api` — frontend calls nginx-relative API path
- Do **not** publish OpenClaw port 18789 to the host

After changing keys in `.env`:

```bash
docker compose run --rm openclaw node deploy/scripts/configure-openclaw-docker.js
docker compose up -d --force-recreate openclaw backend
```

## Optional Compose profiles

```bash
# Local MCP SSE test server (port 3099 internal)
docker compose --profile optional-mcp up -d

# Ollama fallback (pull a model after start: docker compose exec ollama ollama pull llama3.2)
docker compose --profile optional-ollama up -d

# Browser login helper — set ENABLE_VNC=1 in .env, then:
docker compose --profile optional-browser-login up -d
# noVNC UI: http://host:6080 — see knowledgebase/DEPLOY-CENTOS-PODMAN.md
```

## Build images only

```bash
docker compose build backend frontend openclaw
```

## CentOS / Podman

See **knowledgebase/DEPLOY-CENTOS-PODMAN.md** for SELinux (`:Z` volumes), rootless Podman, firewall, and browser-on-headless-server notes.

```bash
USE_PODMAN=1 ./scripts/up.sh
# or: podman-compose -f docker-compose.yml up -d
```

## Smoke test

```bash
curl -k https://localhost/health
curl -k https://localhost/api/health
```

From repo (against deployed URL):

```bash
AGENT_OS_BASE_URL=https://your-domain cd ../backend && npm run test:smoke
```
