param(
  [ValidateSet('auto', 'blue', 'green')]
  [string]$Color = 'auto',
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
  [string]$BuildId
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$activeRoot = Join-Path $repoRoot 'active'
$buildsRoot = Join-Path $repoRoot 'builds'
$versionFile = Join-Path $activeRoot 'active_version.json'

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

function Invoke-DockerComposeCapture([string[]]$Arguments) {
  Push-Location $repoRoot
  try {
    $output = & docker compose @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "docker compose $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
    return @($output)
  } finally {
    Pop-Location
  }
}

function Get-ReplicaCount([string]$VariableName, [int]$DefaultValue) {
  $rawValue = [Environment]::GetEnvironmentVariable($VariableName)
  if ([string]::IsNullOrWhiteSpace($rawValue)) {
    return $DefaultValue
  }
  $parsedValue = 0
  if (-not [int]::TryParse($rawValue, [ref]$parsedValue) -or $parsedValue -lt 1) {
    throw "$VariableName must be a positive integer."
  }
  return $parsedValue
}

function Wait-ServiceHealthy([string]$Service, [int]$ExpectedReplicas) {
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $ids = @(Invoke-DockerComposeCapture @('ps', '-q', $Service) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($ids.Count -ge $ExpectedReplicas) {
      $allHealthy = $true
      foreach ($id in $ids) {
        $status = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id).Trim()
        if ($LASTEXITCODE -ne 0 -or $status -ne 'healthy') {
          $allHealthy = $false
          break
        }
      }
      if ($allHealthy) {
        return
      }
    }
    Start-Sleep -Seconds 3
  }
  throw "Service $Service did not reach $ExpectedReplicas healthy replica(s)."
}

$activeReplicas = Get-ReplicaCount 'VALHALLA_ACTIVE_REPLICAS' 3
$standbyReplicas = Get-ReplicaCount 'VALHALLA_STANDBY_REPLICAS' 1

$currentColor = 'blue'
if (Test-Path -LiteralPath $versionFile) {
  $currentVersion = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
  if ($currentVersion.active -in @('blue', 'green')) {
    $currentColor = $currentVersion.active
  }
}

$inactiveColor = if ($currentColor -eq 'green') { 'blue' } else { 'green' }
if ($Color -eq 'auto') {
  $Color = $inactiveColor
}
if ($Color -eq $currentColor) {
  throw "Refusing to replace currently active slot $Color"
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

$slotAlreadyStaged = $false
$slotManifestPath = Join-Path $slotPath 'manifest.json'
if (Test-Path -LiteralPath $slotManifestPath) {
  $slotManifest = Get-Content -LiteralPath $slotManifestPath -Raw | ConvertFrom-Json
  $slotAlreadyStaged = $slotManifest.build_id -eq $BuildId -and $slotManifest.validation_status -eq 'validated'
}

if (-not $slotAlreadyStaged) {
  Invoke-DockerCompose @('stop', "valhalla-$Color")
  Remove-ChildTree $nextPath $activeRoot
  Copy-Item -LiteralPath $buildPath -Destination $nextPath -Recurse
  Remove-ChildTree $previousPath $activeRoot
  if (Test-Path -LiteralPath $slotPath) {
    Move-Item -LiteralPath $slotPath -Destination $previousPath
  }
  Move-Item -LiteralPath $nextPath -Destination $slotPath
  Remove-ChildTree $previousPath $activeRoot
}

Invoke-DockerCompose @('up', '-d', '--force-recreate', "valhalla-$Color")
$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  try {
    Invoke-DockerCompose @('exec', '-T', "valhalla-$Color", '/bin/sh', '/opt/tavrix/scripts/valhalla-container-health.sh')
    $healthy = $true
    break
  } catch {
    Start-Sleep -Seconds 3
  }
}
if (-not $healthy) {
  throw "Candidate service valhalla-$Color did not pass its graph probe"
}

Invoke-DockerCompose @('up', '-d', '--scale', "valhalla-$Color=$activeReplicas", "valhalla-$Color")
Wait-ServiceHealthy "valhalla-$Color" $activeReplicas
Invoke-DockerCompose @('exec', '-T', "valhalla-$Color", '/bin/sh', '/opt/tavrix/scripts/valhalla-container-health.sh')

$activeVersion = [ordered]@{
  active = $Color
  previous = $currentColor
  build_id = $BuildId
  created_at = $manifest.build_timestamp
  config_sha256 = $manifest.config_sha256
  active_replicas = $activeReplicas
  standby_replicas = $standbyReplicas
  activated_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$nextVersionFile = "$versionFile.next"
[IO.File]::WriteAllText($nextVersionFile, (($activeVersion | ConvertTo-Json) + "`n"), (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $nextVersionFile -Destination $versionFile -Force
[IO.File]::WriteAllText((Join-Path $activeRoot '.active_build_id'), "$BuildId`n", (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $activeRoot '.last_validated_build_id'), "$BuildId`n", (New-Object Text.UTF8Encoding($false)))
Invoke-DockerCompose @('up', '-d', '--scale', "valhalla-$currentColor=$standbyReplicas", "valhalla-$currentColor")
Wait-ServiceHealthy "valhalla-$currentColor" $standbyReplicas
Write-Host "Activated $Color with $BuildId using $activeReplicas active replica(s); previous slot $currentColor remains available with $standbyReplicas standby replica(s)."
