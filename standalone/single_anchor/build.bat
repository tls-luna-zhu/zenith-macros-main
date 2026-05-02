@echo off
echo Building ZenithSingleAnchor.exe...
pip install pyinstaller keyboard mouse colorama requests -q
pyinstaller --onefile --name ZenithSingleAnchor --console ^
  --hidden-import=keyboard ^
  --hidden-import=mouse ^
  --hidden-import=colorama ^
  --uac-admin ^
  main.py
echo.
echo Done! Exe is at: dist\ZenithSingleAnchor.exe
pause
