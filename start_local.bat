@echo off
title ZenithMacros - Flask Auth Backend (localhost)

set ZENITH_SECRET_KEY=fe42c065744dd92c5386f257b778b2074a2e48231fef1cdfff78dfc20534e49d
set FLASK_ENV=development
set FLASK_DEBUG=1

cd /d "%~dp0backend"

echo [*] Seeding test license (skips if already exists)...
python seed_test.py

echo.
echo [*] Starting Flask on http://localhost:5000
echo     Press Ctrl+C to stop.
echo.

python -m flask --app wsgi:application run --host=127.0.0.1 --port=5000
