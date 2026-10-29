@echo off
setlocal
cd /d "%~dp0"

set "PORT=8123"
set "URL=http://127.0.0.1:%PORT%/"

where py >nul 2>nul
if not errorlevel 1 (
  start "Blossom in Hand server" cmd /k py -3 -m http.server %PORT% --bind 127.0.0.1
  goto open
)

where python >nul 2>nul
if not errorlevel 1 (
  start "Blossom in Hand server" cmd /k python -m http.server %PORT% --bind 127.0.0.1
  goto open
)

where node >nul 2>nul
if not errorlevel 1 (
  start "Blossom in Hand server" cmd /k node server.mjs %PORT%
  goto open
)

echo.
echo   No Python or Node.js found.
echo   Install Python 3 or Node.js, then double-click this file again.
echo   Or open this folder in VS Code and use the Live Server extension.
echo.
pause
exit /b 1

:open
timeout /t 2 /nobreak >nul
start "" "%URL%"
exit /b 0
