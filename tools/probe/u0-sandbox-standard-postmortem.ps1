$ErrorActionPreference = 'Stop'
$result = [ordered]@{ time = (Get-Date -Format o) }
$before = Get-Content -LiteralPath 'C:\u0-output\standard-installer-before.json' -Raw | ConvertFrom-Json
$result.accounts = @('WDAGUtilityAccount','U0Standard','U0Admin') | ForEach-Object {
  $name = $_
  $profile = Join-Path 'C:\Users' $name
  $data = Join-Path $profile 'AppData\Roaming\jj-music'
  $pointer = Join-Path $profile 'AppData\Roaming\.jj-music-data-location.json'
  $log = Join-Path $profile 'AppData\Local\Temp\jj-music-u0-installer.log'
  $initLog = Join-Path $profile 'AppData\Local\Temp\jj-music-u0-init.log'
  $migrationLog = Join-Path $profile 'AppData\Roaming\jj-music-u0-migration.log'
  [ordered]@{
    account = $name
    dataPresent = Test-Path -LiteralPath $data
    fileCount = @(Get-ChildItem -LiteralPath $data -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    sentinelPresent = Test-Path -LiteralPath (Join-Path $data 'u0-standard-sentinel.txt')
    pointerPresent = Test-Path -LiteralPath $pointer
    installerLog = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
    initLog = [string](Get-Content -LiteralPath $initLog -Raw -ErrorAction SilentlyContinue)
    migrationLog = [string](Get-Content -LiteralPath $migrationLog -Raw -ErrorAction SilentlyContinue)
  }
}
$result.programData = [ordered]@{
  dataPresent = Test-Path -LiteralPath 'C:\ProgramData\jj-music'
  fileCount = @(Get-ChildItem -LiteralPath 'C:\ProgramData\jj-music' -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  sentinelPresent = Test-Path -LiteralPath 'C:\ProgramData\jj-music\u0-standard-sentinel.txt'
}
$result.install = [ordered]@{
  dataPresent = Test-Path -LiteralPath 'C:\Program Files\JJ Music\data'
  marker = Test-Path -LiteralPath 'C:\Program Files\JJ Music\resources\nsis-install.marker'
  sentinelHash = [string](Get-FileHash -LiteralPath 'C:\Program Files\JJ Music\data\u0-standard-sentinel.txt' -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
  sentinelMatchesBefore = ((Get-FileHash -LiteralPath 'C:\Program Files\JJ Music\data\u0-standard-sentinel.txt' -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash -eq $before.sentinelHash)
}
$result.uninstallEntries = @(Get-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'JJ Music*' } |
  Select-Object DisplayName,UninstallString,InstallLocation)
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'C:\u0-output\standard-postmortem.json' -Encoding UTF8
