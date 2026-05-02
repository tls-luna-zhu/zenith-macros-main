@echo off
echo Building ZenithPearlCatch.exe...
pip install pyinstaller keyboard mouse colorama requests -q
pyinstaller --onefile --name ZenithPearlCatch --console ^
  --hidden-import=keyboard ^
  --hidden-import=mouse ^
  --hidden-import=colorama ^
  --uac-admin ^
  main.py
echo.
echo Done! Exe is at: dist\ZenithPearlCatch.exe
pause
