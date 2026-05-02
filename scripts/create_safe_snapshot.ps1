Param(
  [string]$OutputDir = "snapshots",
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$snapshotName = "zenith-local-snapshot-$stamp"
$snapshotRoot = Join-Path $root $OutputDir
$snapshotPath = Join-Path $snapshotRoot $snapshotName

$excludeDirNames = @(
  ".git",
  ".next",
  "node_modules",
  "target",
  "dist",
  "build",
  "dist-tauri",
  ".idea",
  ".codex",
  "analysis"
)

$excludeFilePatterns = @(
  "*.env",
  "*.env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "secrets.*",
  "*.log",
  "*.tmp",
  "*.zip"
)

function Should-ExcludePath([System.IO.FileSystemInfo]$Item) {
  $name = $Item.Name
  if ($Item.PSIsContainer -and $name -like "snapshots*") {
    return $true
  }
  if ($Item.PSIsContainer -and $name -eq $OutputDir) {
    return $true
  }
  if ($Item.PSIsContainer -and $excludeDirNames -contains $name) {
    return $true
  }
  foreach ($pattern in $excludeFilePatterns) {
    if ($name -like $pattern) {
      return $true
    }
  }
  return $false
}

Write-Host "Creating safe snapshot at: $snapshotPath"
New-Item -ItemType Directory -Force -Path $snapshotPath | Out-Null

$items = Get-ChildItem -Path $root -Force
foreach ($item in $items) {
  if (Should-ExcludePath $item) { continue }

  if ($item.PSIsContainer) {
    Copy-Item -Path $item.FullName -Destination (Join-Path $snapshotPath $item.Name) -Recurse -Force -Container -Exclude $excludeFilePatterns
  } else {
    Copy-Item -Path $item.FullName -Destination (Join-Path $snapshotPath $item.Name) -Force
  }
}

$zipPath = ""
if (-not $NoZip) {
  $zipPath = "$snapshotPath.zip"
  if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
  }
  Compress-Archive -Path "$snapshotPath\*" -DestinationPath $zipPath -CompressionLevel Optimal
}

$manifest = [PSCustomObject]@{
  created_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  source_root    = $root
  snapshot_path  = $snapshotPath
  zip_path       = $zipPath
  excluded_dirs  = $excludeDirNames
  excluded_files = $excludeFilePatterns
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $snapshotPath "SNAPSHOT_MANIFEST.json") -Encoding UTF8

Write-Host "Snapshot complete:"
Write-Host " - folder: $snapshotPath"
if ($zipPath) {
  Write-Host " - zip:    $zipPath"
} else {
  Write-Host " - zip:    (skipped by -NoZip)"
}
