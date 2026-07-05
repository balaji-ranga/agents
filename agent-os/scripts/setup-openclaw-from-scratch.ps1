# Set up OpenClaw from scratch with all Agent OS agents, skills, and config.
# Run from agent-os: .\scripts\setup-openclaw-from-scratch.ps1
# Prereq: Node.js 18+, OpenClaw CLI (npm install -g openclaw@latest). Optional: backend .env (OPENCLAW_WORKSPACE_PATH, etc.).

$ErrorActionPreference = "Stop"
$AgentOsRoot = (Get-Item $PSScriptRoot).Parent.FullName
$BackendRoot = Join-Path $AgentOsRoot "backend"

Push-Location $AgentOsRoot

Write-Host "`n=== 1. OpenClaw bootstrap ===" -ForegroundColor Cyan
openclaw setup
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "`n=== 2. Agent OS DB (seed agents + sample standup) ===" -ForegroundColor Cyan
Push-Location $BackendRoot
node scripts/seed-all.js
if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; exit $LASTEXITCODE }
node scripts/seed-expenses.js
if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "`n=== 3. Skills (agent-send, agent-os-content-tools) ===" -ForegroundColor Cyan
node scripts/install-agent-send-skill.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
node scripts/install-agent-os-content-tools-skill.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "`n=== 4. Content tools extension (plugin) ===" -ForegroundColor Cyan
node scripts/install-agent-os-content-tools-extension.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "`n=== 5. OpenClaw config (agents, plugins, Ollama, gateway) ===" -ForegroundColor Cyan
node scripts/apply-openclaw-agents-config.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "`n=== 6. Fix Ollama models shape (if needed) ===" -ForegroundColor Cyan
node scripts/fix-openclaw-ollama-models.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "`n=== 7. Workspace templates (SOUL.md, MEMORY.md per agent) ===" -ForegroundColor Cyan
node scripts/ensure-all-agent-workspaces.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "`n=== 8. COO workspace (AGENTS.md) ===" -ForegroundColor Cyan
Push-Location $BackendRoot
node scripts/ensure-coo-workspace.js
if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "`n=== 9. OpenClaw agent dirs (sessions) ===" -ForegroundColor Cyan
node scripts/ensure-openclaw-agent-dirs.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Pop-Location

Write-Host "`nDone. Start the gateway:" -ForegroundColor Green
Write-Host "  openclaw gateway --port 18789" -ForegroundColor White
Write-Host "Then start backend and frontend (see README Quick start)." -ForegroundColor Green
