@echo off
net user U0Standard U0Std!2026 >nul
icacls C:\Users\Public\Documents /grant *S-1-5-32-545:(OI)(CI)M >nul
del C:\Users\Public\Documents\runas-ready.txt >nul 2>nul
echo Type password U0Std!2026 at the next prompt. Characters will be hidden.
runas /user:%COMPUTERNAME%\U0Standard "cmd /c C:\u0-input\runas-marker.cmd"
echo runas exit code: %ERRORLEVEL%
for /L %%N in (1,1,15) do (
  if exist C:\Users\Public\Documents\runas-ready.txt goto found
  timeout /t 1 /nobreak >nul
)
echo STANDARD ACCOUNT PROCESS DID NOT START. Report the runas error above.
pause
exit /b 1
:found
echo STANDARD ACCOUNT PROCESS STARTED AS:
type C:\Users\Public\Documents\runas-ready.txt
pause
