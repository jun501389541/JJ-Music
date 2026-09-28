$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0External'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'external-started.txt') -Value $result.time

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
  Set-Content -LiteralPath (Join-Path $oldData 'u0-stale.txt') -Value 'BACKUP_ME'

  $external = Join-Path $caseDir 'RelocatedData'
  New-Item -ItemType Directory -Path $external -Force | Out-Null
  $externalFile = Join-Path $external 'u0-external.txt'
  Set-Content -LiteralPath $externalFile -Value 'KEEP_EXTERNAL'
  $result.externalHashBefore = (Get-FileHash -LiteralPath $externalFile -Algorithm SHA256).Hash
  $legacyPointer = Join-Path $installDir 'data-location.json'
  @{ dir = $external } | ConvertTo-Json -Compress | Set-Content -LiteralPath $legacyPointer
  $result.legacyPointerHash = (Get-FileHash -LiteralPath $legacyPointer -Algorithm SHA256).Hash
  $result.stage = 'before-upgrade'
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'external-before.json')

  $process = Start-Process -FilePath $next -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
  if (-not $process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'New installer did not exit within 120 seconds'
  }
  $result.nextExitCode = $process.ExitCode
  $result.installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $newPointer = Join-Path $env:APPDATA '.jj-music-data-location.json'
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.newPointerPresent = Test-Path -LiteralPath $newPointer
  $result.newPointerMatches = $result.newPointerPresent -and
    ((Get-FileHash -LiteralPath $newPointer -Algorithm SHA256).Hash -eq $result.legacyPointerHash)
  $result.externalPreserved = (Test-Path -LiteralPath $externalFile) -and
    ((Get-FileHash -LiteralPath $externalFile -Algorithm SHA256).Hash -eq $result.externalHashBefore)
  $result.staleBackupPresent = Test-Path -LiteralPath (Join-Path $env:APPDATA 'jj-music-u0-legacy-backup\u0-stale.txt')
  if ($result.nextExitCode -eq 0 -and $result.marker -and $result.newPointerMatches) {
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
    $result.installDataAfterNewStart = Test-Path -LiteralPath $oldData
    $result.externalPreservedAfterNewStart = (Test-Path -LiteralPath $externalFile) -and
      ((Get-FileHash -LiteralPath $externalFile -Algorithm SHA256).Hash -eq $result.externalHashBefore)
    Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'external.json')
}
