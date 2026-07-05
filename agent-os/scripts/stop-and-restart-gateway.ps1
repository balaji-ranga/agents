# Stop any process listening on OpenClaw gateway port 18789, then start openclaw gateway.
$port = 18789
$conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped process $($c.OwningProcess) on port $port"
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host "No process found on port $port"
}
Write-Host "Starting OpenClaw gateway on port $port..."
$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot'; openclaw gateway --port $port" -WindowStyle Normal
Start-Sleep -Seconds 10
Write-Host "Warming up managed browser..."
node (Join-Path $AgentOsRoot "scripts\warmup-openclaw-browser.js")
