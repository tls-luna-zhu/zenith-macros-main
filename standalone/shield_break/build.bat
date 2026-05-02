@echo off
echo Building ZenithShieldBreak.exe...
pip install pyinstaller keyboard mouse colorama requests -q
pyinstaller --onefile --name ZenithShieldBreak --console ^
  --hidden-import=keyboard ^
  --hidden-import=mouse ^
  --hidden-import=colorama ^
  --uac-admin ^
  main.py
echo.
echo Done! Exe is at: dist\ZenithShieldBreak.exe
pause
