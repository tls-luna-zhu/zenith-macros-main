@echo off
echo Building ZenithStunSlam.exe...
pip install pyinstaller keyboard mouse colorama requests -q
pyinstaller --onefile --name ZenithStunSlam --console ^
  --hidden-import=keyboard ^
  --hidden-import=mouse ^
  --hidden-import=colorama ^
  --uac-admin ^
  main.py
echo.
echo Done! Exe is at: dist\ZenithStunSlam.exe
pause
