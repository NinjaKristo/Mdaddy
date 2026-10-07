param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$targetPath = [System.IO.Path]::GetFullPath($Target)
$targetDir = [System.IO.Path]::GetDirectoryName($targetPath)
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$pendingPath = "$targetPath.new"
Copy-Item -LiteralPath $sourcePath -Destination $pendingPath -Force
$sourceHash = Get-Sha256 $sourcePath
if ((Get-Sha256 $pendingPath) -ne $sourceHash) {
  Remove-Item -LiteralPath $pendingPath -Force
  throw 'Staged release executable did not match the build output.'
}

if (Test-Path -LiteralPath $targetPath) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = "$targetPath.previous.$stamp.exe"
  [System.IO.File]::Replace($pendingPath, $targetPath, $backupPath, $true)
  Write-Output "Previous release preserved at $backupPath"
} else {
  [System.IO.File]::Move($pendingPath, $targetPath)
}

$releaseHash = Get-Sha256 $targetPath
if ($releaseHash -ne $sourceHash) { throw 'Final release executable does not match the build output.' }
Write-Output "Release SHA-256: $releaseHash"
