param([Parameter(Mandatory)][string]$AppPath)

$ErrorActionPreference = 'Stop'
$env:JJ_DEBUG_PORT = '37921'
$env:JJ_ALLOW_DEBUG_PORT = '1'
Start-Process -FilePath $AppPath | Out-Null
Start-Sleep -Seconds 25
