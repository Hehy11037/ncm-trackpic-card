#requires -Version 5.1
<#
.SYNOPSIS
  One-stop helper for the local CDP (Chromium debug) channel of NetEase Cloud
  Music: creates a launcher shortcut and tells you exactly what to do.

.DESCRIPTION
  Why this is needed at all: the official client does not expose playback state
  through Windows SMTC, so the overlay reads it over the client's own local
  Chromium debug channel. That channel can only be enabled on the command line at
  process start, and the client enforces a single instance -- so the client has to
  be fully exited first, then started with the debug flag.

  The debug channel listens on loopback only (127.0.0.1). Nothing is exposed to
  the network.

  This script writes only:
    * CloudMusic (debug channel).lnk   (in the workspace)
  It never starts, stops or modifies the client, and never touches the client's
  data directory.

  NOTE: intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
  unless they carry a UTF-8 BOM, which corrupts non-ASCII literals.

.PARAMETER Port
  Debug port for the shortcut. Defaults to 9223.

.PARAMETER OutDir
  Where to write the shortcut. Defaults to this script's parent directory.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\debug-launch.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 9223,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'

if (-not $OutDir) {
  $OutDir = Split-Path -Parent $PSCommandPath
}

$exeCandidates = @(
  (Join-Path $env:ProgramFiles 'Netease\CloudMusic\cloudmusic.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Netease\CloudMusic\cloudmusic.exe'),
  (Join-Path $env:LOCALAPPDATA 'Netease\CloudMusic\cloudmusic.exe')
)

$exe = $exeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $exe) {
  Write-Output 'ERROR: cloudmusic.exe not found. Tried:'
  $exeCandidates | ForEach-Object { Write-Output "  $_" }
  exit 3
}

$arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
$lnkPath = Join-Path $OutDir 'CloudMusic (debug channel).lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $exe
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.Description = "NetEase Cloud Music with local CDP channel on 127.0.0.1:$Port"
$shortcut.IconLocation = "$exe,0"
$shortcut.Save()

$running = @(Get-Process -Name cloudmusic -ErrorAction SilentlyContinue)

Write-Output '=== shortcut ==='
Write-Output "  file      : $lnkPath"
Write-Output "  target    : $exe"
Write-Output "  arguments : $arguments"
Write-Output ''
Write-Output '=== client state ==='
if ($running.Count -gt 0) {
  Write-Output "  running   : yes ($($running.Count) processes)"
  Write-Output '  NOTE: the shortcut will have no effect while the client is running,'
  Write-Output '        because the client enforces a single instance.'
} else {
  Write-Output '  running   : no -- good, the shortcut can be used right now'
}
Write-Output ''
Write-Output '=== next steps ==='
Write-Output '  1. Copy the .lnk to your Desktop (optional, for convenience):'
Write-Output "       Copy-Item '$lnkPath' ([Environment]::GetFolderPath('Desktop'))"
Write-Output '  2. Fully exit Cloud Music (window close AND tray icon exit).'
Write-Output '  3. Double-click the shortcut (or run this directly in a normal terminal):'
Write-Output "       & `"$exe`" $arguments"
Write-Output '  4. Verify the channel:   npm run probe'
Write-Output '  5. Then:                 npm run discover'
