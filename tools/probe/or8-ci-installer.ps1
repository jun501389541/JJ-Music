# Real NSIS execution is restricted to disposable GitHub-hosted Windows runners.
# Never launch the player: profile checks compare installer effects byte for byte.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Keep this guard before filesystem writes, downloads, registry reads or processes.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'CI_ONLY_REFUSAL: requires a disposable GitHub-hosted Windows runner'
}
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE -or -not $env:APPDATA) {
  throw 'CI_ONLY_REFUSAL: runner paths are unavailable'
}

function Assert-NoApp {
  if (@(Get-Process -Name 'JJ Music', 'jj-music' -ErrorAction SilentlyContinue).Count) {
    throw 'Refusing to install while any JJ Music process exists; no process will be stopped'
  }
}
function Assert-RegularDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Expected a regular directory: $Path"
  }
}
function Profile-Inventory([string]$Path) {
  $folder = Get-Item -LiteralPath $Path -Force
  if (-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Expected a regular profile directory: $Path"
  }
  $lines = [Collections.Generic.List[string]]::new()
  function Visit([string]$Directory, [string]$Relative) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Profile contains a link' }
      $name = if ($Relative) { "$Relative/$($entry.Name)" } else { $entry.Name }
      if ($entry.PSIsContainer) { Visit $entry.FullName $name }
      else { $lines.Add("$name|$($entry.Length)|$((Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash)") }
    }
  }
  Visit $Path ''
  # Emit individual strings. Callers collect them with @(...); wrapping this
  # array with unary comma would make Compare-Object compare array objects.
  $lines | Sort-Object
}

function Candidate-Version([object]$Value) {
  if ($Value -isnot [string] -or $Value -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Candidate package version must be a stable major.minor.patch SemVer'
  }
  # NSIS/Windows file versions also require bounded integer components.
  $parsed = $null
  if (-not [version]::TryParse($Value, [ref]$parsed) -or $parsed -le [version]'0.4.2') {
    throw 'Candidate package version must be newer than official baseline 0.4.2'
  }
  return $Value
}

Assert-NoApp
$profilePath = Join-Path $env:APPDATA 'jj-music'
if (Test-Path -LiteralPath $profilePath) { throw 'Refusing to touch an existing JJ Music profile' }
foreach ($registry in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)) {
  if (@(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object {
    $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'JJ Music*'
  }).Count) { throw 'Refusing to touch an existing JJ Music installation registration' }
}
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
$candidateVersion = Candidate-Version $package.version
$candidate = Join-Path $workspace "release/JJ-Music-$candidateVersion-Setup-x64.exe"
if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
  throw "Candidate Setup is missing for package $candidateVersion"
}
$tempRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
Assert-RegularDirectory $tempRoot
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot ('or8-installer-' + [guid]::NewGuid().ToString('D'))))
if ((Split-Path -Parent $root) -ine $tempRoot.TrimEnd('\') -or (Test-Path -LiteralPath $root)) {
  throw 'Refusing a non-owned installer workspace'
}
New-Item -ItemType Directory -Path $root | Out-Null
Set-Content -LiteralPath (Join-Path $root 'owner.txt') -Value "OR8 synthetic CI fixture $env:GITHUB_RUN_ID"
$reportPath = Join-Path $root 'report.json'
if ($env:GITHUB_OUTPUT) { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "report-dir=$root" }
$report = [ordered]@{ status = 'started'; root = $root; profile = $profilePath; checks = @(); started = (Get-Date -Format o) }
$installDir = Join-Path $root 'Installed'
$appExe = Join-Path $installDir 'JJ Music.exe'
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$env:TEMP = Join-Path $root 'temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP | Out-Null

function Record([string]$Stage, [object]$Evidence) {
  $report.checks += [ordered]@{ stage = $Stage; evidence = $Evidence; time = (Get-Date -Format o) }
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
  Write-Host "OR8 installer: $Stage"
}
function Run-Installer([string]$File, [string]$Stage, [string]$Arguments) {
  Assert-NoApp
  # No Kill/Stop-Process fallback: a hang fails the job and the runner is discarded.
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(180000)) { throw "$Stage exceeded 180 seconds; runner must be discarded" }
  $process.Refresh()
  Record $Stage @{ exitCode = $process.ExitCode }
  if ($process.ExitCode -ne 0) { throw "$Stage failed: $($process.ExitCode)" }
  Assert-NoApp
}
function Assert-Installed([string]$Version, [string]$Stage) {
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) { throw "$Stage missing executable" }
  $actual = [Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion
  if ($actual -cne $Version) { throw "$Stage version mismatch: $actual" }
  $marker = Join-Path $installDir 'resources/nsis-install.marker'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw "$Stage missing NSIS marker" }
  if ((Get-FileHash -LiteralPath $marker).Hash -ne (Get-FileHash -LiteralPath (Join-Path $workspace 'build/nsis-install.marker')).Hash) {
    throw "$Stage NSIS marker contents differ"
  }
  Record $Stage @{ version = $actual; exeSHA256 = (Get-FileHash -LiteralPath $appExe).Hash; marker = $true }
}
function Assert-Profile([string]$Stage) {
  $actual = @(Profile-Inventory $profilePath)
  if (@(Compare-Object -ReferenceObject $script:expectedProfile -DifferenceObject $actual).Count) {
    throw "$Stage changed the synthetic profile"
  }
  Record $Stage @{ inventory = $actual }
}

try {
  Record 'candidate-input' @{ sha256 = (Get-FileHash -LiteralPath $candidate).Hash }
  $old = Join-Path $root 'JJ-Music-0.4.2-Setup-x64.exe'
  Invoke-WebRequest -Uri 'https://github.com/jun501389541/JJ-Music/releases/download/v0.4.2/JJ-Music-0.4.2-Setup-x64.exe' -OutFile $old
  $oldHash = (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($oldHash -cne '7f0af318dff6730fca60399baffbd1745ebc82647435aad26ba07e66ab0d4f57') {
    throw 'Official 0.4.2 Setup SHA256 mismatch'
  }
  Record 'official-old-input' @{ sha256 = $oldHash }
  Run-Installer $candidate 'fresh-candidate-install' "/S /currentuser /D=$installDir"
  Assert-Installed $candidateVersion 'fresh-candidate-installed'
  if (Test-Path -LiteralPath $profilePath) { throw 'Installer unexpectedly created profile before synthetic seeding' }
  New-Item -ItemType Directory -Path (Join-Path $profilePath 'library') | Out-Null
  Set-Content -LiteralPath (Join-Path $profilePath 'settings.json') -Encoding utf8 -Value '{"theme":"dark","volume":0.37,"allowBuiltinOnlineSearch":false,"libraryFolders":[],"minimizeToTray":false}'
  Set-Content -LiteralPath (Join-Path $profilePath 'playlists.json') -Encoding utf8 -Value '{"version":1,"playlists":[{"id":"or8-ci","name":"Synthetic installer acceptance","createdAt":1}],"items":{"or8-ci":[]}}'
  @{ entries = @(@{ trackId = 'or8-ci-track'; kind = 'lyric'; name = 'Synthetic'; singer = 'CI'; path = (Join-Path $root 'synthetic.mp3'); lyric = '[00:00.00] synthetic pending choice'; tlyric = 'synthetic translation'; synced = $true; origin = 'remote'; at = 1 }); dismissed = @() } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $profilePath 'library/pending-assets.json') -Encoding utf8
  $script:expectedProfile = @(Profile-Inventory $profilePath)
  Record 'synthetic-profile-seeded' @{ inventory = $script:expectedProfile }
  # Run the actual uninstall logic in-place, avoiding its asynchronous temp copy.
  # _?= must be last and unquoted in NSIS's argument string.
  $uninstaller = Join-Path $installDir 'Uninstall JJ Music.exe'
  Run-Installer $uninstaller 'candidate-uninstall-keep-data' "/S /currentuser /KEEP_APP_DATA _?=$installDir"
  if (Test-Path -LiteralPath $appExe) { throw 'Candidate uninstall left the app executable' }
  Assert-Profile 'profile-after-uninstall'
  Run-Installer $old 'official-old-install' "/S /currentuser /D=$installDir"
  Assert-Installed '0.4.2' 'official-old-installed'
  Assert-Profile 'profile-after-old-install'
  Run-Installer $candidate 'same-path-candidate-upgrade' "/S /currentuser /D=$installDir"
  Assert-Installed $candidateVersion 'candidate-upgraded'
  Assert-Profile 'profile-after-upgrade'
  $report.status = 'passed'
} catch {
  $report.status = 'failed'
  $report.error = $_.Exception.Message
  throw
} finally {
  $report.finished = Get-Date -Format o
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
  foreach ($name in @('jj-music-u0-installer.log', 'jj-music-u0-init.log')) {
    $log = Join-Path $env:TEMP $name
    if (Test-Path -LiteralPath $log -PathType Leaf) { Copy-Item -LiteralPath $log -Destination (Join-Path $root $name) }
  }
  $env:TEMP = $oldTemp
  $env:TMP = $oldTmp
  if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "OR8 real NSIS acceptance: **$($report.status)**. Evidence: CI installer artifact (report.json and migration logs). Player startup/listening and other-user/all-users migration are outside this check."
  }
  # Retain the owned fixture as evidence. GitHub disposes the entire runner.
}
