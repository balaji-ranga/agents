# Stop backend (port 3001) and restart.
$ErrorActionPreference = "SilentlyContinue"
$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

& (Join-Path $PSScriptRoot "kill-all-backend-processes.ps1")

foreach ($port in @(3001)) {
  for ($i = 0; $i -lt 3; $i++) {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 }
    if (-not $conns) { break }
    foreach ($c in $conns) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped process $($c.OwningProcess) on port $port"
    }
    Start-Sleep -Seconds 2
  }
}

Write-Host "Starting backend..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\backend'; npm run dev" -WindowStyle Normal
Start-Sleep -Seconds 5
$listen = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
  Write-Host "Backend listening on http://127.0.0.1:3001"
} else {
  Write-Host "Backend started (port 3001 may still be binding)"
}
