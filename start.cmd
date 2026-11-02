@echo off
cd /d "%~dp0"

set NODE=node
if exist "tools\node\node.exe" set NODE=tools\node\node.exe

echo ============================================
echo   DaFeiYu - Launcher
echo ============================================
echo.
echo   Panel: http://127.0.0.1:8787
echo   Close this window / Ctrl+C to stop all.
echo.

if not exist ".env" (
  echo [!] .env not found, creating from template...
  copy ".env.example" ".env" >nul
  echo [!] Edit .env and fill LLM_API_KEY first.
  pause
  exit /b 1
)

"%NODE%" launcher.js %*

echo.
echo [launcher exited]
pause