#requires -Version 5.1
<#
.SYNOPSIS
  Restart the NetEase Cloud Music client so that it opens its local Chromium
  debug (CDP) channel.

.DESCRIPTION
  The client enforces a single instance, and the debug port can only be enabled
  on the command line at process start. So the client must be stopped and started
  again with --remote-debugging-port. If it is not currently running, it is simply
  started, and no playback is interrupted.

  This script does exactly three things: stop cloudmusic.exe (and
  cloudmusic_util.exe), ask for confirmation before interrupting playback, and
  start the client with the debug port. It does not modify any file in the
  installation directory and does not touch account data; the login session lives
  in the client's own config and survives a restart.

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
  .ps1 files as ANSI unless they have a UTF-8 BOM, which corrupts non-ASCII
  string literals. User-facing localized text belongs in the TypeScript app.

  CRITICAL: do NOT run this from a sandboxed/confined shell. The client inherits
  the shell's restrictions and dies on startup with:
      FATAL:platform_channel.cc(85) Check failed: Access is denied. (0x5)
  because it can neither write its profile under %LOCALAPPDATA%\Netease nor open
  the named pipes CEF uses for IPC. Run it from a normal terminal, or just start
  the client from its Start Menu shortcut / desktop icon.

  This script never modifies anything inside the client's data directory. It does
  not delete lock files or crash flags; the client owns that state.

.PARAMETER Port
  Debug port. Defaults to 9223, matching common community tooling.

.PARAMETER Yes
  Skip the confirmation prompt.

.PARAMETER NoRestart
  Only stop the client; do not start it again.
#>
[CmdletBinding()]
param(
  [int]$Port = 9223,
  [switch]$Yes,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

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

Write-Output "EXE:  $exe"
Write-Output "PORT: $Port"

$procs = @(Get-Process -Name cloudmusic, cloudmusic_util -ErrorAction SilentlyContinue)
$wasRunning = $procs.Count -gt 0

if ($wasRunning) {
  Write-Output "STATE: running ($($procs.Count) process(es))"
  Write-Output 'RESTARTING WILL INTERRUPT CURRENT PLAYBACK (login session is kept).'
  if (-not $Yes) {
    $answer = Read-Host 'Continue? type y to confirm'
    if ($answer -notmatch '^(y|yes)$') {
      Write-Output 'CANCELLED: nothing was changed.'
      exit 2
    }
  }
  foreach ($p in $procs) {
    Write-Output "STOP: $($p.ProcessName) pid=$($p.Id)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Process -Name cloudmusic -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  Write-Output 'STATE: stopped'
} else {
  Write-Output 'STATE: not running (nothing to interrupt)'
}

if ($NoRestart) {
  Write-Output 'DONE: stopped only (-NoRestart).'
  exit 0
}

$startArgs = @(
  '--remote-debugging-address=127.0.0.1',
  "--remote-debugging-port=$Port"
)
Write-Output "START: $exe $($startArgs -join ' ')"
Start-Process -FilePath $exe -ArgumentList $startArgs -WorkingDirectory (Split-Path -Parent $exe)

$ready = $false
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  try {
    $json = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    if ($json.webSocketDebuggerUrl) { $ready = $true; break }
  } catch {
    Start-Sleep -Milliseconds 800
  }
}

if ($ready) {
  Write-Output 'READY: debug channel is up.'
  exit 0
}

Write-Output 'TIMEOUT: debug port did not open within 45s.'
Write-Output '  - the client may still be starting; retry npm run probe later'
Write-Output '  - security software may be blocking the local listen port'
Write-Output '  - this client build may not support --remote-debugging-port'
Write-Output '    (in that case fall back to the BetterNCM/chromatic source adapter)'
exit 1
