# Build the portable USB zip: executable plus the Data/ folder.
# Prerequisites: npm run build and cargo build --release completed; tauri.conf.json version updated.
# The version is embedded in the executable; rebuild after changing it.
# Usage: powershell -File scripts\make-portable.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "src-tauri\target\release\md-editor.exe"
if (-not (Test-Path $exe)) { throw "Release executable not found: $exe (build the release first)." }

# Read the version from tauri.conf.json and include it in the zip name.
$conf = [System.IO.File]::ReadAllText((Join-Path $root "src-tauri\tauri.conf.json")) | ConvertFrom-Json
$v = $conf.version
if (-not $v -match '^\d+\.\d+\.\d+$') { throw "Invalid version: '$v'" }

$stage = Join-Path $root "dist-portable\md-editor-portable-v$v"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage\Data" | Out-Null
Copy-Item $exe "$stage\md-editor.exe" -Force
$note = @(
  "This folder contains all portable editor data (settings, themes, sessions, and logs). Keep it with the app.",
  "Copy md-editor-portable-v$v anywhere on your USB drive and run md-editor.exe.",
  "To upgrade, replace md-editor.exe and keep the Data folder.",
  "Delete this folder to remove portable mode data. The installed app stores data in your user profile."
) -join "`r`n"
[System.IO.File]::WriteAllText("$stage\Data\README.txt", $note, (New-Object System.Text.UTF8Encoding($false)))

$zip = Join-Path $root "dist-portable\md-editor-portable-v$v.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $stage -DestinationPath $zip

# Verify the zip, executable, Data folder, and embedded version.
$zipSize = (Get-Item $zip).Length
if ($zipSize -lt 1MB) { throw "Zip is unexpectedly small: $zipSize bytes." }
$exeVer = (Get-Item "$stage\md-editor.exe").VersionInfo.ProductVersion
Write-Host "OK zip=$zip ($([math]::Round($zipSize/1MB,1))MB) conf=v$v exeProduct=$exeVer data=$(Test-Path "$stage\Data\README.txt")"