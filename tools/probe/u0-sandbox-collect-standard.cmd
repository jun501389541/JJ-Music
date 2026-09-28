@echo off
set "SOURCE=C:\Users\Public\Documents\standard-interactive.json"
set "TARGET=C:\u0-output\standard-interactive.json"
if not exist "%SOURCE%" (
  echo No result file at %SOURCE%
  pause
  exit /b 1
)
echo Result contents:
type "%SOURCE%"
echo.
echo Copying to mapped output...
copy /Y "%SOURCE%" "%TARGET%"
if errorlevel 1 (
  echo COPY FAILED. Please send the result text shown above.
) else (
  if exist "%TARGET%" (
    echo COPY VERIFIED: %TARGET%
  ) else (
    echo COPY RETURNED SUCCESS BUT TARGET IS NOT VISIBLE.
  )
)
pause
