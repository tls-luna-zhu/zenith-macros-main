@echo off
REM Zenith Macros — start everything
REM  Window 1: Flask API (port 5000)
REM  Window 2: Next.js (port 3000, serves static site + checkout + affiliate)
cd /d "%~dp0"

start "Zenith API" cmd /k cd /d "%~dp0API" ^&^& python -m pip install -r requirements.txt -q ^&^& python api.py

timeout /t 2 /nobreak >nul

start "Zenith Website" cmd /k pushd "%~dp0website" ^&^& npm run dev

echo.
echo  Both windows started.
echo  Open: http://localhost:3000
echo.
