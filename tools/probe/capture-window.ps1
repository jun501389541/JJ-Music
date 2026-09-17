# Capture the JJ Music window to a PNG for visual verification.
#
# Uses PrintWindow with PW_RENDERFULLCONTENT, which is required for
# GPU-composited windows such as Electron/Chromium; a plain BitBlt from the
# screen DC often yields a black rectangle for them.

param(
    [string]$ProcessName = 'electron',
    [string]$OutFile = 'docs/research/screenshots/app.png'
)

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    public const uint PW_RENDERFULLCONTENT = 0x2;
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    public static readonly IntPtr DPI_PER_MONITOR_V2 = new IntPtr(-4);
}
'@

# Declare per-monitor DPI awareness before any window metrics are read.
# Without this, GetWindowRect returns virtualised (scaled-down) coordinates on
# a display with scaling enabled, and the capture is cropped.
try { [void][WinCap]::SetProcessDpiAwareness(2) } catch { }
try { [void][WinCap]::SetThreadDpiAwarenessContext([WinCap]::DPI_PER_MONITOR_V2) } catch { }

$candidates = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 }

if (-not $candidates) {
    Write-Error "No visible $ProcessName window found."
    exit 1
}

# Electron spawns helper processes that can own small auxiliary windows (GPU
# status, offscreen render hosts). Pick the largest top-level window, which is
# the real app shell.
$proc = $null
$bestArea = -1
foreach ($candidate in $candidates) {
    $r = New-Object WinCap+RECT
    if (-not [WinCap]::GetWindowRect($candidate.MainWindowHandle, [ref]$r)) { continue }
    $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
    if ($area -gt $bestArea) {
        $bestArea = $area
        $proc = $candidate
    }
}

if (-not $proc) {
    Write-Error "No measurable $ProcessName window found."
    exit 1
}

$handle = $proc.MainWindowHandle
Write-Host "Window: '$($proc.MainWindowTitle)' (pid $($proc.Id), hwnd $handle)"

# Restore from a minimised/maximised state and raise the window before
# measuring. A minimised window reports a degenerate rectangle, which is what
# makes a naive capture produce a tiny or black image.
[void][WinCap]::ShowWindow($handle, 9)   # SW_RESTORE
[void][WinCap]::ShowWindow($handle, 5)   # SW_SHOW
[void][WinCap]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 1200

$rect = New-Object WinCap+RECT
if (-not [WinCap]::GetWindowRect($handle, [ref]$rect)) {
    Write-Error 'GetWindowRect failed.'
    exit 1
}

# If the rectangle is still degenerate, fall back to the process's own reported
# bounds so at least the error is legible.
if (($rect.Right - $rect.Left) -lt 200 -or ($rect.Bottom - $rect.Top) -lt 200) {
    Write-Warning ("Window rect looks degenerate ({0}x{1}); the window may be minimised or hidden." -f ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Host "Size: ${width}x${height}"

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()

$ok = [WinCap]::PrintWindow($handle, $hdc, [WinCap]::PW_RENDERFULLCONTENT)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

if (-not $ok) {
    Write-Warning 'PrintWindow returned false; the image may be incomplete.'
}

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$bitmap.Save((Resolve-Path -LiteralPath $dir).Path + '\' + (Split-Path -Leaf $OutFile),
             [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "Saved: $OutFile"
