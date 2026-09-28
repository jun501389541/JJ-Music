$ErrorActionPreference = 'Stop'
$resultDir = 'C:\u0-output'
$caseDir = 'C:\U0Content'
$installDir = Join-Path $caseDir 'Installed'
$audioDir = Join-Path $caseDir 'Audio'
New-Item -ItemType Directory -Path $resultDir, $caseDir, $audioDir -Force | Out-Null
$result = [ordered]@{ stage = 'started'; time = (Get-Date -Format o) }
Set-Content -LiteralPath (Join-Path $resultDir 'content-started.txt') -Value $result.time

function Write-Json([string]$Path, $Value) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
}

function Inventory([string]$Root) {
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    [ordered]@{
      relative = $_.FullName.Substring($Root.Length + 1)
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  } | Sort-Object relative)
}

function Write-Wav([string]$Path) {
  $stream = [System.IO.File]::Create($Path)
  try {
    $writer = [System.IO.BinaryWriter]::new($stream)
    $sampleBytes = 88200
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
    $writer.Write([uint32](36 + $sampleBytes))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
    $writer.Write([uint32]16)
    $writer.Write([uint16]1)
    $writer.Write([uint16]1)
    $writer.Write([uint32]44100)
    $writer.Write([uint32]88200)
    $writer.Write([uint16]2)
    $writer.Write([uint16]16)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
    $writer.Write([uint32]$sampleBytes)
    $writer.Write([byte[]]::new($sampleBytes))
    $writer.Flush()
  } finally { $stream.Dispose() }
}

try {
  $old = Join-Path $caseDir 'Legacy.exe'
  $next = Join-Path $caseDir 'Next.exe'
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-0.2.0-Setup-x64.exe' -Destination $old
  Copy-Item -LiteralPath 'C:\u0-input\JJ-Music-current-Setup-x64.exe' -Destination $next
  $result.oldHash = (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash
  $result.nextHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
  $result.oldExitCode = (Start-Process -FilePath $old -ArgumentList @('/S', '/currentuser', "/D=$installDir") -Wait -PassThru).ExitCode
  if ($result.oldExitCode -ne 0) { throw "Old install failed: $($result.oldExitCode)" }

  Start-Process -FilePath (Join-Path $installDir 'JJ Music.exe') | Out-Null
  Start-Sleep -Seconds 10
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $oldData = Join-Path $installDir 'data'
  if (-not (Test-Path -LiteralPath $oldData)) { throw 'Old app did not create install-directory data' }

  $wave = Join-Path $audioDir 'U0-fixture.wav'
  Write-Wav $wave
  $track = [ordered]@{
    id = 'u0-fixture-track'; path = $wave; name = 'U0 Fixture Track'; singer = 'Fixture Artist'
    albumName = 'Fixture Album'; duration = 1; size = (Get-Item $wave).Length
    mtimeMs = ([DateTimeOffset](Get-Item $wave).LastWriteTimeUtc).ToUnixTimeMilliseconds()
    sampleRate = 44100; channels = 1; codec = 'WAV'; lossless = $true
  }
  Write-Json (Join-Path $oldData 'settings.json') ([ordered]@{
    theme = 'light'; volume = 0.37; libraryFolders = @($audioDir)
    playlistOrder = @('u0-fixture-list')
  })
  Write-Json (Join-Path $oldData 'playlists.json') ([ordered]@{
    version = 1
    playlists = @(
      [ordered]@{ id='default'; name='Default'; source='local'; position=0 },
      [ordered]@{ id='favorites'; name='Favorites'; source='local'; position=1 },
      [ordered]@{ id='u0-fixture-list'; name='U0 Fixture Playlist'; source='local'; position=2 }
    )
    items = @{ 'u0-fixture-list' = @($track) }
  })
  Write-Json (Join-Path $oldData 'library\index.json') ([ordered]@{
    version = 5; folders = @($audioDir); tracks = @($track)
  })
  Write-Json (Join-Path $oldData 'sources\user_api.json') ([ordered]@{
    userApis = @([ordered]@{
      id='u0-fixture-source'; name='U0 Fixture Source'; description='Sandbox fixture'
      version='1.0.0'; author='U0'; homepage=''; allowShowUpdateAlert=$false
      script='/* @name U0 Fixture Source */'; enabled=$false
    })
  })
  [System.IO.File]::WriteAllText((Join-Path $oldData 'u0-sentinel.txt'), 'PRESERVE_ME')

  $before = Inventory $oldData
  $result.beforeCount = $before.Count
  $result.fixtureFilesPresent = @('settings.json','playlists.json','library\index.json','sources\user_api.json') |
    ForEach-Object { Test-Path -LiteralPath (Join-Path $oldData $_) }
  $result.audioHash = (Get-FileHash -LiteralPath $wave -Algorithm SHA256).Hash
  $result.stage = 'before-upgrade'
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'content-before.json')

  $process = Start-Process -FilePath $next -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
  if (-not $process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'New installer did not exit within 120 seconds'
  }
  $result.nextExitCode = $process.ExitCode
  $result.installerLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-installer.log') -Raw -ErrorAction SilentlyContinue)
  $target = Join-Path $env:APPDATA 'jj-music'
  $result.target = $target
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.oldDataPresent = Test-Path -LiteralPath $oldData
  if ($result.nextExitCode -ne 0 -or -not $result.marker) { throw "Upgrade failed: $($result.nextExitCode)" }
  $after = Inventory $target
  $result.afterCount = $after.Count
  $result.sameHashes = (($before | ConvertTo-Json -Depth 5 -Compress) -eq ($after | ConvertTo-Json -Depth 5 -Compress))
  $result.stage = 'before-first-new-run'
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'content-installed.json')

  $env:JJ_DEBUG_PORT = '37921'
  $env:JJ_ALLOW_DEBUG_PORT = '1'
  Start-Process -FilePath (Join-Path $installDir 'JJ Music.exe') | Out-Null
  & 'C:\u0-input\node.exe' 'C:\u0-input\content-cdp.mjs' (Join-Path $resultDir 'content-ui.json')
  $result.uiProbeExitCode = $LASTEXITCODE
  $ui = Get-Content -LiteralPath (Join-Path $resultDir 'content-ui.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $result.uiProbeOk = $ui.ok
  $result.uiResult = $ui.result
  if (-not $ui.ok -or $ui.result.dataDir -ne $target -or $ui.result.dataSource -ne 'appdata' -or
      $ui.result.theme -ne 'light' -or $ui.result.volume -ne 0.37 -or
      $ui.result.playlist.name -ne 'U0 Fixture Playlist' -or $ui.result.playlist.trackCount -ne 1 -or
      $ui.result.playlistItem -ne 'U0 Fixture Track' -or
      $ui.result.libraryTrack.name -ne 'U0 Fixture Track' -or
      $ui.result.libraryTrack.path -ne $wave -or
      $ui.result.source.name -ne 'U0 Fixture Source' -or $ui.result.source.enabled -ne $false) {
    throw 'Migrated content did not match the app bridge results'
  }
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
} finally {
  Get-Process -Name 'JJ Music' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDir 'content.json')
}
