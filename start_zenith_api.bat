@echo off
title Zenith Macros — API (API\api.py)
cd /d "%~dp0API"
if not exist "api.py" (
  echo ERROR: API\api.py not found.
  pause
  exit /b 1
)
echo [*] Installing Python dependencies...
python -m pip install -r requirements.txt -q
if errorlevel 1 (
  echo pip install failed.
  pause
  exit /b 1
)
echo.
echo  [*] Starting Flask: http://127.0.0.1:5000
echo      Load API\.env via python-dotenv (DISCORD_*, STRIPE_*, etc.)
echo      Discord redirect must match API\.env DISCORD_REDIRECT_URI, e.g.:
echo      http://localhost:3000/api/auth/discord/callback
echo      Open the site at: http://localhost:3000  (run start_zenith_website.bat)
echo.
python api.py
pause
