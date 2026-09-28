param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0StandardInstall'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'standard-installer-started.txt') -Value $result.time

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
  $appPath = Join-Path $installDir 'JJ Music.exe'
  Start-Process -FilePath $appPath | Out-Null
  Start-Sleep -Seconds 10
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $oldData = Join-Path $installDir 'data'
  if (-not (Test-Path -LiteralPath $oldData)) { throw 'Old app did not create shared data' }
  $sentinel = Join-Path $oldData 'u0-standard-sentinel.txt'
  [System.IO.File]::WriteAllText($sentinel, 'PRESERVE_ME')
  $result.sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
  $result.stage = 'before-standard-launch'
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'standard-installer-before.json')

  if ($PrepareOnly) {
    $result.stage = 'ready-for-interactive-standard-launch'
    return
  }

  $password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + 'aA1!') -AsPlainText -Force
  New-LocalUser -Name 'U0Standard' -Password $password -AccountNeverExpires | Out-Null
  $credential = [System.Management.Automation.PSCredential]::new('U0Standard', $password)
  try {
    $process = Start-Process -FilePath $next -ArgumentList @('/S', '/allusers') -Credential $credential -LoadUserProfile -PassThru
    if ($process.WaitForExit(90000)) {
      $result.standardSetupExited = $true
      $result.standardSetupExitCode = $process.ExitCode
    } else {
      $result.standardSetupExited = $false
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {
    $result.standardLaunchError = $_.Exception.Message
  }
  $result.installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $result.oldExePreserved = Test-Path -LiteralPath $appPath
  $result.oldDataPreserved = Test-Path -LiteralPath $oldData
  $result.sentinelPreserved = (Test-Path -LiteralPath $sentinel) -and
    ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -eq $result.sentinelHash)
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $resultDir 'standard-installer.json')
}
