@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\u0-input\standard-postmortem.ps1
if errorlevel 1 (
  echo Postmortem failed with exit code %ERRORLEVEL%.
) else (
  echo Postmortem written to C:\u0-output\standard-postmortem.json.
)
pause
