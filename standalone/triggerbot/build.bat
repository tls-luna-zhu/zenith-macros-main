@echo off
echo Building ZenithTriggerbot.exe...
pip install pyinstaller keyboard mss pyautogui psutil pynput colorama requests -q
pyinstaller --onefile --name ZenithTriggerbot --console ^
  --hidden-import=keyboard ^
  --hidden-import=mss ^
  --hidden-import=pyautogui ^
  --hidden-import=psutil ^
  --hidden-import=pynput ^
  --hidden-import=pynput.mouse ^
  --hidden-import=pynput.keyboard ^
  --hidden-import=colorama ^
  --uac-admin ^
  main.py
echo.
echo Done! Exe is at: dist\ZenithTriggerbot.exe
pause
