Param(
  [string]$FlyApp = "zenith-license",
  [string]$FlyConfig = "fly.toml",
  [switch]$Quick,
  [switch]$SkipRemoteFly,
  [switch]$StrictFly
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$failures = New-Object System.Collections.Generic.List[string]

function Step {
  Param(
    [string]$Name,
    [string]$Command,
    [string]$Workdir = ""
  )
  Write-Host ""
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  $old = Get-Location
  try {
    if ($Workdir) { Set-Location $Workdir }
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    Write-Host "[PASS] $Name" -ForegroundColor Green
  } catch {
    Write-Host "[FAIL] $Name -> $($_.Exception.Message)" -ForegroundColor Red
    $failures.Add($Name) | Out-Null
  } finally {
    Set-Location $old
  }
}

Write-Host "Client prelaunch validator running from: $root" -ForegroundColor Yellow
if ($Quick) {
  Write-Host "Mode: QUICK (skips heavy build checks)" -ForegroundColor Yellow
}

Step -Name "API py_compile" -Command "python -m py_compile API/api.py" -Workdir $root
Step -Name "Backend py_compile" -Command "python -m py_compile backend/app.py backend/config.py backend/auth/routes.py backend/bot/routes.py backend/web/routes.py" -Workdir $root
Step -Name "Discord bot syntax" -Command "node --check discord-bot/src/index.js" -Workdir $root
Step -Name "Electron syntax" -Command "node --check electron/license.js" -Workdir $root
Step -Name "Dev launcher syntax" -Command "node --check scripts/start.js" -Workdir $root

if (-not $Quick) {
  Step -Name "Website production build" -Command "npm run build" -Workdir (Join-Path $root "website")
  Step -Name "Tauri cargo check" -Command "cargo check" -Workdir (Join-Path $root "src-tauri")
}

$flyCmd = "powershell -ExecutionPolicy Bypass -File scripts/fly_preflight.ps1 -App `"$FlyApp`" -Config `"$FlyConfig`""
if ($SkipRemoteFly) {
  $flyCmd += " -SkipRemote"
}
if ($StrictFly) {
  $flyCmd += " -Strict"
}
Step -Name "Fly preflight" -Command $flyCmd -Workdir $root

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "[READY] All prelaunch checks passed." -ForegroundColor Green
  exit 0
}

Write-Host "[BLOCKED] Prelaunch failed checks:" -ForegroundColor Red
foreach ($f in $failures) {
  Write-Host " - $f" -ForegroundColor Red
}
exit 1
