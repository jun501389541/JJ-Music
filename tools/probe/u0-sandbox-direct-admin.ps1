$ErrorActionPreference = 'Stop'
$result = [ordered]@{ time = (Get-Date -Format o); stage = 'started' }
$installDir = 'C:\Program Files\JJ Music'
$sentinel = Join-Path $installDir 'data\u0-standard-sentinel.txt'
$next = 'C:\U0StandardInstall\Next.exe'
try {
  $result.setupHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
  $result.sentinelHashBefore = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
  $result.setupExitCode = (Start-Process -FilePath $next -ArgumentList @('/S', '/allusers') -Wait -PassThru).ExitCode
  $result.oldExePreserved = Test-Path -LiteralPath (Join-Path $installDir 'JJ Music.exe')
  $result.oldDataPreserved = Test-Path -LiteralPath (Join-Path $installDir 'data')
  $result.sentinelHashAfter = [string](Get-FileHash -LiteralPath $sentinel -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
  $result.sentinelUnchanged = $result.sentinelHashAfter -eq $result.sentinelHashBefore
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.initLog = [string](Get-Content -LiteralPath (Join-Path $env:TEMP 'jj-music-u0-init.log') -Raw -ErrorAction SilentlyContinue)
  $result.stage = 'complete'
} catch {
  $result.stage = 'failed'
  $result.error = $_.Exception.Message
} finally {
  $result.timeFinished = Get-Date -Format o
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'C:\u0-output\direct-admin.json' -Encoding UTF8
}
