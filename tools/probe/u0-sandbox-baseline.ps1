$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0Case'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $resultDir 'started.txt') -Value (Get-Date -Format o)

$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
try {
  $installer = Join-Path $caseDir 'Legacy-0.2.0-Setup.exe'
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-0.2.0-Setup-x64.exe' -Destination $installer
  $result.installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
  $installDir = Join-Path $caseDir 'Installed'
  $process = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$installDir") -Wait -PassThru
  $result.installerExitCode = $process.ExitCode
  $result.installDir = $installDir
  $result.exePresent = Test-Path -LiteralPath (Join-Path $installDir 'JJ Music.exe')
  $result.afterInstallFiles = @(Get-ChildItem -LiteralPath $installDir -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  $result.registry = @(Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*JJ Music*' } |
    Select-Object DisplayName, InstallLocation, UninstallString)
  $result.stage = 'installed'
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $resultDir 'intermediate.json')

  if ($result.exePresent) {
    $appProcess = Start-Process -FilePath (Join-Path $installDir 'JJ Music.exe') -PassThru
    Start-Sleep -Seconds 15
    $result.appPid = $appProcess.Id
    $result.appExited = $appProcess.HasExited
    if (-not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue }
  }
  $result.installedDataFiles = @(Get-ChildItem -LiteralPath (Join-Path $installDir 'data') -File -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($installDir.Length + 1) })
  $appData = Join-Path $env:APPDATA 'jj-music'
  $result.appDataDir = $appData
  $result.appDataFiles = @(Get-ChildItem -LiteralPath $appData -File -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($appData.Length + 1) })
  $result.pointerInInstallDir = Test-Path -LiteralPath (Join-Path $installDir 'data-location.json')
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  $result.timeFinished = (Get-Date -Format o)
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $resultDir 'baseline.json')
}
