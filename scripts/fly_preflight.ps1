Param(
  [string]$App = "zenith-license",
  [string]$Config = "fly.toml",
  [switch]$SkipRemote,
  [switch]$Strict
)

$ErrorActionPreference = "Stop"

function Read-TomlValue {
  Param(
    [string]$Path,
    [string]$Key
  )
  $line = Select-String -Path $Path -SimpleMatch -Pattern "$Key =" | Select-Object -First 1
  if (-not $line) { return "" }
  $raw = ($line.Line -split "=", 2)[1].Trim()
  return $raw.Trim('"').Trim("'")
}

function Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Pass($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
$warnCount = 0
function WarnTrack($msg) {
  $script:warnCount++
  Warn $msg
}

if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
  throw "flyctl not found in PATH"
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = if ([System.IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $root $Config }
if (-not (Test-Path $configPath)) {
  throw "Config file not found: $configPath"
}

Info "Validating local Fly config: $configPath"
& flyctl config validate -c $configPath | Out-Host
Pass "Local Fly config syntax is valid"

$localApp = Read-TomlValue -Path $configPath -Key "app"
$localDockerfile = Read-TomlValue -Path $configPath -Key "dockerfile"
$localInternalPort = Read-TomlValue -Path $configPath -Key "internal_port"

Info "Local config summary"
Write-Host "  app=$localApp"
Write-Host "  dockerfile=$localDockerfile"
Write-Host "  internal_port=$localInternalPort"

if ($SkipRemote) {
  Warn "Remote checks skipped by -SkipRemote"
  exit 0
}

Info "Fetching remote app status: $App"
& flyctl status -a $App | Out-Host

Info "Fetching remote health checks: $App"
& flyctl checks list -a $App | Out-Host

Info "Fetching remote config: $App"
$remoteConfigRaw = & flyctl config show -a $App
$remoteConfig = $remoteConfigRaw | ConvertFrom-Json

$remoteDockerfile = ""
if ($remoteConfig.build -and $remoteConfig.build.dockerfile) { $remoteDockerfile = [string]$remoteConfig.build.dockerfile }
$remoteInternalPort = ""
if ($remoteConfig.http_service -and $remoteConfig.http_service.internal_port) { $remoteInternalPort = [string]$remoteConfig.http_service.internal_port }

if ($localDockerfile -and $remoteDockerfile -and ($localDockerfile -ne $remoteDockerfile)) {
  WarnTrack "Dockerfile drift: local=$localDockerfile remote=$remoteDockerfile"
} else {
  Pass "Dockerfile path is aligned"
}

if ($localInternalPort -and $remoteInternalPort -and ($localInternalPort -ne $remoteInternalPort)) {
  WarnTrack "Internal port drift: local=$localInternalPort remote=$remoteInternalPort"
} else {
  Pass "Internal port is aligned"
}

Info "Checking secret names present on Fly"
$secretRows = (& flyctl secrets list -a $App) | Select-Object -Skip 1
$secretNames = @()
foreach ($row in $secretRows) {
  $parts = ($row -split '\s+') | Where-Object { $_ -ne "" }
  if ($parts.Count -gt 0) { $secretNames += $parts[0] }
}

$requiredGroups = @(
  @{ Name = "secret_key"; Keys = @("ZENITH_SECRET_KEY", "DASHBOARD_SESSION_SECRET", "ADMIN_SECRET") },
  @{ Name = "bot_api_token"; Keys = @("ZENITH_BOT_API_TOKEN", "BOT_API_SECRET") },
  @{ Name = "store_api_token"; Keys = @("ZENITH_STORE_API_TOKEN", "STORE_API_TOKEN", "BOT_API_SECRET") }
)

$recommended = @(
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_CHECKOUT_LINK_MONTHLY",
  "STRIPE_CHECKOUT_LINK_LIFETIME",
  "GITHUB_RELEASE_REPO",
  "GITHUB_TOKEN"
)

$missingRequiredGroups = @()
foreach ($g in $requiredGroups) {
  $found = $false
  foreach ($k in $g.Keys) {
    if ($secretNames -contains $k) {
      $found = $true
      break
    }
  }
  if (-not $found) {
    $missingRequiredGroups += ($g.Name + " (accepted: " + ($g.Keys -join " | ") + ")")
  }
}
if ($missingRequiredGroups.Count -gt 0) {
  WarnTrack ("Missing required secret groups: " + ($missingRequiredGroups -join "; "))
} else {
  Pass "All required runtime secret groups are present"
}

$missingRecommended = @()
foreach ($k in $recommended) {
  if ($secretNames -notcontains $k) { $missingRecommended += $k }
}
if ($missingRecommended.Count -gt 0) {
  WarnTrack ("Missing recommended feature secrets: " + ($missingRecommended -join ", "))
} else {
  Pass "All recommended feature secrets are present"
}

Info "Public health probe"
try {
  $health = Invoke-RestMethod -Method Get -Uri "https://$App.fly.dev/healthz" -TimeoutSec 15
  if ($health.ok -eq $true) {
    Pass "https://$App.fly.dev/healthz reports ok=true"
  } else {
    WarnTrack "Health endpoint reached but did not return ok=true"
  }
} catch {
  WarnTrack "Health probe failed: $($_.Exception.Message)"
}

Write-Host ""
Pass "Fly preflight completed (no deployment performed)"
if ($Strict -and $warnCount -gt 0) {
  throw "Strict mode failed due to $warnCount warning(s)"
}
