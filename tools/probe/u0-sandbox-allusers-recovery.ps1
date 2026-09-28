$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0Recovery'
$backup = 'C:\U0Recovery\VerifiedBackup'
$moved = 'C:\U0Recovery\RemovedLegacyData'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'recovery-started.txt') -Value $result.time

function Inventory([string]$Root) {
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    [ordered]@{
      relative = $_.FullName.Substring($Root.Length + 1)
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  } | Sort-Object relative)
}

function Same-Inventory($A, $B) {
  return (($A | ConvertTo-Json -Depth 5 -Compress) -eq ($B | ConvertTo-Json -Depth 5 -Compress))
}

function Find-InstallDir {
  $entry = Get-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'JJ Music*' } | Select-Object -First 1
  if (-not $entry -or $entry.UninstallString -notmatch '^"([^"]+Uninstall JJ Music\.exe)"') {
    throw 'All-users uninstall entry not found'
  }
  return Split-Path -Parent $Matches[1]
}

try {
  $old = Join-Path $caseDir 'Legacy.exe'
  $next = Join-Path $caseDir 'Next.exe'
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-0.2.0-Setup-x64.exe' -Destination $old
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-current-Setup-x64.exe' -Destination $next
  $result.oldHash = (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash
  $result.nextHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
  $result.oldExitCode = (Start-Process -FilePath $old -ArgumentList @('/S', '/allusers') -Wait -PassThru).ExitCode
  if ($result.oldExitCode -ne 0) { throw "Old install failed: $($result.oldExitCode)" }
  $installDir = Find-InstallDir
  $result.installDir = $installDir
  $appPath = Join-Path $installDir 'JJ Music.exe'
  Start-Process -FilePath $appPath | Out-Null
  Start-Sleep -Seconds 10
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $oldData = Join-Path $installDir 'data'
  if (-not (Test-Path -LiteralPath $oldData)) { throw 'Old app did not create shared install data' }
  [System.IO.File]::WriteAllText((Join-Path $oldData 'u0-sentinel.txt'), 'PRESERVE_ME')
  [System.IO.File]::WriteAllText((Join-Path $oldData 'settings.json'), '{"theme":"light","volume":0.37}')
  $before = Inventory $oldData
  $result.beforeCount = $before.Count
  $result.stage = 'before-refusal'
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $resultDir 'recovery-before.json')

  $result.refusalExitCode = (Start-Process -FilePath $next -ArgumentList @('/S', '/allusers') -Wait -PassThru).ExitCode
  $result.refusalLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $result.oldExeAfterRefusal = Test-Path -LiteralPath $appPath
  $result.oldDataAfterRefusal = Test-Path -LiteralPath $oldData
  $result.markerAfterRefusal = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  if ($result.refusalExitCode -ne 42 -or -not $result.oldExeAfterRefusal -or
      -not $result.oldDataAfterRefusal -or $result.markerAfterRefusal) {
    throw 'Fail-closed stage did not preserve the old installation'
  }

  # This account created the sample profile. A human recovery must establish
  # ownership before making this choice on a real multi-user computer.
  $target = Join-Path $env:APPDATA 'jj-music'
  $result.target = $target
  if (Test-Path -LiteralPath $target) {
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
      throw 'Recovery target is not empty; refuse to overwrite another profile'
    }
    Remove-Item -LiteralPath $target -Force
  }
  if ([System.IO.Path]::GetFullPath($backup) -ne 'C:\U0Recovery\VerifiedBackup' -or
      [System.IO.Path]::GetFullPath($moved) -ne 'C:\U0Recovery\RemovedLegacyData') {
    throw 'Recovery paths escaped the isolated case directory'
  }
  Copy-Item -LiteralPath $oldData -Destination $backup -Recurse
  $result.backupVerified = Same-Inventory $before (Inventory $backup)
  if (-not $result.backupVerified) { throw 'Independent backup hash comparison failed' }
  Copy-Item -LiteralPath $backup -Destination $target -Recurse
  $result.targetVerified = Same-Inventory $before (Inventory $target)
  if (-not $result.targetVerified) { throw 'Account target hash comparison failed' }
  Move-Item -LiteralPath $oldData -Destination $moved
  $result.movedVerified = Same-Inventory $before (Inventory $moved)
  if (-not $result.movedVerified) { throw 'Moved old profile hash comparison failed' }
  $result.stage = 'before-retry'
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $resultDir 'recovery-staged.json')

  $result.retryExitCode = (Start-Process -FilePath $next -ArgumentList @('/S', '/allusers') -Wait -PassThru).ExitCode
  $result.retryLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $result.markerAfterRetry = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.targetAfterRetryVerified = Same-Inventory $before (Inventory $target)
  $result.backupAfterRetryVerified = Same-Inventory $before (Inventory $backup)
  if ($result.retryExitCode -ne 0 -or -not $result.markerAfterRetry -or
      -not $result.targetAfterRetryVerified -or -not $result.backupAfterRetryVerified) {
    throw 'Retry or data preservation failed'
  }

  $env:JJ_DEBUG_PORT = '37921'
  $env:JJ_ALLOW_DEBUG_PORT = '1'
  Start-Process -FilePath $appPath | Out-Null
  & 'C:\u0-input\node.exe' 'C:\u0-input\content-cdp.mjs' (Join-Path $resultDir 'recovery-ui.json')
  $result.uiProbeExitCode = $LASTEXITCODE
  $ui = Get-Content -LiteralPath (Join-Path $resultDir 'recovery-ui.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $result.uiProbeOk = $ui.ok
  $result.uiResult = $ui.result
  if (-not $ui.ok -or $ui.result.dataDir -ne $target -or $ui.result.theme -ne 'light' -or
      $ui.result.volume -ne 0.37) { throw 'Restored profile not visible in the app' }
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'recovery.json')
}
