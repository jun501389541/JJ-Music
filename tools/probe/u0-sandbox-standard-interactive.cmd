@echo off
echo Preparing temporary U0 Sandbox accounts...
net user U0Standard U0Std!2026 /add >nul 2>nul
if errorlevel 1 net user U0Standard U0Std!2026 >nul
if errorlevel 1 goto failed
net user U0Admin U0Admin!2026 /add >nul
if errorlevel 1 net user U0Admin U0Admin!2026 >nul
net localgroup Administrators U0Admin /add >nul 2>nul
icacls C:\Users\Public\Documents /grant *S-1-5-32-545:(OI)(CI)M >nul
del C:\Users\Public\Documents\standard-interactive.json >nul 2>nul
del C:\Users\Public\Documents\standard-invoke-account.txt >nul 2>nul
del C:\Users\Public\Documents\standard-invoke-console.txt >nul 2>nul
echo.
echo Type this temporary Standard account password at the next prompt: U0Std!2026
echo If Windows requests administrator approval, choose a different account:
echo   .\U0Admin
echo   U0Admin!2026
echo.
runas /user:%COMPUTERNAME%\U0Standard "cmd /c C:\u0-input\standard-launch.cmd"
echo.
echo Waiting for the standard-account result, up to 150 seconds...
for /L %%N in (1,1,150) do (
  if exist C:\Users\Public\Documents\standard-interactive.json goto collect
  timeout /t 1 /nobreak >nul
)
echo No result appeared. Check C:\Users\Public\Documents\standard-interactive-started.txt.
if exist C:\Users\Public\Documents\standard-invoke-account.txt type C:\Users\Public\Documents\standard-invoke-account.txt
if exist C:\Users\Public\Documents\standard-invoke-console.txt type C:\Users\Public\Documents\standard-invoke-console.txt
if exist C:\Users\Public\Documents\standard-invoke-account.txt copy /Y C:\Users\Public\Documents\standard-invoke-account.txt C:\u0-output\standard-invoke-account.txt >nul
if exist C:\Users\Public\Documents\standard-invoke-console.txt copy /Y C:\Users\Public\Documents\standard-invoke-console.txt C:\u0-output\standard-invoke-console.txt >nul
goto done
:collect
copy /Y C:\Users\Public\Documents\standard-interactive.json C:\u0-output\standard-interactive.json
if errorlevel 1 (
  echo Copy failed; result remains in C:\Users\Public\Documents\standard-interactive.json.
) else (
  echo Result copied to C:\u0-output\standard-interactive.json.
)
:done
pause
exit /b 0
:failed
echo Could not prepare temporary Sandbox accounts.
pause
exit /b 1
