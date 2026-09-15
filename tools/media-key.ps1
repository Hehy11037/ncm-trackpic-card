#requires -Version 5.1
<#
.SYNOPSIS
  Send one media key press to Windows.

.DESCRIPTION
  The overlay's play/pause reaches the client through its own audio module, and that call was
  measured to have no effect. A media key is the documented fallback (docs/contracts.md section 6):
  the client registers global media hotkeys, which is exactly the "reuse the app's own path"
  property that matters, and it cannot break when the client is updated.

  The keystroke is injected at the system level with keybd_event, so it reaches whichever process
  owns the media hotkey regardless of which window has focus. That matters here: the overlay is
  always on top and focused, so a key sent to the foreground window would reach the overlay.

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
  unless they carry a UTF-8 BOM, which corrupts non-ASCII string literals.

.PARAMETER Key
  Which key to press. Defaults to playpause.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\media-key.ps1 -Key playpause
#>
[CmdletBinding()]
param(
  [ValidateSet('playpause', 'next', 'prev', 'stop')]
  [string]$Key = 'playpause'
)

$ErrorActionPreference = 'Stop'

# Virtual-key codes; see the Windows "Virtual-Key Codes" table.
$codes = @{
  playpause = 0xB3
  next      = 0xB0
  prev      = 0xB1
  stop      = 0xB2
}
$vk = $codes[$Key]

Add-Type -Namespace Overlay -Name MediaKey -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@

# 0 = key down, 2 = KEYEVENTF_KEYUP. The pair is what a real key press looks like.
[Overlay.MediaKey]::keybd_event([byte]$vk, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[Overlay.MediaKey]::keybd_event([byte]$vk, 0, 2, [System.UIntPtr]::Zero)

Write-Output ("SENT: {0} (VK 0x{1:X2})" -f $Key, $vk)
