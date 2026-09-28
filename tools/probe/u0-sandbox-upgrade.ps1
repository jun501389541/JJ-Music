$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0Upgrade'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'upgrade-started.txt') -Value $result.time

function Inventory([string]$root) {
  return @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
    [ordered]@{
      relative = $_.FullName.Substring($root.Length + 1)
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  } | Sort-Object relative)
}

try {
  $installDir = Join-Path $caseDir 'Installed'
  $old = Join-Path $caseDir 'Legacy.exe'
  $next = Join-Path $caseDir 'Next.exe'
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-0.2.0-Setup-x64.exe' -Destination $old
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-current-Setup-x64.exe' -Destination $next
  $result.oldHash = (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash
  $result.nextHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
  $result.oldExitCode = (Start-Process -FilePath $old -ArgumentList @('/S', '/currentuser', "/D=$installDir") -Wait -PassThru).ExitCode
  if ($result.oldExitCode -ne 0) { throw "Old install failed: $($result.oldExitCode)" }

  $oldApp = Start-Process -FilePath (Join-Path $installDir 'JJ Music.exe') -PassThru
  Start-Sleep -Seconds 10
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $oldData = Join-Path $installDir 'data'
  if (-not (Test-Path -LiteralPath $oldData)) { throw 'Old app did not create install-directory data' }
  $sentinel = Join-Path $oldData 'u0-sentinel.txt'
  Set-Content -LiteralPath $sentinel -Value 'PRESERVE_ME'
  $before = Inventory $oldData
  $result.beforeCount = $before.Count
  $result.before = $before
  $appDataTarget = Join-Path $env:APPDATA 'jj-music'
  $result.appDataTargetExistedBefore = Test-Path -LiteralPath $appDataTarget
  if ($result.appDataTargetExistedBefore) {
    $result.appDataTargetEntriesBefore = @(Get-ChildItem -LiteralPath $appDataTarget -Force |
      Select-Object -ExpandProperty Name)
  }
  $result.stage = 'before-upgrade'
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'upgrade-before.json')

  $nextProcess = Start-Process -FilePath $next -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
  for ($second = 0; $second -lt 120; $second += 2) {
    Start-Sleep -Seconds 2
    $nextProcess.Refresh()
    $monitor = [ordered]@{
      elapsedSeconds = $second + 2
      installerExited = $nextProcess.HasExited
      installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
      migrationLog = [string](Get-Content -LiteralPath (Join-Path $env:APPDATA 'jj-music-u0-migration.log') -Raw -ErrorAction SilentlyContinue)
      appDataNames = @(Get-ChildItem -LiteralPath $env:APPDATA -Force -ErrorAction SilentlyContinue | Where-Object Name -like '*jj-music*' | Select-Object -ExpandProperty Name)
    }
    $monitor | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'upgrade-monitor.json')
    if ($nextProcess.HasExited) { break }
  }
  if (-not $nextProcess.HasExited) {
    $result.stage = 'installer-timeout'
    $result.installerTimedOut = $true
    Stop-Process -Id $nextProcess.Id -Force -ErrorAction SilentlyContinue
    throw 'New installer did not exit within 120 seconds'
  }
  $result.nextExitCode = $nextProcess.ExitCode
  $result.installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $result.migrationLog = [string](Get-Content -LiteralPath (Join-Path $env:APPDATA 'jj-music-u0-migration.log') -Raw -ErrorAction SilentlyContinue)
  $target = Join-Path $env:APPDATA 'jj-music'
  $result.target = $target
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.originalDataStillPresent = Test-Path -LiteralPath $oldData
  $result.migratedSentinel = Test-Path -LiteralPath (Join-Path $target 'u0-sentinel.txt')
  if ($result.migratedSentinel) {
    $after = Inventory $target
    $result.afterCount = $after.Count
    $result.sameHashes = ((@($before | ConvertTo-Json -Depth 5 -Compress) -join '') -eq
      (@($after | ConvertTo-Json -Depth 5 -Compress) -join ''))
  }
  $result.stage = 'upgraded'
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'upgrade-installed.json')
  if ($result.nextExitCode -eq 0 -and $result.marker -and $result.migratedSentinel) {
    $env:JJ_DEBUG_PORT = '37921'
    $env:JJ_ALLOW_DEBUG_PORT = '1'
    $newApp = Start-Process -FilePath (Join-Path $installDir 'JJ Music.exe') -PassThru
    $result.newAppReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 500
      $newApp.Refresh()
      if ($newApp.HasExited) { break }
      try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:37921/json/version' -TimeoutSec 1
        if ($response.Browser -like '*Chrome*') { $result.newAppReady = $true; break }
      } catch { }
    }
    $newApp.Refresh()
    $result.newAppExitedEarly = $newApp.HasExited
    $result.runningAppProcessCount = @(Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue).Count
    Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $result.installDataAfterNewStart = Test-Path -LiteralPath $oldData
    $result.migratedSentinelAfterNewStart = Test-Path -LiteralPath (Join-Path $target 'u0-sentinel.txt')
  }
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  $result.Remove('before')
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'upgrade.json')
}
