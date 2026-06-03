$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$activeRoot = Join-Path $repoRoot 'active'
$versionFile = Join-Path $activeRoot 'active_version.json'

if (-not (Test-Path -LiteralPath $versionFile)) {
  throw 'Active version file is missing.'
}
$version = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
if ($version.previous -notin @('blue', 'green')) {
  throw 'Previous slot is missing from active version file.'
}
$manifestPath = Join-Path $activeRoot "$($version.previous)\manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
& (Join-Path $PSScriptRoot 'activate-bluegreen.ps1') -Color $version.previous -BuildId $manifest.build_id
