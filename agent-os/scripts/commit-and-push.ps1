# Commit and push Agent OS changes to GitHub.
#
# Usage (from agent-os folder):
#   .\scripts\commit-and-push.ps1 -Message "Add agent workflow brain and Kanban updates"
#   .\scripts\commit-and-push.ps1 -Message "Fix discovery email" -Target agents
#   .\scripts\commit-and-push.ps1 -Message "WIP" -DryRun
#
# Targets:
#   agent-os  (default) - commit agent-os/ in the agents repo, then subtree push to remote "agent-os"
#   agents            - commit all changes in the agents repo, push to remote "mygithub"
#
# Safety: blocks .env / secrets, never force-pushes, never pushes to upstream "origin" unless -AllowOrigin.

param(
  [Parameter(Mandatory = $false)]
  [Alias('m')]
  [string]$Message,

  [ValidateSet('agent-os', 'agents')]
  [string]$Target = 'agent-os',

  [string]$Branch = 'main',

  [switch]$DryRun,

  [switch]$SkipPush,

  [switch]$AllowOrigin
)

$ErrorActionPreference = 'Stop'

$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AgentsRoot = (Resolve-Path (Join-Path $AgentOsRoot '..')).Path

function Write-Step([string]$Text) {
  Write-Host $Text -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
  Write-Host $Text -ForegroundColor Green
}

function Write-Warn([string]$Text) {
  Write-Host $Text -ForegroundColor Yellow
}

function Write-Err([string]$Text) {
  Write-Host $Text -ForegroundColor Red
}

function Invoke-Git {
  param([string[]]$GitArgs)
  Push-Location $AgentsRoot
  try {
    $output = & git @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ($output | Out-String).Trim()
    }
    return $output
  } finally {
    Pop-Location
  }
}

function Test-SecretPaths {
  param([string[]]$Paths)
  $blocked = @()
  foreach ($p in $Paths) {
    $norm = ($p -replace '\\', '/').ToLowerInvariant()
    $name = [System.IO.Path]::GetFileName($norm).ToLowerInvariant()

    # Block real env files; allow safe templates like .env.example
    if ($name -eq '.env') { $blocked += $p; continue }
    if ($name -match '^\.env\.' -and $name -notmatch '^\.env\.(example|sample|template)$') {
      $blocked += $p
      continue
    }

    if ($norm -match 'credentials\.json$') { $blocked += $p; continue }
    if ($norm -match '(^|/)node_modules/') { $blocked += $p; continue }
    if ($norm -match '\.(pem|key|p12)$') { $blocked += $p; continue }
  }
  return $blocked
}

Write-Step "Agent OS - commit and push"
Write-Host "  Repo root : $AgentsRoot"
Write-Host "  Target    : $Target"
Write-Host "  Branch    : $Branch"
Write-Host ""

$remotes = Invoke-Git @('remote', '-v')
if (-not $remotes) {
  throw 'No git remotes configured.'
}

$remoteName = if ($Target -eq 'agent-os') { 'agent-os' } else { 'mygithub' }
$remoteLine = ($remotes | Where-Object { $_ -match "^$remoteName\s" } | Select-Object -First 1)
if (-not $remoteLine) {
  throw "Remote '$remoteName' not found. Run: git remote -v"
}
Write-Host "  Remote    : $remoteLine"

if ($remoteLine -match 'ed-donner/agents' -and -not $AllowOrigin) {
  throw "Refusing to push to upstream course repo. Use -Target agents (mygithub) or -Target agent-os."
}

if (-not $Message) {
  $Message = Read-Host 'Commit message'
}
if ([string]::IsNullOrWhiteSpace($Message)) {
  throw 'Commit message is required.'
}

Push-Location $AgentsRoot
try {
  Write-Step 'Git status'
  git status --short
  Write-Host ''

  $stagePath = if ($Target -eq 'agent-os') { 'agent-os' } else { '.' }

  if ($DryRun) {
    Write-Warn '[DryRun] Would stage: git add -- agent-os (or entire repo for -Target agents)'
    $candidates = git status --porcelain | ForEach-Object {
      if ($_ -match '^\?\?\s+(.+)$') { $Matches[1] }
      elseif ($_ -match '^[ MADRCU?!]{2}\s+(.+)$') { $Matches[1] }
    }
  } else {
    git add -- $stagePath
    $staged = git diff --cached --name-only
    if (-not $staged) {
      Write-Warn 'Nothing to commit (working tree clean for selected scope).'
      exit 0
    }

    $blocked = Test-SecretPaths -Paths $staged
    if ($blocked.Count -gt 0) {
      Write-Err 'Refusing to commit files that look like secrets or dependencies:'
      $blocked | ForEach-Object { Write-Err "  $_" }
      git reset HEAD --quiet
      throw 'Unstage blocked files and retry.'
    }

    Write-Step 'Staged changes'
    git diff --cached --stat
    Write-Host ''

    git commit -m $Message
    Write-Ok "Committed: $Message"
  }

  if ($SkipPush) {
    Write-Warn 'SkipPush set - commit only, no push.'
    exit 0
  }

  if ($DryRun) {
    if ($Target -eq 'agent-os') {
      Write-Warn "[DryRun] Would run: git subtree push --prefix=agent-os $remoteName $Branch"
    } else {
      Write-Warn "[DryRun] Would run: git push -u $remoteName $Branch"
    }
    exit 0
  }

  Write-Step 'Pushing to GitHub...'
  if ($Target -eq 'agent-os') {
    git subtree push --prefix=agent-os $remoteName $Branch
  } else {
    git push -u $remoteName $Branch
  }
  Write-Ok "Pushed to $remoteName ($Branch)"
} finally {
  Pop-Location
}
