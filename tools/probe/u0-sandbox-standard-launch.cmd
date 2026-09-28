@echo off
whoami > C:\Users\Public\Documents\standard-invoke-account.txt
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\u0-input\standard-invoke.ps1 > C:\Users\Public\Documents\standard-invoke-console.txt 2>&1
echo PowerShell exit code: %ERRORLEVEL% >> C:\Users\Public\Documents\standard-invoke-console.txt
