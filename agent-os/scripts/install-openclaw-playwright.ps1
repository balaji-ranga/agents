# Install Playwright Chromium for OpenClaw browser automation and enable browser in openclaw.json.
# Run from agent-os: .\scripts\install-openclaw-playwright.ps1

$ErrorActionPreference = "Stop"
$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OpenClawDir = Join-Path $env:USERPROFILE ".openclaw"
$ConfigPath = Join-Path $OpenClawDir "openclaw.json"
$PlaywrightCli = Join-Path $env:APPDATA "npm\node_modules\openclaw\node_modules\playwright-core\cli.js"

Write-Host "Installing Chromium for OpenClaw (playwright-core)..." -ForegroundColor Cyan
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA "ms-playwright"
if (-not (Test-Path $PlaywrightCli)) {
  Write-Host "playwright-core CLI not found at $PlaywrightCli" -ForegroundColor Red
  Write-Host "Install OpenClaw globally first: npm install -g openclaw" -ForegroundColor Yellow
  exit 1
}
node $PlaywrightCli install chromium
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Chromium installed to $env:PLAYWRIGHT_BROWSERS_PATH" -ForegroundColor Green

Write-Host "Enabling browser plugin in openclaw.json..." -ForegroundColor Cyan
node (Join-Path $AgentOsRoot "scripts\enable-openclaw-browser.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done. Restart the OpenClaw gateway:" -ForegroundColor Green
Write-Host "  openclaw gateway --port 18789" -ForegroundColor Green
Write-Host "Verify with:" -ForegroundColor Green
Write-Host "  openclaw browser --browser-profile openclaw status" -ForegroundColor Green
