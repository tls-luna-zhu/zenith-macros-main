<#
.SYNOPSIS
  Generate Tauri signing keypair for auto-updater.
  Run this once, then put the public key in tauri.conf.json.
#>

$KeyPath = "$HOME\.tauri\zenith.key"

if (Test-Path $KeyPath) {
    Write-Host "Key already exists at $KeyPath" -ForegroundColor Yellow
    $pubkey = Get-Content "$KeyPath.pub" -Raw -ErrorAction SilentlyContinue
    if ($pubkey) {
        Write-Host "`nPublic key:`n$pubkey" -ForegroundColor Cyan
    }
    exit 0
}

Write-Host "Generating Tauri signing keypair..." -ForegroundColor Cyan
Write-Host "When prompted for a password, just press Enter twice (empty password for automation).`n" -ForegroundColor Yellow

npx tauri signer generate -w $KeyPath

if (Test-Path "$KeyPath.pub") {
    $pubkey = (Get-Content "$KeyPath.pub" -Raw).Trim()
    Write-Host "`n=== KEY GENERATED ===" -ForegroundColor Green
    Write-Host "Private key: $KeyPath" -ForegroundColor Green
    Write-Host "Public key:  $KeyPath.pub" -ForegroundColor Green

    # Auto-update tauri.conf.json with the public key
    $confPath = Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json"
    if (Test-Path $confPath) {
        $conf = Get-Content $confPath -Raw
        $conf = $conf -replace '"pubkey":\s*""', "`"pubkey`": `"$pubkey`""
        Set-Content $confPath $conf -NoNewline
        Write-Host "`nPublic key auto-inserted into tauri.conf.json" -ForegroundColor Green
    }

    Write-Host "`nYou're all set! Use .\scripts\release.ps1 -Version X.Y.Z to release.`n" -ForegroundColor Cyan
} else {
    Write-Host "ERROR: Key generation failed" -ForegroundColor Red
    exit 1
}
