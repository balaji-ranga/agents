# Agent OS — start OpenClaw gateway, backend, and frontend
# Run in PowerShell from the agent-os folder (or pass -AgentOsRoot path).
# Prereq: npm install already run in backend/ and frontend/ (run once if needed).

param([string]$AgentOsRoot = $PSScriptRoot)

$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "Agent OS: starting services..." -ForegroundColor Cyan

# 1) OpenClaw gateway (port 18789)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot'; openclaw gateway --port 18789" -WindowStyle Normal
Start-Sleep -Seconds 3

# 2) Backend (port 3001)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\backend'; npm run dev" -WindowStyle Normal
Start-Sleep -Seconds 2

# 3) Frontend (port 3000)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$AgentOsRoot\frontend'; npm run dev" -WindowStyle Normal

Write-Host "Started 3 windows: OpenClaw gateway (18789), backend (3001), frontend (3000)." -ForegroundColor Green
Write-Host "Open http://127.0.0.1:3000 in your browser for the Agent OS web app." -ForegroundColor Green
