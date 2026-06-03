param(
  [switch]$Observability
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$activeRoot = Join-Path $repoRoot 'active'
$versionFile = Join-Path $activeRoot 'active_version.json'

function Get-ReplicaCount([object]$Version, [string]$PropertyName, [string]$VariableName, [int]$DefaultValue) {
  $rawValue = $Version.$PropertyName
  if ($null -eq $rawValue -or [string]::IsNullOrWhiteSpace([string]$rawValue)) {
    $rawValue = [Environment]::GetEnvironmentVariable($VariableName)
  }
  if ($null -eq $rawValue -or [string]::IsNullOrWhiteSpace([string]$rawValue)) {
    return $DefaultValue
  }
  $parsedValue = 0
  if (-not [int]::TryParse([string]$rawValue, [ref]$parsedValue) -or $parsedValue -lt 1) {
    throw "$VariableName must be a positive integer."
  }
  return $parsedValue
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

function Wait-RoutingReady {
  $port = [Environment]::GetEnvironmentVariable('ROUTING_PUBLIC_PORT')
  if ([string]::IsNullOrWhiteSpace($port)) {
    $port = '8080'
  }
  $url = "http://localhost:$port/health/ready"
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url
      if ($response.StatusCode -eq 200) {
        Write-Host $response.Content
        return
      }
    } catch {
      Start-Sleep -Seconds 3
      continue
    }
    Start-Sleep -Seconds 3
  }
  throw "Routing API did not become ready at $url."
}

if (-not (Test-Path -LiteralPath $versionFile)) {
  throw 'Active version file is missing. Run activate-bluegreen before starting the runtime.'
}

$version = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
if ($version.active -notin @('blue', 'green')) {
  throw 'Active slot is missing from active version file.'
}
$previousColor = $version.previous
if ($previousColor -notin @('blue', 'green')) {
  $previousColor = if ($version.active -eq 'green') { 'blue' } else { 'green' }
}

$activeReplicas = Get-ReplicaCount $version 'active_replicas' 'VALHALLA_ACTIVE_REPLICAS' 3
$standbyReplicas = Get-ReplicaCount $version 'standby_replicas' 'VALHALLA_STANDBY_REPLICAS' 1

Invoke-DockerCompose @(
  'up', '-d',
  '--scale', "valhalla-$($version.active)=$activeReplicas",
  '--scale', "valhalla-$previousColor=$standbyReplicas",
  "valhalla-$($version.active)",
  "valhalla-$previousColor",
  'routing-api',
  'reverse-proxy'
)
Wait-ServiceHealthy "valhalla-$($version.active)" $activeReplicas
Wait-ServiceHealthy "valhalla-$previousColor" $standbyReplicas
if ($Observability) {
  Invoke-DockerCompose @('--profile', 'observability', 'up', '-d', 'prometheus', 'grafana')
}
Wait-RoutingReady
Invoke-DockerCompose @('ps')
Write-Host "Runtime is up with active valhalla-$($version.active)=$activeReplicas and standby valhalla-$previousColor=$standbyReplicas."
