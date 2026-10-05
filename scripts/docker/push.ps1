<#
.SYNOPSIS
  Builds and pushes the Docker image to a registry (GitHub Packages by default).

.DESCRIPTION
  Logs in to GHCR, builds, pushes, and lists the resulting digest. Provide a
  classic PAT with `write:packages` scope via -Token, or rely on an existing
  `docker login ghcr.io` session.

.EXAMPLE
  ./scripts/docker/push.ps1 -Tag v1.2.3
  $env:GHCR_TOKEN = 'ghp_...'; ./scripts/docker/push.ps1 -Tag v1.0.0
#>
[CmdletBinding()]
param(
  [string]$Registry = 'ghcr.io',

  [string]$Image,

  [string]$Tag,

  [string[]]$Platform,

  # Personal access token with write:packages. Falls back to $env:GHCR_TOKEN.
  [string]$Token,

  # GitHub username. Falls back to $env:GHCR_USERNAME, then the git remote owner.
  [string]$Username,

  # Push every tag in the multi-platform manifest list.
  [string[]]$AliasTag
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

function Invoke-Checked {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    # Route stderr into stdout so build progress is shown as normal output
    # instead of red error records.
    [switch]$MergeError,
    # Written to the process stdin. Used by `docker login --password-stdin`.
    [string]$Stdin
  )

  # Docker and git write progress to stderr. Under ErrorActionPreference='Stop'
  # PowerShell 5.1 turns that into a terminating NativeCommandError, so relax
  # the preference for the call and judge success by the exit code instead.
  $exitCode = 0
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($PSBoundParameters.ContainsKey('Stdin')) {
      # Write through the real stdin so the value never appears in the process
      # table or in shell history.
      $Stdin | & $Executable @Arguments
    } elseif ($MergeError) {
      & $Executable @Arguments 2>&1 | Out-Host
    } else {
      & $Executable @Arguments
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }

  if ($exitCode -ne 0) {
    throw "$Executable $($Arguments -join ' ') failed with exit code $exitCode"
  }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'git is required but was not found on PATH.'
}

$remoteUrl = Invoke-Checked git @('remote', 'get-url', 'origin') | Select-Object -First 1
if (-not $remoteUrl) {
  throw 'No `origin` remote found. Add one, or pass -Image explicitly.'
}

$repoPath = ($remoteUrl -replace '\.git$', '') -replace '^(https?://|git@|ssh://git@)', ''
$repoPath = $repoPath -replace '^github\.com[:/]', ''
$parts = $repoPath -split '/'

if (-not $Image) {
  if ($parts.Count -lt 2) {
    throw "Could not derive owner/repo from remote '$remoteUrl'. Pass -Image explicitly."
  }
  $Image = ($parts[0..1] -join '/').ToLowerInvariant()
}

if (-not $Username) {
  if ($env:GHCR_USERNAME) {
    $Username = $env:GHCR_USERNAME
  } elseif ($parts.Count -ge 1 -and $parts[0]) {
    $Username = $parts[0]
  }
}

if (-not $Tag) {
  $branch = Invoke-Checked git @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1
  if ($branch -eq 'HEAD') {
    $Tag = 'sha-' + (Invoke-Checked git @('rev-parse', '--short', 'HEAD') | Select-Object -First 1)
  } else {
    $Tag = $branch
  }
  $Tag = ($Tag -replace '[^A-Za-z0-9._-]', '-').ToLowerInvariant()
}

$imageRef = "$Registry/$Image"

if (-not $Platform) {
  $Platform = @('linux/amd64', 'linux/arm64')
}

# --- Login -----------------------------------------------------------------
$token = if ($Token) { $Token } else { $env:GHCR_TOKEN }

if ($token) {
  if (-not $Username) {
    throw 'A username is required to log in. Pass -Username or set $env:GHCR_USERNAME.'
  }

  Write-Host "Logging in to $Registry as $Username" -ForegroundColor Cyan
  # --password-stdin keeps the token out of the process table and shell history.
  Invoke-Checked docker @('login', $Registry, '--username', $Username, '--password-stdin') -Stdin $token
} else {
  Write-Host 'No GHCR_TOKEN found; using the existing docker login session.' -ForegroundColor Yellow
}

# --- Build and push --------------------------------------------------------
$buildArgs = @(
  'buildx', 'build',
  '--platform', ($Platform -join ','),
  '-t', "$imageRef`:$Tag",
  '--push'
)

# The GitHub Actions cache backend needs runtime tokens that only exist inside a
# workflow run. Fall back to a local cache elsewhere so the script also works
# from a developer machine.
if ($env:ACTIONS_CACHE_URL -and $env:ACTIONS_RUNTIME_TOKEN) {
  $buildArgs += @('--cache-from', 'type=gha,scope=$Tag', '--cache-to', 'type=gha,mode=max,scope=$Tag')
} else {
  $buildArgs += @(
    '--cache-from', 'type=local,src=.docker-cache',
    '--cache-to',   "type=local,dest=.docker-cache-new,mode=max"
  )
}

if ($AliasTag) {
  foreach ($alias in $AliasTag) {
    $clean = ($alias -replace '[^A-Za-z0-9._-]', '-').ToLowerInvariant()
    $buildArgs += @('-t', "$imageRef`:$clean")
  }
}

$buildArgs += '.'

Write-Host "Pushing $imageRef`:$Tag ($($Platform -join ', '))" -ForegroundColor Cyan
Invoke-Checked docker $buildArgs -MergeError

# --- Rotate the local build cache ------------------------------------------
# local cache exports to a new directory so a failed build cannot leave a
# half-written cache behind.
if (-not ($env:ACTIONS_CACHE_URL -and $env:ACTIONS_RUNTIME_TOKEN)) {
  $staleCache = Join-Path (Get-Location) '.docker-cache'
  $freshCache = Join-Path (Get-Location) '.docker-cache-new'
  if (Test-Path -LiteralPath $staleCache) {
    Remove-Item -LiteralPath $staleCache -Recurse -Force
  }
  if (Test-Path -LiteralPath $freshCache) {
    Move-Item -LiteralPath $freshCache -Destination $staleCache -Force
  }
}

# --- Report ----------------------------------------------------------------
$digest = (Invoke-Checked docker @('buildx', 'imagetools', 'inspect', "$imageRef`:$Tag", '--format', '{{.Manifest.Digest}}') | Select-Object -First 1)

Write-Host ''
Write-Host "Pushed: $imageRef`:$Tag" -ForegroundColor Green
if ($digest) {
  Write-Host "Digest: $digest" -ForegroundColor DarkGray
}
Write-Host "Pull with: docker pull $imageRef`:$Tag" -ForegroundColor DarkGray