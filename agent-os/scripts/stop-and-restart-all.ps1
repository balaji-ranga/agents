# Stop OpenClaw gateway (18789), backend (3001), and frontend (3000); then start all three.
# Run from agent-os: .\scripts\stop-and-restart-all.ps1

$ErrorActionPreference = "Stop"
$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$ports = @(18789, 3001, 3000)
Write-Host "Stopping processes on ports $($ports -join ', ')..." -ForegroundColor Cyan
foreach ($p in $ports) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
      Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "  Stopped port $p (PID $($conn.OwningProcess))" -ForegroundColor Yellow
    }
  } catch {}
}
Start-Sleep -Seconds 2

Write-Host "Starting OpenClaw gateway, backend, and frontend..." -ForegroundColor Cyan
& (Join-Path $AgentOsRoot "start-all.ps1") -AgentOsRoot $AgentOsRoot
