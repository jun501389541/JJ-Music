$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0Conflict'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'conflict-started.txt') -Value $result.time

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
  $result.originalHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
  $target = Join-Path $env:APPDATA 'jj-music'
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  $conflict = Join-Path $target 'u0-sentinel.txt'
  Set-Content -LiteralPath $conflict -Value 'DIFFERENT_PROFILE'
  $result.conflictHash = (Get-FileHash -LiteralPath $conflict -Algorithm SHA256).Hash
  $result.stage = 'before-upgrade'
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'conflict-before.json')

  $process = Start-Process -FilePath $next -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
  if (-not $process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'New installer did not exit within 120 seconds'
  }
  $result.nextExitCode = $process.ExitCode
  $result.installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $result.oldExePreserved = Test-Path -LiteralPath (Join-Path $installDir 'JJ Music.exe')
  $result.oldSentinelPreserved = (Test-Path -LiteralPath $sentinel) -and
    ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -eq $result.originalHash)
  $result.conflictPreserved = (Test-Path -LiteralPath $conflict) -and
    ((Get-FileHash -LiteralPath $conflict -Algorithm SHA256).Hash -eq $result.conflictHash)
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
} finally {
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'conflict.json')
}
