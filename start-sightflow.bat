@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Starting SightFlow Desktop Agent...
npm run dev
echo.
echo SightFlow has exited. Press any key to close this window.
pause >nul
