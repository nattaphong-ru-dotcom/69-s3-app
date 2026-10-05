<#
.SYNOPSIS
  Builds the Docker image for this Strapi app and tags it for a registry.

.DESCRIPTION
  Derives the image name from the git remote so the tag always matches the
  GitHub repository. Supports a plain local build, a single-platform build, and
  a multi-platform build for CI hosts that can run QEMU.

.EXAMPLE
  ./scripts/docker/build.ps1
  ./scripts/docker/build.ps1 -Tag v1.2.3
  ./scripts/docker/build.ps1 -Platform linux/amd64,linux/arm64 -Push
#>
[CmdletBinding()]
param(
  # Registry host. Defaults to GitHub Container Registry.
  [string]$Registry = 'ghcr.io',

  # Image path. Defaults to the lowercase owner/repo from `git remote`.
  [string]$Image,

  # Tag to apply. Defaults to the current git branch, sanitised for tags.
  [string]$Tag,

  [string[]]$Platform,

  # Push the image after a successful build.
  [switch]$Push,

  # Build for the local machine only. Faster, and enough for local testing.
  [switch]$Load
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

function Invoke-Checked {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    # Route stderr into stdout so build progress is shown as normal output
    # instead of red error records.
    [switch]$MergeError
  )

  # Docker and git write progress to stderr. Under ErrorActionPreference='Stop'
  # PowerShell 5.1 turns that into a terminating NativeCommandError, so relax
  # the preference for the call and judge success by the exit code instead.
  $exitCode = 0
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($MergeError) {
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

# Supports both https://github.com/owner/repo.git and git@github.com:owner/repo.git
$repoPath = ($remoteUrl -replace '\.git$', '') -replace '^(https?://|git@|ssh://git@)', ''
$repoPath = $repoPath -replace '^github\.com[:/]', ''

if (-not $Image) {
  if ($repoPath -notmatch '^[^/]+/[^/]+$') {
    throw "Could not derive owner/repo from remote '$remoteUrl'. Pass -Image explicitly."
  }
  # Registry paths must be lowercase.
  $Image = $repoPath.ToLowerInvariant()
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
$buildArgs = @('build', '-t', "$imageRef`:$Tag")

if ($Platform) {
  $buildArgs += @('--platform', ($Platform -join ','))
} elseif (-not $Load) {
  # Default to the host architecture. Cross-building without QEMU is unreliable.
  $buildArgs += @('--platform', 'linux/amd64')
}

if ($Load) {
  $buildArgs += '--load'
}

if ($Push) {
  $buildArgs += '--push'
}

$buildArgs += '.'

Write-Host "Building $imageRef`:$Tag" -ForegroundColor Cyan
Write-Host "Context: $((Get-Location).Path)" -ForegroundColor DarkGray
Invoke-Checked docker $buildArgs -MergeError

Write-Host "Done: $imageRef`:$Tag" -ForegroundColor Green