# Installs Universe on Windows from its GitHub release, without the browser's
# "isn't commonly downloaded" block or SmartScreen's "Windows protected your
# PC": both come from the mark a browser puts on what it downloads, and a file
# PowerShell downloads has none. The installer is checked against the SHA-512
# the release's update manifest gives for it before it runs.
#
#   irm https://github.com/Gabetd/universe.me/releases/download/latest-build/install.ps1 | iex
#
# Each release's copy installs from that release (build.yml stamps it): dev-build's
# installs Universe (dev), staging-build's Universe (staging). -Portable takes the
# portable .exe instead (into %LOCALAPPDATA%\Programs), -Silent installs without the
# installer's questions. With options:
#
#   & ([scriptblock]::Create((irm <that url>))) -Portable
param(
  [switch]$Portable,
  [switch]$Silent,
  # The release to install from; the published copy has its own.
  [string]$Tag = '__TAG__'
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5 draws progress slowly enough to slow the download, and may not offer TLS 1.2 unasked.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
if ($Tag -like '__*') { $Tag = 'latest-build' }

$release = "https://github.com/Gabetd/universe.me/releases/download/$Tag"
Write-Host "Looking at the $Tag release…"
$manifest = Invoke-RestMethod "$release/update.json"
$file = if ($Portable) { $manifest.files.'win-portable-x64' } else { $manifest.files.'win-nsis-x64' }
if (-not $file) { throw "The $Tag release has no Windows build" }

$dest = Join-Path $env:TEMP $file.name
Write-Host "Downloading $($file.name) ($([math]::Round($file.size / 1MB)) MB)…"
Invoke-WebRequest "$release/$($file.name)" -OutFile $dest -UseBasicParsing
$sha = [Security.Cryptography.SHA512]::Create()
try { $stream = [IO.File]::OpenRead($dest); $hash = [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { if ($stream) { $stream.Dispose() } }
if ($hash -ne $file.sha512) {
  Remove-Item $dest -Force
  throw "$($file.name) isn't what the release says it should be (its SHA-512 differs): nothing was installed"
}
# There's no mark to take off a file PowerShell downloaded, but should a policy add one, it goes.
Unblock-File $dest

# The channel's own app: Universe, or Universe (dev) and Universe (staging) beside it.
$app = @{ 'staging-build' = 'Universe (staging)'; 'dev-build' = 'Universe (dev)' }[$Tag]
if (-not $app) { $app = 'Universe' }

if ($Portable) {
  # Kept under one name, which its self-updater replaces in place.
  $dir = Join-Path $env:LOCALAPPDATA "Programs\$app portable"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $exe = Join-Path $dir "$app.exe"
  Move-Item $dest $exe -Force
  Write-Host "$app $($manifest.version) is in $dir. Starting it…"
  Start-Process $exe
} else {
  Write-Host "Installing $app $($manifest.version)…"
  $run = @{ FilePath = $dest; Wait = $true }
  if ($Silent) { $run.ArgumentList = '/S' }
  Start-Process @run
  Remove-Item $dest -Force -ErrorAction SilentlyContinue
  Write-Host 'Installed: it is in the Start menu. It updates itself from now on.'
}
