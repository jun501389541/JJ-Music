$ErrorActionPreference = 'Stop'
$resultDir = 'C:\Users\Public\Documents'
$result = [ordered]@{
  stage = 'started'
  time = (Get-Date -Format o)
  account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}
Set-Content -LiteralPath (Join-Path $resultDir 'standard-interactive-started.txt') -Value $result.time
try {
  $next = 'C:\U0StandardInstall\Next.exe'
  $result.setupHash = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash
  $process = Start-Process -FilePath $next -ArgumentList @('/S', '/allusers') -Verb RunAs -PassThru
  if (-not $process.WaitForExit(120000)) {
    $result.setupTimedOut = $true
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  } else {
    $result.setupExitCode = $process.ExitCode
  }
} catch {
  $result.launchError = $_.Exception.Message
} finally {
  $installDir = 'C:\Program Files\JJ Music'
  $oldData = Join-Path $installDir 'data'
  $sentinel = Join-Path $oldData 'u0-standard-sentinel.txt'
  $result.oldExePreserved = Test-Path -LiteralPath (Join-Path $installDir 'JJ Music.exe')
  $result.oldDataPreserved = Test-Path -LiteralPath $oldData
  $result.sentinelPreserved = Test-Path -LiteralPath $sentinel
  $result.marker = Test-Path -LiteralPath (Join-Path $installDir 'resources\nsis-install.marker')
  $result.timeFinished = Get-Date -Format o
  $result.stage = 'complete'
  try {
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resultDir 'standard-interactive.json') -Encoding UTF8
  } catch {
    Write-Host "Could not write result: $($_.Exception.Message)"
    $result | ConvertTo-Json -Depth 5 | Write-Host
  }
}
