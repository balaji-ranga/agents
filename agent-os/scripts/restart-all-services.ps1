# Stop Agent OS backend, frontend, and OpenClaw gateway; then start all three.
# Run from agent-os: .\scripts\restart-all-services.ps1

$ErrorActionPreference = "SilentlyContinue"
$AgentOsRoot = $PSScriptRoot + "\.."

function Stop-Port($port) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Write-Host "Stopping services on ports 18789, 3001, 3000..." -ForegroundColor Cyan
Stop-Port 18789
Stop-Port 3001
Stop-Port 3000
Start-Sleep -Seconds 2

Write-Host "Starting OpenClaw gateway (18789)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot'; openclaw gateway --port 18789" -WindowStyle Normal
Start-Sleep -Seconds 8

Write-Host "Starting backend (3001)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\backend'; npm run dev" -WindowStyle Normal
Start-Sleep -Seconds 3

Write-Host "Starting frontend (3000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\frontend'; npm run dev" -WindowStyle Normal

Write-Host "Done. Gateway :18789, backend :3001, frontend :3000" -ForegroundColor Green
Write-Host "Bootstrap watcher active - Workspace MD edits apply on the next agent message." -ForegroundColor Green
