# Apply Bala, COO, TechResearcher to OpenClaw config and restart the gateway.
# Run from agent-os folder: .\scripts\apply-openclaw-agents-and-restart.ps1
# Prereq: Node.js and OpenClaw CLI (openclaw) in PATH.

$ErrorActionPreference = "Stop"
$AgentOsRoot = $PSScriptRoot + "\.."
$ConfigPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"

Write-Host "Applying agents (Bala, COO, TechResearcher) to OpenClaw config..." -ForegroundColor Cyan
Push-Location $AgentOsRoot
node scripts/apply-openclaw-agents-config.js
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "Restarting OpenClaw gateway..." -ForegroundColor Cyan
openclaw gateway restart
if ($LASTEXITCODE -ne 0) {
  Write-Host "Gateway restart failed. Start it manually: openclaw gateway --port 18789" -ForegroundColor Yellow
  exit $LASTEXITCODE
}
Write-Host "Done. Open http://127.0.0.1:18789 and check the agents menu for Bala, COO, TechResearcher." -ForegroundColor Green
