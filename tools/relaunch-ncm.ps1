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

# ---------------------------------------------------------------------- logging
#
# Everything this script decides goes to a log inside the workspace as well as to
# the console. The reason is a real support round: the owner reported "I restarted
# the client many times and it still says no debug channel", and from the outside
# there was no way to tell WHICH of the three possible things had happened -
#   (1) the launch never carried the flags (wrong icon, or a previous instance
#       still held the single-instance lock and took the request over),
#   (2) the flags were carried and the client ignored them, or
#   (3) the client died on startup (a sandboxed shell will do this: it cannot
#       write its profile under %LOCALAPPDATA%\Netease).
# The log distinguishes all three, because it records the launched process's own
# fate and the exact command line it was given.

$logPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.scratch\relaunch.log'
$logDir = Split-Path -Parent $logPath
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Output $line
  try {
    # ASCII would corrupt nothing here (the script is ASCII-only), but the log is read
    # alongside UTF-8 files, so it is written as UTF-8 to keep every reader happy.
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {
    Write-Output "WARN: could not write $logPath : $($_.Exception.Message)"
  }
}

Write-Log '=== relaunch-ncm ==='

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

$vi = (Get-Item -LiteralPath $exe).VersionInfo
Write-Log "EXE:  $exe  (FileVersion $($vi.FileVersion))"
Write-Log "PORT: $Port"

$procs = @(Get-Process -Name cloudmusic, cloudmusic_util -ErrorAction SilentlyContinue)
$wasRunning = $procs.Count -gt 0

if ($wasRunning) {
  Write-Log "STATE: running ($($procs.Count) process(es)): $(($procs | ForEach-Object { "$($_.ProcessName)#$($_.Id)@$($_.StartTime.ToString('HH:mm:ss'))" }) -join ' ')"
  Write-Log 'RESTARTING WILL INTERRUPT CURRENT PLAYBACK (login session is kept).'
  if (-not $Yes) {
    $answer = Read-Host 'Continue? type y to confirm'
    if ($answer -notmatch '^(y|yes)$') {
      Write-Log 'CANCELLED: nothing was changed.'
      exit 2
    }
  }
  foreach ($p in $procs) {
    Write-Log "STOP: $($p.ProcessName) pid=$($p.Id)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Process -Name cloudmusic -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  $left = @(Get-Process -Name cloudmusic, cloudmusic_util -ErrorAction SilentlyContinue)
  Write-Log "STATE: stopped (still alive: $($left.Count))"
} else {
  Write-Log 'STATE: not running (nothing to interrupt)'
}

if ($NoRestart) {
  Write-Log 'DONE: stopped only (-NoRestart).'
  exit 0
}

$startArgs = @(
  '--remote-debugging-address=127.0.0.1',
  "--remote-debugging-port=$Port"
)
Write-Log "START: $exe $($startArgs -join ' ')"
$started = Start-Process -FilePath $exe -ArgumentList $startArgs -WorkingDirectory (Split-Path -Parent $exe) -PassThru

# The launched process's own fate is the single most useful fact here: a launcher that
# exits immediately either handed the request to an instance that was already running
# (the single-instance lock) or died on startup.
Start-Sleep -Seconds 4
$survived = -not $started.HasExited
if ($survived) {
  Write-Log "LAUNCHED: pid=$($started.Id) is still running after 4s"
} else {
  $code = 'unknown'
  try { $code = $started.ExitCode } catch { }
  Write-Log "LAUNCHED: pid=$($started.Id) EXITED within 4s (exit code $code)"
  Write-Log '  -> either another instance already held the single-instance lock and took the request over,'
  Write-Log '     or the client failed to start (a restricted/sandboxed shell causes this).'
}

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
  Write-Log 'READY: debug channel is up.'
  exit 0
}

$now = @(Get-Process -Name cloudmusic -ErrorAction SilentlyContinue)
Write-Log "TIMEOUT: debug port did not open within 45s. cloudmusic processes now: $($now.Count)"
if ($now.Count -gt 0) {
  # What the client *is* listening on separates "no debug port" from "no listener at all".
  $pids = $now | ForEach-Object { $_.Id }
  $ports = @()
  foreach ($line in (netstat -ano | Select-String 'LISTENING')) {
    $parts = ($line.Line -split '\s+')
    $owner = $parts[-1]
    if ($owner -and ($pids -contains [int]$owner)) { $ports += $parts[2] }
  }
  Write-Log "  client listening on: $(if ($ports.Count) { $ports -join ' ' } else { '(nothing on loopback)' })"
}
Write-Output 'TIMEOUT: debug port did not open within 45s.'
Write-Output '  - the client may still be starting; retry npm run probe later'
Write-Output '  - security software may be blocking the local listen port'
Write-Output '  - this client build may not support --remote-debugging-port'
Write-Output '    (in that case fall back to the BetterNCM/chromatic source adapter)'
exit 1
