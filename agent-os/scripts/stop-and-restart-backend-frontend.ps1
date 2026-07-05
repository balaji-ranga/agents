# Stop processes on backend (3001) and frontend (3000), then start backend and frontend.
$ErrorActionPreference = "SilentlyContinue"
$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

foreach ($port in @(3001, 3000)) {
  $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  if ($conns) {
    foreach ($c in $conns) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped process $($c.OwningProcess) on port $port"
    }
    Start-Sleep -Seconds 2
  } else {
    Write-Host "No process on port $port"
  }
}

Write-Host "Starting backend..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\backend'; npm run dev" -WindowStyle Normal
Start-Sleep -Seconds 4
Write-Host "Starting frontend..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\frontend'; npm run dev" -WindowStyle Normal
Write-Host "Done. Backend: http://127.0.0.1:3001  Frontend: http://127.0.0.1:3000"
