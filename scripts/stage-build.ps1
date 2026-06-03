param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('blue', 'green')]
  [string]$Color,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
  [string]$BuildId
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$activeRoot = Join-Path $repoRoot 'active'
$buildsRoot = Join-Path $repoRoot 'builds'

function Assert-ChildPath([string]$Path, [string]$Root) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing path outside intended root: $fullPath"
  }
  return $fullPath
}

function Remove-ChildTree([string]$Path, [string]$Root) {
  $safePath = Assert-ChildPath $Path $Root
  if (Test-Path -LiteralPath $safePath) {
    Remove-Item -LiteralPath $safePath -Recurse -Force
  }
}

function Invoke-DockerCompose([string[]]$Arguments) {
  Push-Location $repoRoot
  try {
    & docker compose @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "docker compose $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$versionFile = Join-Path $activeRoot 'active_version.json'
if (Test-Path -LiteralPath $versionFile) {
  $version = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
  if ($version.active -eq $Color) {
    throw "Refusing to replace currently active slot $Color"
  }
}

$buildPath = Assert-ChildPath (Join-Path $buildsRoot $BuildId) $buildsRoot
$slotPath = Assert-ChildPath (Join-Path $activeRoot $Color) $activeRoot
$nextPath = Assert-ChildPath (Join-Path $activeRoot "$Color.next") $activeRoot
$previousPath = Assert-ChildPath (Join-Path $activeRoot "$Color.previous") $activeRoot
if (-not (Test-Path -LiteralPath $buildPath -PathType Container)) {
  throw "Target build does not exist: $buildPath"
}
$metadata = Get-Content -LiteralPath (Join-Path $buildPath 'metadata.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $buildPath 'manifest.json') -Raw | ConvertFrom-Json
if ($metadata.status -ne 'validated' -or $manifest.validation_status -ne 'validated') {
  throw "Target build has not passed validation: $BuildId"
}

Invoke-DockerCompose @('stop', "valhalla-$Color")
Remove-ChildTree $nextPath $activeRoot
Remove-ChildTree $previousPath $activeRoot
Copy-Item -LiteralPath $buildPath -Destination $nextPath -Recurse
if (Test-Path -LiteralPath $slotPath) {
  Move-Item -LiteralPath $slotPath -Destination $previousPath
}
Move-Item -LiteralPath $nextPath -Destination $slotPath
Remove-ChildTree $previousPath $activeRoot
Invoke-DockerCompose @('up', '-d', '--force-recreate', "valhalla-$Color")
Invoke-DockerCompose @('exec', '-T', "valhalla-$Color", '/bin/sh', '/opt/tavrix/scripts/valhalla-container-health.sh')
Write-Host "Staged and verified $BuildId in inactive slot $Color."
