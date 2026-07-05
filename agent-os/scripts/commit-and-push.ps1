# Commit and push Agent OS changes to GitHub.
#
# Usage (from agent-os folder):
#   .\scripts\commit-and-push.ps1 -Message "Add agent workflow brain and Kanban updates"
#   .\scripts\commit-and-push.ps1 -Message "Fix discovery email" -Target agents
#   .\scripts\commit-and-push.ps1 -PushOnly -Message "Add agent workflow brain and Kanban updates"
#   .\scripts\commit-and-push.ps1 -Message "WIP" -DryRun
#
# Targets:
#   agent-os  (default) - commit agent-os/ in the agents repo, then push to remote "agent-os"
#   agents            - commit all changes in the agents repo, push to remote "mygithub"
#
# Push methods (agent-os target only):
#   mirror  (default) - clone agent-os repo, copy current agent-os/ files, commit, push (fast, reliable)
#   subtree           - git subtree push (slow: replays entire course repo history; not recommended)
#
# Safety: blocks .env / secrets, never force-pushes, verifies remote HEAD changed after push.

param(
  [Parameter(Mandatory = $false)]
  [Alias('m')]
  [string]$Message,

  [ValidateSet('agent-os', 'agents')]
  [string]$Target = 'agent-os',

  [ValidateSet('mirror', 'subtree')]
  [string]$Method = 'mirror',

  [string]$Branch = 'main',

  [switch]$DryRun,

  [switch]$SkipPush,

  [switch]$PushOnly,

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
  param(
    [string]$WorkDir = $AgentsRoot,
    [string[]]$GitArgs
  )
  Push-Location $WorkDir
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

function Get-RemoteHead {
  param([string]$Remote, [string]$Ref = 'HEAD')
  $line = Invoke-Git -GitArgs @('ls-remote', $Remote, $Ref)
  if (-not $line) { return $null }
  return ($line[0] -split '\s+')[0]
}

function Test-SecretPaths {
  param([string[]]$Paths)
  $blocked = @()
  foreach ($p in $Paths) {
    $norm = ($p -replace '\\', '/').ToLowerInvariant()
    $name = [System.IO.Path]::GetFileName($norm).ToLowerInvariant()

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

function Push-AgentOsMirror {
  param(
    [string]$RemoteName,
    [string]$RemoteUrl,
    [string]$CommitMessage
  )

  if ($Method -eq 'subtree') {
    Write-Warn 'Subtree push replays the full agents course history (often 2000+ commits) and can take a long time.'
    Write-Warn 'Prefer -Method mirror (default) for fast pushes to github.com/balaji-ranga/agent-os'
    $before = Get-RemoteHead -Remote $RemoteName -Ref "refs/heads/$Branch"
    Invoke-Git -GitArgs @('subtree', 'push', '--prefix=agent-os', $RemoteName, $Branch) | Out-Null
    $after = Get-RemoteHead -Remote $RemoteName -Ref "refs/heads/$Branch"
    if (-not $after -or ($before -and $before -eq $after)) {
      throw "Subtree push did not update remote $RemoteName/$Branch. Remote still at $after"
    }
    Write-Ok "Verified remote updated: $before -> $after"
    return
  }

  $tempRepo = Join-Path $env:TEMP "agent-os-mirror-push"
  if (Test-Path $tempRepo) {
    Remove-Item $tempRepo -Recurse -Force
  }

  Write-Step "Mirror push: clone $RemoteUrl"
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if (Test-Path $tempRepo) { Remove-Item $tempRepo -Recurse -Force }
    & git clone --branch $Branch --single-branch --depth 1 $RemoteUrl $tempRepo *> $null
    if ($LASTEXITCODE -ne 0) {
      & git clone $RemoteUrl $tempRepo *> $null
      if ($LASTEXITCODE -ne 0) {
        throw 'Failed to clone agent-os remote. Run: gh auth login (or configure SSH).'
      }
    }
  } finally {
    $ErrorActionPreference = $savedEap
  }

  Get-ChildItem $tempRepo -Force |
    Where-Object { $_.Name -ne '.git' } |
    Remove-Item -Recurse -Force

  Write-Step 'Mirror push: copy agent-os files'
  $robocopyArgs = @(
    $AgentOsRoot, $tempRepo,
    '/MIR',
    '/XD', 'node_modules', '.git', 'backend\data', 'frontend\dist', 'backend\dist', '.vite',
    '/XF', '.env', '.env.local',
    '/NFL', '/NDL', '/NJH', '/NJS'
  )
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
  }

  Push-Location $tempRepo
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    git add -A *> $null
    $porcelain = git status --porcelain
    if (-not $porcelain) {
      Write-Warn 'No file changes to push to agent-os repo (remote may already match).'
      return
    }

    Write-Step 'Mirror push: commit in agent-os repo'
    git diff --cached --stat
    Write-Host ''
    git commit -m $CommitMessage
    if ($LASTEXITCODE -ne 0) { throw 'Commit failed in mirror repo.' }
    $before = Get-RemoteHead -Remote $RemoteName -Ref "refs/heads/$Branch"
    git push origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'git push failed. Check GitHub auth.' }
  } finally {
    $ErrorActionPreference = $savedEap
    Pop-Location
    Remove-Item $tempRepo -Recurse -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 2
  $after = Get-RemoteHead -Remote $RemoteName -Ref "refs/heads/$Branch"
  if (-not $after -or ($before -and $before -eq $after)) {
    throw "Mirror push did not update remote $RemoteName/$Branch (before=$before after=$after)"
  }
  Write-Ok "Verified remote updated: $before -> $after"
}

Write-Step 'Agent OS - commit and push'
Write-Host "  Repo root : $AgentsRoot"
Write-Host "  Target    : $Target"
Write-Host "  Method    : $Method"
Write-Host "  Branch    : $Branch"
Write-Host ''

$remotes = Invoke-Git -GitArgs @('remote', '-v')
if (-not $remotes) {
  throw 'No git remotes configured.'
}

$remoteName = if ($Target -eq 'agent-os') { 'agent-os' } else { 'mygithub' }
$remoteLine = ($remotes | Where-Object { $_ -match "^$remoteName\s" } | Select-Object -First 1)
if (-not $remoteLine) {
  throw "Remote '$remoteName' not found. Run: git remote -v"
}
$remoteUrl = (Invoke-Git -GitArgs @('remote', 'get-url', $remoteName)).Trim()
Write-Host "  Remote    : $remoteLine"

if ($remoteLine -match 'ed-donner/agents' -and -not $AllowOrigin) {
  throw 'Refusing to push to upstream course repo. Use -Target agents (mygithub) or -Target agent-os.'
}

if (-not $Message) {
  if ($PushOnly) {
    $Message = (Invoke-Git -GitArgs @('log', '-1', '--pretty=%s')).Trim()
    if (-not $Message) { throw 'No commit message and no prior commit found.' }
    Write-Host "  Message     : $Message (from last commit)"
  } else {
    $Message = Read-Host 'Commit message'
  }
}
if ([string]::IsNullOrWhiteSpace($Message)) {
  throw 'Commit message is required.'
}

Push-Location $AgentsRoot
try {
  if (-not $PushOnly) {
    Write-Step 'Git status'
    git status --short
    Write-Host ''

    $stagePath = if ($Target -eq 'agent-os') { 'agent-os' } else { '.' }

    if ($DryRun) {
      Write-Warn "[DryRun] Would stage: git add -- $stagePath"
    } else {
      git add -- $stagePath
      $staged = git diff --cached --name-only
      if (-not $staged) {
        Write-Warn 'Nothing to commit (working tree clean for selected scope).'
        if ($SkipPush) { exit 0 }
      } else {
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
        Write-Ok "Committed in agents repo: $Message"
      }
    }
  } else {
    Write-Warn 'PushOnly - skipping commit step (using existing local commit).'
  }

  if ($SkipPush) {
    Write-Warn 'SkipPush set - commit only, no push.'
    exit 0
  }

  if ($DryRun) {
    if ($Target -eq 'agent-os') {
      Write-Warn "[DryRun] Would mirror-push agent-os/ to $remoteUrl ($Branch)"
    } else {
      Write-Warn "[DryRun] Would run: git push -u $remoteName $Branch"
    }
    exit 0
  }

  Write-Step 'Pushing to GitHub...'
  if ($Target -eq 'agent-os') {
    Push-AgentOsMirror -RemoteName $remoteName -RemoteUrl $remoteUrl -CommitMessage $Message
    Write-Ok "agent-os repo: https://github.com/balaji-ranga/agent-os"
  } else {
    $before = Get-RemoteHead -Remote $remoteName -Ref "refs/heads/$Branch"
    git push -u $remoteName $Branch
    $after = Get-RemoteHead -Remote $remoteName -Ref "refs/heads/$Branch"
    if (-not $after -or ($before -and $before -eq $after)) {
      throw "Push did not update remote $remoteName/$Branch"
    }
    Write-Ok "Verified remote updated: $before -> $after"
    Write-Ok "agents repo: https://github.com/balaji-ranga/agents"
  }
} finally {
  Pop-Location
}
