# Restart backend and frontend (same folder), then run full API tests.
# OpenClaw gateway: start separately (openclaw gateway --port 18789) if you want chat tests to pass.
# Run from agent-os: .\scripts\restart-and-test.ps1

$ErrorActionPreference = "Stop"
$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host "Restarting backend..." -ForegroundColor Cyan
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" } | ForEach-Object {
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
    if ($cmd -match "3001|agent-os\\backend") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  } catch {}
}
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\backend'; npm run dev" -WindowStyle Normal
Start-Sleep -Seconds 3

Write-Host "Running full API tests (backend)..." -ForegroundColor Cyan
$env:BASE_URL = "http://127.0.0.1:3001"
$env:SKIP_RUN_COO = "1"
$env:SKIP_CHAT = "1"
node "$AgentOsRoot\tests\api-full.js"
$apiExit = $LASTEXITCODE

if ($apiExit -ne 0) {
  Write-Host "API tests failed (exit $apiExit). Fix backend and re-run." -ForegroundColor Red
  exit $apiExit
}
Write-Host "API tests passed. Start frontend manually: cd frontend; npm run dev" -ForegroundColor Green
Write-Host "For chat tests: start OpenClaw gateway (openclaw gateway --port 18789), then run: node tests/api-full.js" -ForegroundColor Yellow
