@echo off
setlocal
cd /d "%~dp0"
set PORT=8000

echo ============================================
echo   Blockworld game server
echo   Local: http://localhost:%PORT%/
echo   Phone: http://[your-LAN-IP]:%PORT%/  (same Wi-Fi)
echo   Press Ctrl+C or close this window to stop.
echo ============================================
echo.

rem Open the browser 3 seconds later, after the server is up
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%/'"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %PORT%

echo.
echo Server stopped. Press any key to close this window.
pause >nul
