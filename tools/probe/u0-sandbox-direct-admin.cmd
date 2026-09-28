@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\u0-input\direct-admin.ps1
if errorlevel 1 (
  echo Direct admin probe failed with exit code %ERRORLEVEL%.
) else (
  echo Result written to C:\u0-output\direct-admin.json.
)
pause
