param([switch]$SkipOldRun)

$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0AllUsers'
New-Item -ItemType Directory -Path $resultDir, $caseDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'allusers-started.txt') -Value $result.time

function Find-InstallDir {
  $entry = Get-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'JJ Music*' } | Select-Object -First 1
  if (-not $entry) { throw 'All-users uninstall entry not found in HKLM' }
  if ($entry.UninstallString -notmatch '^"([^"]+Uninstall JJ Music\.exe)"') {
    throw "Unexpected uninstall string: $($entry.UninstallString)"
  }
  return Split-Path -Parent $Matches[1]
}

function Run-InstalledApp([string]$Path, [System.Management.Automation.PSCredential]$Credential, [bool]$RequireReady = $false) {
  $previousPort = $env:JJ_DEBUG_PORT
  $previousAllow = $env:JJ_ALLOW_DEBUG_PORT
  try {
    if ($RequireReady) {
      $env:JJ_DEBUG_PORT = '37921'
      $env:JJ_ALLOW_DEBUG_PORT = '1'
    }
    if ($Credential -and $RequireReady) {
      # Start-Process -Credential does not reliably pass the caller's custom
      # environment to the new logon. Set the probe variables inside it.
      $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        'C:\u0-input\standard-run.ps1', '-AppPath', ('"' + $Path + '"'))
      $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Credential $Credential -LoadUserProfile -PassThru
    } elseif ($Credential) {
      $process = Start-Process -FilePath $Path -Credential $Credential -LoadUserProfile -PassThru
    } else {
      $process = Start-Process -FilePath $Path -PassThru
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 500
      $process.Refresh()
      if ($process.HasExited) { break }
      if ($RequireReady) {
        try {
          $response = Invoke-RestMethod -Uri 'http://127.0.0.1:37921/json/version' -TimeoutSec 1
          if ($response.Browser -like '*Chrome*') { $ready = $true; break }
        } catch { }
      } else {
        if ($attempt -ge 19) { $ready = $true; break }
      }
    }
    Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    return $ready
  } finally {
    $env:JJ_DEBUG_PORT = $previousPort
    $env:JJ_ALLOW_DEBUG_PORT = $previousAllow
  }
}

function MusicFolders([string]$Root) {
  return @(Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(?i)jj|music' } |
    ForEach-Object {
      [ordered]@{
        path = $_.FullName
        fileCount = @(Get-ChildItem -LiteralPath $_.FullName -File -Recurse -Force -ErrorAction SilentlyContinue).Count
      }
    })
}

try {
  $old = Join-Path $caseDir 'Legacy.exe'
  $next = Join-Path $caseDir 'Next.exe'
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-0.2.0-Setup-x64.exe' -Destination $old
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-current-Setup-x64.exe' -Destination $next
  $result.oldHash = (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash
  $result.nextHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
  $result.envAppData = $env:APPDATA
  $result.envUserProfile = $env:USERPROFILE
  $result.oldExitCode = (Start-Process -FilePath $old -ArgumentList @('/S', '/allusers') -Wait -PassThru).ExitCode
  $installDir = Find-InstallDir
  $result.installDir = $installDir
  $appPath = Join-Path $installDir 'JJ Music.exe'
  $result.oldExePresent = Test-Path -LiteralPath $appPath
  $result.skipOldRun = [bool]$SkipOldRun
  if (-not $SkipOldRun) {
    $result.oldAdminAppAlive = Run-InstalledApp $appPath $null
    $result.oldAdminAppDataFiles = @(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'jj-music') -File -Recurse -ErrorAction SilentlyContinue).Count
  }
  $result.oldInstallDataPresent = Test-Path -LiteralPath (Join-Path $installDir 'data')

  try {
    $password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + 'aA1!') -AsPlainText -Force
    New-LocalUser -Name 'U0Standard' -Password $password -AccountNeverExpires | Out-Null
    $credential = [System.Management.Automation.PSCredential]::new('U0Standard', $password)
    if (-not $SkipOldRun) {
      $result.oldStandardAppAlive = Run-InstalledApp $appPath $credential
    }
    $standardData = 'C:\Users\U0Standard\AppData\Roaming\jj-music'
    $result.oldStandardAppDataFiles = @(Get-ChildItem -LiteralPath $standardData -File -Recurse -ErrorAction SilentlyContinue).Count
  } catch {
    $result.standardAccountError = $_.Exception.Message
  }

  $result.stage = 'before-upgrade'
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'allusers-before.json')
  $process = Start-Process -FilePath $next -ArgumentList @('/S', '/allusers') -PassThru
  if (-not $process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'New installer did not exit within 120 seconds'
  }
  $result.nextExitCode = $process.ExitCode
  $result.installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $result.oldInstallDataAfterUpgrade = Test-Path -LiteralPath (Join-Path $installDir 'data')
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.newExePresent = Test-Path -LiteralPath $appPath
  if ($result.nextExitCode -eq 0 -and $result.marker) {
    $result.newAdminAppReady = Run-InstalledApp $appPath $null $true
    $result.newAdminAppDataFiles = @(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'jj-music') -File -Recurse -ErrorAction SilentlyContinue).Count
    $result.adminMusicFolders = MusicFolders $env:APPDATA
    $result.programDataMusicFolders = MusicFolders $env:ProgramData
    $result.newInstallDataAfterAdminStart = Test-Path -LiteralPath (Join-Path $installDir 'data')
    if ($credential) {
      try {
        $result.newStandardAppReady = Run-InstalledApp $appPath $credential $true
        $result.newStandardAppDataFiles = @(Get-ChildItem -LiteralPath $standardData -File -Recurse -ErrorAction SilentlyContinue).Count
        $result.standardMusicFolders = MusicFolders 'C:\Users\U0Standard\AppData\Roaming'
      } catch {
        $result.newStandardAccountError = $_.Exception.Message
      }
    }
  }
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'allusers.json')
}
