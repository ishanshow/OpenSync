# OpenSync Extension Build Script
# Generates a .zip file ready to upload to Firefox Add-ons (addons.mozilla.org)
#
# Usage:  .\build.ps1
#
# Prerequisites: PowerShell 5.1+ (ships with Windows 10/11)
#
# IMPORTANT: Before running, update the version in BOTH places:
#   1. manifest.json   -> "version": "x.y.z"
#   2. popup/popup.html -> <span class="version-badge">vx.y.z</span>

param(
    [switch]$SkipVersionCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Read version from manifest.json
$manifest = Get-Content ".\manifest.json" -Raw | ConvertFrom-Json
$version = $manifest.version

if (-not $version) {
    Write-Error "Could not read version from manifest.json"
    exit 1
}

Write-Host "Building OpenSync v$version ..." -ForegroundColor Cyan

# Check that popup/popup.html version badge matches
if (-not $SkipVersionCheck) {
    $popupHtml = Get-Content ".\popup\popup.html" -Raw
    if ($popupHtml -notmatch "v$version") {
        Write-Error "Version mismatch: manifest.json says $version but popup.html does not contain 'v$version'. Update popup/popup.html to match."
        exit 1
    }
}

$zipName = "OpenSync-v$version.zip"
$zipPath = Join-Path (Get-Location).Path $zipName

# Remove old zip if it exists
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
    Write-Host "  Removed existing $zipName"
}

# Build the zip using .NET APIs to ensure forward-slash paths (required by Firefox)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$basePath = (Get-Location).Path
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

$files = Get-ChildItem -Path . -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\\.git\\' -and
    $_.FullName -notmatch '\\server\\' -and
    $_.FullName -notmatch '\\node_modules\\' -and
    $_.FullName -notmatch '\\test\\' -and
    $_.Name -notmatch '\.zip$' -and
    $_.Name -ne '.gitignore' -and
    $_.Name -ne 'README.md' -and
    $_.Name -ne 'package-lock.json' -and
    $_.Name -ne 'build.ps1' -and
    $_.Name -ne 'icon-1024.png'
}

foreach ($f in $files) {
    # Convert backslashes to forward slashes (zip spec + Firefox requirement)
    $rel = $f.FullName.Substring($basePath.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel) | Out-Null
    Write-Host "  + $rel"
}

$zip.Dispose()

$size = (Get-Item $zipPath).Length
$sizeKB = [math]::Round($size / 1024, 1)

Write-Host ""
Write-Host "Created $zipName ($sizeKB KB)" -ForegroundColor Green
Write-Host "Upload at: https://addons.mozilla.org/developers/addon/submit" -ForegroundColor DarkGray
