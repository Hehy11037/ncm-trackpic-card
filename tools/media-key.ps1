#requires -Version 5.1
<#
.SYNOPSIS
  Send media key presses to Windows.

.DESCRIPTION
  The overlay's play/pause reaches the client through its own audio module, and that call was
  measured to have no effect. A media key is the documented fallback (docs/contracts.md section 6):
  the client registers global media hotkeys, which is exactly the "reuse the app's own path"
  property that matters, and it cannot break when the client is updated.

  The keystroke is injected at the system level with keybd_event, so it reaches whichever process
  owns the media hotkey regardless of which window has focus. That matters here: the overlay is
  always on top and focused, so a key sent to the foreground window would reach the overlay.

  Two ways to run it:

    one press   -File media-key.ps1 -Key playpause
    a session   -File media-key.ps1 -Serve

  `-Serve` exists because one press used to cost about 880ms, which the owner felt as a delay
  between clicking play/pause and the music actually stopping. Almost none of that was the key:
  roughly 380ms is Windows PowerShell starting, and the rest is `Add-Type` compiling the P/Invoke
  declaration *on every press*. In serve mode the type is compiled once and each press is one line
  on stdin - single-digit milliseconds - so `media-key.ts` keeps one of these alive instead of
  spawning a process per button.

  Commands on stdin, one per line: a key name, `ping` (reply `READY ping`, the round trip that says
  the compile is done), or `quit`. Replies are one line each: `READY ...`, `SENT: <key> (VK 0xNN)`,
  `ERR <reason>`.

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
  unless they carry a UTF-8 BOM, which corrupts non-ASCII string literals.

.PARAMETER Key
  Which key to press. Defaults to playpause. Ignored with -Serve.

.PARAMETER Serve
  Read commands from stdin until `quit` or end of input.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\media-key.ps1 -Key playpause
#>
[CmdletBinding()]
param(
  [ValidateSet('playpause', 'next', 'prev', 'stop')]
  [string]$Key = 'playpause',
  [switch]$Serve
)

$ErrorActionPreference = 'Stop'

# Virtual-key codes; see the Windows "Virtual-Key Codes" table.
$codes = @{
  playpause = 0xB3
  next      = 0xB0
  prev      = 0xB1
  stop      = 0xB2
}

Add-Type -Namespace Overlay -Name MediaKey -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@

function Send-MediaKey([string]$name) {
  $vk = $codes[$name]
  # 0 = key down, 2 = KEYEVENTF_KEYUP. The pair is what a real key press looks like.
  [Overlay.MediaKey]::keybd_event([byte]$vk, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [Overlay.MediaKey]::keybd_event([byte]$vk, 0, 2, [System.UIntPtr]::Zero)
  # Written through [Console] and flushed, not Write-Output: the caller reads a pipe and needs the
  # line now, rather than whenever PowerShell decides to flush its own output buffer.
  [Console]::Out.WriteLine(("SENT: {0} (VK 0x{1:X2})" -f $name, $vk))
  [Console]::Out.Flush()
}

if ($Serve) {
  [Console]::Out.WriteLine('READY serve')
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $name = $line.Trim().ToLowerInvariant()
    if ($name -eq '') { continue }
    if ($name -eq 'quit') { break }
    if ($name -eq 'ping') {
      [Console]::Out.WriteLine('READY ping')
      [Console]::Out.Flush()
      continue
    }
    if (-not $codes.ContainsKey($name)) {
      [Console]::Out.WriteLine("ERR unknown key $name")
      [Console]::Out.Flush()
      continue
    }
    Send-MediaKey $name
  }
  exit 0
}

Send-MediaKey $Key
