# Published binaries only. Never run this fixture on a daily or self-hosted machine.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Must precede every write, download, registry query and child process.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'CI_ONLY_REFUSAL: requires a disposable GitHub-hosted Windows runner'
}
foreach ($name in @('RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_RUN_ID', 'APPDATA', 'LOCALAPPDATA')) {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "CI_ONLY_REFUSAL: missing $name" }
}
if (@(Get-Process -Name 'JJ Music', 'jj-music' -ErrorAction SilentlyContinue).Count) {
  throw 'Refusing existing JJ Music processes; nothing will be stopped'
}
foreach ($debugName in @('JJ_ALLOW_DEBUG_PORT', 'JJ_DEBUG_PORT')) {
  if ($null -ne [Environment]::GetEnvironmentVariable($debugName, 'User')) {
    throw "Refusing an existing runner user debug setting: $debugName"
  }
}
$profile = Join-Path $env:APPDATA 'jj-music'
foreach ($path in @($profile, (Join-Path $env:APPDATA '.jj-music-data-location.json'),
    (Join-Path $env:LOCALAPPDATA 'jj-music-updater'), (Join-Path $env:LOCALAPPDATA 'Programs/jj-music'))) {
  if (Test-Path -LiteralPath $path) { throw "Refusing an existing profile, pointer, cache or installation: $path" }
}
foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  if (@(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object {
    $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'JJ Music*'
  }).Count) { throw 'Refusing existing JJ Music installation registration' }
}
function Assert-RegularDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Not a regular directory: $Path"
  }
}
$tempRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path.TrimEnd('\')
Assert-RegularDirectory $tempRoot
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
Assert-RegularDirectory $workspace
Assert-RegularDirectory $env:APPDATA
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot ('or8-updater-' + [guid]::NewGuid().ToString('D'))))
if ((Split-Path -Parent $root) -ine $tempRoot -or (Test-Path -LiteralPath $root)) { throw 'Non-owned workspace refused' }
New-Item -ItemType Directory -Path $root | Out-Null
@{ root = $root; runId = $env:GITHUB_RUN_ID; profile = $profile } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'owner.json') -Encoding utf8
if ($env:GITHUB_OUTPUT) { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "report-dir=$root" }
$report = [ordered]@{ status = 'running'; root = $root; profile = $profile; started = (Get-Date -Format o); events = @() }
$reportPath = Join-Path $root 'supervisor-report.json'
function Record([string]$Stage, [object]$Value) {
  $report.events += @{ stage = $Stage; time = (Get-Date -Format o); value = $Value }
  $report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $reportPath -Encoding utf8
  Write-Host "OR8 official updater: $Stage"
}
$originalTemp = $env:TEMP; $originalTmp = $env:TMP; $originalLocal = $env:LOCALAPPDATA
$env:TEMP = Join-Path $root 'temp'; $env:TMP = $env:TEMP
$env:LOCALAPPDATA = Join-Path $root 'LocalAppData'
New-Item -ItemType Directory -Path $env:TEMP, $env:LOCALAPPDATA | Out-Null
$env:OR8_UPDATER_ROOT = $root
$oldSetup = Join-Path $root 'JJ-Music-0.4.2-Setup-x64.exe'
$installDir = Join-Path $root 'Installed/JJ Music'
$appExe = Join-Path $installDir 'JJ Music.exe'
$targetHash = '709387aef5fbc0fee15de5a2e24f0824d6e5b7f0ed678e13b8d9a672351cbe2c'
$runnerDebugConfigured = $false
try {
  Invoke-WebRequest -Uri 'https://github.com/jun501389541/JJ-Music/releases/download/v0.4.2/JJ-Music-0.4.2-Setup-x64.exe' -OutFile $oldSetup
  $oldHash = (Get-FileHash -LiteralPath $oldSetup -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($oldHash -cne '7f0af318dff6730fca60399baffbd1745ebc82647435aad26ba07e66ab0d4f57') { throw 'Official baseline Setup SHA256 mismatch' }
  Record 'old-setup-provenance' @{ url = 'official v0.4.2'; sha256 = $oldHash }
  $installer = Start-Process -FilePath $oldSetup -ArgumentList "/S /currentuser /D=$installDir" -WindowStyle Hidden -PassThru
  if (-not $installer.WaitForExit(180000)) { throw 'Baseline installer timeout; runner must be discarded' }
  $installer.Refresh()
  if ($installer.ExitCode -ne 0) { throw "Baseline installer exit $($installer.ExitCode)" }
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion.Trim()
  if ($version -cnotin @('0.4.2', '0.4.2.0')) { throw 'Installed baseline version mismatch' }
  if (-not (Test-Path -LiteralPath (Join-Path $installDir 'resources/nsis-install.marker') -PathType Leaf)) { throw 'Baseline NSIS marker missing' }
  if (@(Get-Process -Name 'JJ Music', 'jj-music' -ErrorAction SilentlyContinue).Count) { throw 'Silent baseline install unexpectedly started player' }
  Record 'official-old-installed' @{ version = $version; exeHash = (Get-FileHash -LiteralPath $appExe).Hash }
  if (Test-Path -LiteralPath $profile) { throw 'Baseline installer unexpectedly created default profile' }
  New-Item -ItemType Directory -Path (Join-Path $profile 'library') | Out-Null
  Set-Content -LiteralPath (Join-Path $profile 'settings.json') -Encoding utf8 -Value '{"theme":"light","volume":0.37,"libraryFolders":[],"minimizeToTray":false,"showSearchHotWords":false,"onlineDiagnostics":false,"onlineLyricSource":"off","onlineLyricFallback":false,"allowBuiltinOnlineSearch":false}'
  Set-Content -LiteralPath (Join-Path $root 'synthetic.wav') -Encoding utf8NoBOM -NoNewline -Value 'OR8 SYNTHETIC ONLY'
  @{ entries = @(@{ trackId = 'or8-updater-synthetic'; kind = 'lyric'; path = (Join-Path $root 'synthetic.wav'); name = 'OR8 Synthetic'; singer = 'CI'; at = 1; lyric = '[00:01]OR8 updater synthetic lyric' }); dismissed = @() } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $profile 'library/pending-assets.json') -Encoding utf8
  Record 'fresh-synthetic-profile-seeded' @{ profile = $profile }
  # Native UI operations are restricted to the exact signed-manifest-selected,
  # independently SHA-pinned downloaded executable. No desktop keystrokes.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Or8Windows {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wparam, string lparam, uint flags, uint timeout, out IntPtr result);
  public static void RefreshEnvironment() { IntPtr result; SendMessageTimeout(new IntPtr(0xffff), 0x001a, IntPtr.Zero, "Environment", 2, 5000, out result); }
  public static string Text(IntPtr hwnd) { var s=new StringBuilder(1024); GetWindowText(hwnd,s,s.Capacity); return s.ToString(); }
  public static string Class(IntPtr hwnd) { var s=new StringBuilder(256); GetClassName(hwnd,s,s.Capacity); return s.ToString(); }
  public static IntPtr[] Top(uint pid) { var a=new List<IntPtr>(); EnumWindows((h,d)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) a.Add(h); return true; },IntPtr.Zero); return a.ToArray(); }
  public static IntPtr[] Children(IntPtr hwnd) { var a=new List<IntPtr>(); EnumChildWindows(hwnd,(h,d)=>{ a.Add(h); return true; },IntPtr.Zero); return a.ToArray(); }
}
'@
  # NSIS StartApp delegates to the Windows shell, which can discard child-only
  # environment variables. Opt in only this disposable runner user, restoring
  # the previously absent values in finally. Never change product debug gates.
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $debugPort = $listener.LocalEndpoint.Port
  $listener.Stop()
  $runnerDebugConfigured = $true
  [Environment]::SetEnvironmentVariable('JJ_ALLOW_DEBUG_PORT', '1', 'User')
  [Environment]::SetEnvironmentVariable('JJ_DEBUG_PORT', [string]$debugPort, 'User')
  [Or8Windows]::RefreshEnvironment()
  Set-Content -LiteralPath (Join-Path $root 'debug-port.json') -Encoding utf8 -Value ([string]$debugPort)
  Record 'disposable-user-debug-opt-in' @{ port = $debugPort; restoredOnExit = $true }
  # Hosted runners can expose both setup-node and preinstalled Node entries.
  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  if ($node -isnot [string] -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'A single Node executable is required' }
  $probe = Join-Path $workspace 'tools/probe/or8-ci-updater.mjs'
  $runner = Start-Process -FilePath $node -ArgumentList ('"' + $probe + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'probe.stdout.log') -RedirectStandardError (Join-Path $root 'probe.stderr.log')
  $deadline = (Get-Date).AddMinutes(12)
  $lastUi = ''; $requestedPath = $null
  while (-not $runner.HasExited -and (Get-Date) -lt $deadline) {
    $requestFile = Join-Path $root 'installer-request.json'
    if (-not $requestedPath -and (Test-Path -LiteralPath $requestFile)) {
      $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
      $requestedPath = [IO.Path]::GetFullPath($request.path)
      if (-not $requestedPath.StartsWith($env:LOCALAPPDATA + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer UI request outside owned cache' }
      if ($request.sha256 -cne $targetHash -or (Get-FileHash -LiteralPath $requestedPath).Hash.ToLowerInvariant() -cne $targetHash) { throw 'Installer UI request hash mismatch' }
      Record 'owned-installer-ui-armed' @{ path = $requestedPath; sha256 = $targetHash }
    }
    if ($requestedPath) {
      foreach ($candidate in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $requestedPath })) {
        if ((Get-FileHash -LiteralPath $candidate.ExecutablePath).Hash.ToLowerInvariant() -cne $targetHash) { throw 'Running installer file hash changed' }
        foreach ($window in [Or8Windows]::Top([uint32]$candidate.ProcessId)) {
          $children = @([Or8Windows]::Children($window))
          $ui = ($children | ForEach-Object { [Or8Windows]::Text($_) }) -join ' | '
          if ($ui -ne $lastUi) { Record 'owned-installer-visible-ui' @{ pid = $candidate.ProcessId; title = [Or8Windows]::Text($window); controls = $ui }; $lastUi = $ui }
          # Match the current-user baseline through the real NSIS mode radio.
          # An administrator runner otherwise may choose an all-users install,
          # which the production same-directory migration guard must reject.
          foreach ($control in $children) {
            if ([Or8Windows]::Class($control) -eq 'Button' -and [Or8Windows]::Text($control) -cmatch '^Only for &?me\s*\(' -and
                [Or8Windows]::IsWindowVisible($control) -and [Or8Windows]::IsWindowEnabled($control)) {
              $before = [Or8Windows]::SendMessage($control, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
              [void][Or8Windows]::SendMessage($control, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
              $after = [Or8Windows]::SendMessage($control, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
              Record 'owned-installer-current-user-selected' @{ before = $before; after = $after }
              if ($after -ne 1) { throw 'Installer current-user choice was not selected' }
              break
            }
          }
          foreach ($control in $children) {
            $text = [Or8Windows]::Text($control)
            if ([Or8Windows]::Class($control) -eq 'Button' -and [Or8Windows]::IsWindowVisible($control) -and [Or8Windows]::IsWindowEnabled($control) -and
                $text -cmatch '^(?:&?Next\s*>?|&?Install|&?Finish|下一步.*|安装.*|完成.*)$') {
              Record 'owned-installer-button-click' @{ pid = $candidate.ProcessId; button = $text }
              [void][Or8Windows]::SendMessage($control, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
              break
            }
          }
        }
      }
    }
    Start-Sleep -Milliseconds 500
    $runner.Refresh()
  }
  if (-not $runner.HasExited) { throw 'Updater acceptance exceeded 12 minutes; runner must be discarded' }
  $runner.WaitForExit()
  $runner.Refresh()
  Record 'probe-exited' @{ exitCode = $runner.ExitCode }
  if ($runner.ExitCode -ne 0) { throw 'Actual packaged updater acceptance failed; inspect updater-report.json and logs' }
  $result = Get-Content -LiteralPath (Join-Path $root 'updater-report.json') -Raw | ConvertFrom-Json
  if ($result.status -cne 'passed') { throw 'Probe did not affirm successful restart/data continuity' }
  $newVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion.Trim()
  if ($newVersion -cnotin @('0.4.5', '0.4.5.0')) { throw 'Installed target version differs after restart' }
  Record 'official-target-installed' @{ version = $newVersion; exeHash = (Get-FileHash -LiteralPath $appExe).Hash }
  $report.status = 'passed'
} catch {
  $report.status = 'failed'; $report.error = $_.Exception.Message
  throw
} finally {
  if ($runnerDebugConfigured) {
    [Environment]::SetEnvironmentVariable('JJ_ALLOW_DEBUG_PORT', $null, 'User')
    [Environment]::SetEnvironmentVariable('JJ_DEBUG_PORT', $null, 'User')
    [Or8Windows]::RefreshEnvironment()
  }
  $ownedProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $appExe } |
    ForEach-Object { @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; version = [Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath).ProductVersion; commandLine = $_.CommandLine } })
  $report.events += @{ stage = 'final-owned-app-processes'; time = (Get-Date -Format o); value = $ownedProcesses }
  $report.finished = Get-Date -Format o
  $report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $reportPath -Encoding utf8
  foreach ($name in @('jj-music-u0-installer.log', 'jj-music-u0-init.log')) {
    $file = Join-Path $env:TEMP $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $root $name) }
  }
  $env:TEMP = $originalTemp; $env:TMP = $originalTmp; $env:LOCALAPPDATA = $originalLocal
  Remove-Item Env:OR8_UPDATER_ROOT -ErrorAction SilentlyContinue
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "Official 0.4.2 -> 0.4.5 packaged updater: **$($report.status)**. Inspect supervisor/updater reports and screenshots. No build, signing, gate or secret changes. This disposable runner is discarded; no daily host acceptance is claimed." }
  # Preserve fixture and processes for diagnosis; GitHub destroys this entire runner.
}
