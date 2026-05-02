<#
.SYNOPSIS
  Full automated release for Zenith Macros.
  Bumps version, builds Tauri app with signing, creates GitHub release,
  deploys backend + website + Discord bot to Fly.io, updates auto-updater secrets.

.USAGE
  .\scripts\release.ps1 -Version "1.2.4" [-Notes "Bug fixes and improvements"] [-SkipBuild] [-SkipDeploy]

.PREREQUISITES
  1. Run .\scripts\generate-key.ps1 once to create signing keys
  2. gh CLI authenticated (`gh auth login`)
  3. flyctl authenticated (`flyctl auth login`)
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [string]$Notes = "Bug fixes and improvements",

    [switch]$SkipBuild,
    [switch]$SkipDeploy
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path "$Root\src-tauri\tauri.conf.json")) {
    $Root = Split-Path -Parent $PSScriptRoot
}
Set-Location $Root

$KeyPath = "$HOME\.tauri\zenith.key"

# ── Resolve tool paths (handles missing PATHEXT in some shells) ───
function Find-Tool([string]$Name, [string[]]$Hints) {
    # 1. Try Get-Command with and without .exe
    foreach ($n in @($Name, "$Name.exe")) {
        $cmd = Get-Command $n -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    # 2. Try well-known hint paths
    foreach ($h in $Hints) {
        if (Test-Path $h) { return $h }
    }
    return $null
}

$GH      = Find-Tool "gh"      @("C:\Program Files\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")
$FLYCTL  = Find-Tool "flyctl"  @("$env:USERPROFILE\.fly\bin\flyctl.exe", "C:\Users\harri\.fly\bin\flyctl.exe")
$NPX     = Find-Tool "npx"     @()

# ── Preflight checks ─────────────────────────────────────────────
Write-Host "`n=== Zenith Full Release v$Version ===" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipBuild -and -not (Test-Path $KeyPath)) {
    Write-Host "ERROR: Signing key not found at $KeyPath" -ForegroundColor Red
    Write-Host "Run: .\scripts\generate-key.ps1" -ForegroundColor Yellow
    exit 1
}

foreach ($entry in @(@{Name="gh";Exe=$GH}, @{Name="flyctl";Exe=$FLYCTL}, @{Name="npx";Exe=$NPX})) {
    if (-not $entry.Exe) {
        Write-Host "ERROR: $($entry.Name) not found" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Found $($entry.Name): $($entry.Exe)" -ForegroundColor DarkGray
}

# Helper: run an external tool, print its output, return exit code
function Invoke-Tool {
    param([string]$Exe, [string[]]$ToolArgs, [string]$WorkDir = "")
    $tmpO = [System.IO.Path]::GetTempFileName()
    $tmpE = [System.IO.Path]::GetTempFileName()

    $spArgs = @{
        Wait                   = $true
        NoNewWindow            = $true
        RedirectStandardOutput = $tmpO
        RedirectStandardError  = $tmpE
        PassThru               = $true
    }
    # npx ships as a .ps1 script — wrap it in a powershell process.
    # Quote the script path in case it contains spaces (e.g. C:\Program Files\...).
    if ($Exe -like '*.ps1') {
        $spArgs['FilePath']     = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        # Build a single string so the quoted script path survives process launch
        $quotedExe = "`"$Exe`""
        $extraArgs = $ToolArgs -join ' '
        $spArgs['ArgumentList'] = "-NonInteractive -ExecutionPolicy Bypass -File $quotedExe $extraArgs"
    } else {
        $spArgs['FilePath']     = $Exe
        $spArgs['ArgumentList'] = $ToolArgs
    }
    if ($WorkDir -ne "") { $spArgs['WorkingDirectory'] = $WorkDir }

    $proc = Start-Process @spArgs
    Get-Content $tmpO -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    Get-Content $tmpE -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    Remove-Item $tmpO, $tmpE -ErrorAction SilentlyContinue
    return [int]$proc.ExitCode
}

$TotalSteps = 8
if ($SkipBuild) { $TotalSteps = 5 }
if ($SkipDeploy) { $TotalSteps -= 3 }
$Step = 0

# ── Step: Bump version ───────────────────────────────────────────
$Step++
Write-Host "[$Step/$TotalSteps] Bumping version to $Version..." -ForegroundColor Yellow

# tauri.conf.json
$tauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw
$tauriConf = $tauriConf -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
Set-Content "src-tauri\tauri.conf.json" $tauriConf -NoNewline

# Cargo.toml — only the package version line (first occurrence)
$cargoLines = Get-Content "src-tauri\Cargo.toml"
$replaced = $false
$cargoLines = $cargoLines | ForEach-Object {
    if (-not $replaced -and $_ -match '^version\s*=') {
        $replaced = $true
        "version = `"$Version`""
    } else { $_ }
}
Set-Content "src-tauri\Cargo.toml" $cargoLines

# tauri-bridge.js
$bridge = Get-Content "renderer\tauri-bridge.js" -Raw
$bridge = $bridge -replace "version:\s*'[^']*'", "version: '$Version'"
$bridge = $bridge -replace "getAppVersion:\s*\(\)\s*=>\s*command\('app_version',\s*\{\},\s*'[^']*'\)", "getAppVersion: () => command('app_version', {}, '$Version')"
Set-Content "renderer\tauri-bridge.js" $bridge -NoNewline

# backend/app.py — update _GH_RELEASE version tag so standalone download_refs seed correctly
$appPy = [System.IO.File]::ReadAllText("$Root\backend\app.py", [System.Text.Encoding]::UTF8)
$appPy = $appPy -replace '/releases/download/v[0-9]+\.[0-9]+\.[0-9]+', "/releases/download/v$Version"
[System.IO.File]::WriteAllText("$Root\backend\app.py", $appPy, [System.Text.Encoding]::UTF8)

Write-Host "  Done — tauri.conf.json, Cargo.toml, tauri-bridge.js, backend/app.py" -ForegroundColor Green

# ── Step: Deploy Backend ─────────────────────────────────────────
if (-not $SkipDeploy) {
    $Step++
    Write-Host "`n[$Step/$TotalSteps] Deploying backend (zenith-license)..." -ForegroundColor Yellow
    $rc = Invoke-Tool $FLYCTL @("deploy","--app","zenith-license","--config","backend\fly.toml","--dockerfile","backend\Dockerfile")
    if ($rc -ne 0) {
        Write-Host "  WARNING: Backend deploy may have failed" -ForegroundColor Yellow
    } else {
        Write-Host "  Backend deployed" -ForegroundColor Green
    }

    # ── Step: Deploy Website ─────────────────────────────────────────
    $Step++
    Write-Host "`n[$Step/$TotalSteps] Deploying website (zenith-macros-web)..." -ForegroundColor Yellow
    $rc = Invoke-Tool $FLYCTL @("deploy","--app","zenith-macros-web")
    if ($rc -ne 0) {
        Write-Host "  WARNING: Website deploy may have failed" -ForegroundColor Yellow
    } else {
        Write-Host "  Website deployed" -ForegroundColor Green
    }

    # ── Step: Deploy Discord Bot ─────────────────────────────────────
    $Step++
    Write-Host "`n[$Step/$TotalSteps] Deploying Discord bot (zenith-discord-bot)..." -ForegroundColor Yellow
    $rc = Invoke-Tool $FLYCTL @("deploy","--app","zenith-discord-bot") -WorkDir (Join-Path $Root "discord-bot")
    if ($rc -ne 0) {
        Write-Host "  WARNING: Bot deploy may have failed" -ForegroundColor Yellow
    } else {
        Write-Host "  Discord bot deployed" -ForegroundColor Green
    }
}

# ── Step: Build Tauri app ────────────────────────────────────────
if (-not $SkipBuild) {
    $Step++
    Write-Host "`n[$Step/$TotalSteps] Building Tauri app (this takes a few minutes)..." -ForegroundColor Yellow

    $PrivKey = Get-Content $KeyPath -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY = $PrivKey.Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

    $buildExit = Invoke-Tool $NPX @("tauri", "build")
    if ($buildExit -ne 0) {
        Write-Host "ERROR: Build failed (exit $buildExit)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Build complete" -ForegroundColor Green

    # ── Step: Find artifacts ─────────────────────────────────────────
    $Step++
    Write-Host "`n[$Step/$TotalSteps] Locating build artifacts..." -ForegroundColor Yellow

    $BundleDir = "src-tauri\target\release\bundle"
    $NsisExe = Get-ChildItem "$BundleDir\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    $NsisZip = Get-ChildItem "$BundleDir\nsis\*.nsis.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    $NsisSig = Get-ChildItem "$BundleDir\nsis\*.nsis.zip.sig" -ErrorAction SilentlyContinue | Select-Object -First 1
    $MsiExe = Get-ChildItem "$BundleDir\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
    $MsiZip = Get-ChildItem "$BundleDir\msi\*.msi.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    $MsiSig = Get-ChildItem "$BundleDir\msi\*.msi.zip.sig" -ErrorAction SilentlyContinue | Select-Object -First 1

    $InstallerExe = if ($NsisExe) { $NsisExe } else { $MsiExe }
    $UpdateZip = if ($NsisZip) { $NsisZip } else { $MsiZip }
    $UpdateSig = if ($NsisSig) { $NsisSig } else { $MsiSig }

    if (-not $UpdateZip -or -not $UpdateSig) {
        Write-Host "ERROR: Could not find update artifacts in $BundleDir" -ForegroundColor Red
        exit 1
    }

    $Signature = (Get-Content $UpdateSig.FullName -Raw).Trim()
    Write-Host "  Installer: $($InstallerExe.Name)" -ForegroundColor Green
    Write-Host "  Update zip: $($UpdateZip.Name)" -ForegroundColor Green

    # ── Step: Create GitHub Release ──────────────────────────────────
    $Step++
    Write-Host "`n[$Step/$TotalSteps] Creating GitHub release v$Version on zenith-releases..." -ForegroundColor Yellow

    $ReleaseFiles = @($UpdateZip.FullName, $UpdateSig.FullName)
    if ($InstallerExe) { $ReleaseFiles += $InstallerExe.FullName }

    $ghArgs = @("release", "create", "v$Version", "--title", "v$Version", "--notes", $Notes)
    $ghArgs += $ReleaseFiles

    $rc = Invoke-Tool $GH ($ghArgs + @("--repo","harrisonjonathan05-dev/zenith-releases"))
    if ($rc -ne 0) {
        Write-Host "  WARNING: GitHub release may have failed. Check manually." -ForegroundColor Yellow
    } else {
        Write-Host "  GitHub release created" -ForegroundColor Green
    }

    # Auto-updater is now fully dynamic — the backend reads update metadata directly
    # from the latest GitHub release (.nsis.zip + .nsis.zip.sig assets). No Fly
    # secrets need to be updated per release.
    Write-Host "`n  Auto-updater: dynamic (reads from GitHub releases automatically)" -ForegroundColor DarkGray
}

# ── Summary ──────────────────────────────────────────────────────
Write-Host "`n=== Release v$Version complete! ===" -ForegroundColor Cyan
Write-Host ""
if (-not $SkipDeploy) {
    Write-Host "  Backend (zenith-license)     — deployed" -ForegroundColor Green
    Write-Host "  Website (zenith-macros-web)   — deployed" -ForegroundColor Green
    Write-Host "  Discord bot                   — deployed" -ForegroundColor Green
}
if (-not $SkipBuild) {
    Write-Host "  GitHub release (zenith-releases) — v$Version published" -ForegroundColor Green
    Write-Host "  Auto-updater                  — dynamic (reads GitHub on each check)" -ForegroundColor Green
    Write-Host "  Standalone /download          — dynamic (always serves latest assets)" -ForegroundColor Green
    Write-Host "  Dashboard /download           — auto-updated (pulls from GitHub)" -ForegroundColor Green
    Write-Host "  Bot /download                 — auto-updated (pulls from GitHub)" -ForegroundColor Green
    Write-Host "  Existing app users            — will see update on next launch" -ForegroundColor Green
}
Write-Host ""

# ── Handy flags ──────────────────────────────────────────────────
Write-Host "Tip: Use -SkipBuild to deploy only backend/website/bot without building the app." -ForegroundColor DarkGray
Write-Host "     Use -SkipDeploy to only build the app without deploying services." -ForegroundColor DarkGray
Write-Host ""
