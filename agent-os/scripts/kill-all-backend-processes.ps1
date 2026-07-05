# Kill every orphaned agent-os backend/frontend dev server (each holds its own workflow cron).
$ErrorActionPreference = "SilentlyContinue"

$patterns = @(
  'agent-os[\\/]backend',
  'agent-os-backend',
  'agent-os[\\/]frontend',
  'agent-os-frontend',
  'seed-sample-job-discovery',
  'seed-brain-approval',
  'test-sample-job-discovery',
  'test-brain-approval'
)

$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  if (-not $_.CommandLine) { return $false }
  foreach ($p in $patterns) {
    if ($_.CommandLine -match $p) { return $true }
  }
  return $false
}

if (-not $procs) {
  Write-Host "No agent-os node processes matched by command line"
} else {
  foreach ($p in $procs) {
    Write-Host "Killing PID $($p.ProcessId): $($p.CommandLine)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

foreach ($port in @(3001, 3000)) {
  for ($i = 0; $i -lt 3; $i++) {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 }
    if (-not $conns) { break }
    foreach ($c in $conns) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped PID $($c.OwningProcess) on port $port"
    }
    Start-Sleep -Seconds 1
  }
}

Write-Host "`nRemaining node processes (for inspection):"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'Program Files\\nodejs' } |
  ForEach-Object { Write-Host "  PID $($_.ProcessId): $($_.CommandLine)" }

Write-Host "`nPort 3001 listeners:"
Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 }
