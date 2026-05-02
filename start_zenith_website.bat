@echo off
title Zenith Macros — Next.js (website)
cd /d "%~dp0website"
if not exist "package.json" (
  echo ERROR: website\package.json not found.
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo [*] npm install...
  call npm install
)
echo.
echo  [*] Next.js: http://localhost:3000
echo      API is proxied from /api/* to http://127.0.0.1:5000 (start_zenith_api.bat)
echo.
call npm run dev
pause
