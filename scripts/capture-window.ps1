<#
.SYNOPSIS
  Screenshot one rig instance's window to a PNG.

.DESCRIPTION
  docs/satchels-and-sync.md 5.6. The two-process rig can drive the handoff
  paths, but until the window can be looked at, every claim about what the user
  sees stays human-only. Both processes are called vellum.exe, so the window is
  found by the pid dev-two.ps1 recorded in the instance's machine directory.

  PrintWindow with PW_RENDERFULLCONTENT (2) is used rather than a screen BitBlt:
  it captures a window that is behind another one, which is exactly the case
  when two instances overlap, and it renders WebView2's composited content that
  a plain PrintWindow misses.

.PARAMETER Which
  A or B, matching dev-two.ps1.

.PARAMETER Out
  Where to write the PNG. Defaults to <rig>\<Which>\shot-<timestamp>.png.

.EXAMPLE
  pwsh ./scripts/capture-window.ps1 -Which A
#>
#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('A', 'B')][string]$Which,
    [string]$Out
)

$ErrorActionPreference = 'Stop'

$rig = Join-Path $env:LOCALAPPDATA 'Vellum-rig'
$pidFile = Join-Path $rig "$Which\machine\instance.pid"
if (-not (Test-Path $pidFile)) { throw "No pid recorded for instance $Which. Start it with scripts/dev-two.ps1." }
$instancePid = [int](Get-Content $pidFile -Raw).Trim()

$proc = Get-Process -Id $instancePid -ErrorAction SilentlyContinue
if (-not $proc) { throw "Instance $Which (pid $instancePid) is not running." }
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "Instance $Which (pid $instancePid) has no main window yet." }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class VellumShot {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@ -ErrorAction SilentlyContinue

$rect = New-Object VellumShot+RECT
[void][VellumShot]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
if ($w -le 0 -or $h -le 0) { throw "Instance $Which has a zero-sized window." }

$bmp = New-Object Drawing.Bitmap($w, $h)
$gfx = [Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
$ok = [VellumShot]::PrintWindow($hwnd, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()

if (-not $Out) {
    $Out = Join-Path $rig "$Which\shot-$(Get-Date -Format 'yyyyMMdd-HHmmss').png"
}
[void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out))
$bmp.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "instance $Which pid $instancePid hwnd $hwnd ${w}x${h} printWindow=$ok"
Write-Host $Out
