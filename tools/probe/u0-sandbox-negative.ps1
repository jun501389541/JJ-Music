$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0Negative'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'negative-started.txt') -Value $result.time
try {
  $installDir = Join-Path $caseDir 'Installed'
  $oldInstaller = Join-Path $caseDir 'Old.exe'
  $newInstaller = Join-Path $caseDir 'New.exe'
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-0.2.0-Setup-x64.exe' -Destination $oldInstaller
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-current-Setup-x64.exe' -Destination $newInstaller
  $result.oldHash = (Get-FileHash -LiteralPath $oldInstaller -Algorithm SHA256).Hash
  $result.newHash = (Get-FileHash -LiteralPath $newInstaller -Algorithm SHA256).Hash
  $result.oldExitCode = (Start-Process -FilePath $oldInstaller -ArgumentList @('/S', '/currentuser', "/D=$installDir") -Wait -PassThru).ExitCode
  if ($result.oldExitCode -ne 0) { throw "Old installer failed: $($result.oldExitCode)" }
  $sentinel = Join-Path $installDir 'data\u0-sentinel.txt'
  New-Item -ItemType Directory -Path (Split-Path $sentinel -Parent) -Force | Out-Null
  Set-Content -LiteralPath $sentinel -Value 'U0_KEEP_THIS_PROFILE'
  $result.sentinelBefore = Test-Path -LiteralPath $sentinel
  $result.stage = 'old-installed'
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'negative-intermediate.json')
  $result.newExitCode = (Start-Process -FilePath $newInstaller -ArgumentList @('/S', '/currentuser', "/D=$installDir") -Wait -PassThru).ExitCode
  $result.sentinelAfter = Test-Path -LiteralPath $sentinel
  $result.exeAfter = Test-Path -LiteralPath (Join-Path $installDir 'JJ Music.exe')
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'negative.json')
}
