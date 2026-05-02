@echo off
echo Building ZenithBreachSwap.exe...
pip install pyinstaller keyboard mouse colorama requests -q
pyinstaller --onefile --name ZenithBreachSwap --console ^
  --hidden-import=keyboard ^
  --hidden-import=mouse ^
  --hidden-import=colorama ^
  --uac-admin ^
  main.py
echo.
echo Done! Exe is at: dist\ZenithBreachSwap.exe
pause
