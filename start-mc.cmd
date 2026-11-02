@echo off
cd /d "%~dp0"
chcp 65001 >nul

rem mc 已经挪到外面的产物目录里（Ano-产物\阿糯相关\mc）
set MCDIR=%~dp0..\Ano-产物\阿糯相关\mc
if not exist "%MCDIR%\bot.js" (
  echo 找不到 mc：%MCDIR%
  echo 如果你把「Ano-产物」挪到别处了，改这个 bat 里的 MCDIR
  pause
  exit /b 1
)

set NODE=node
if exist "%~dp0tools\node\node.exe" set NODE=%~dp0tools\node\node.exe

echo ============================================
echo   DaFeiYu - Minecraft Bot
echo ============================================
echo.

cd /d "%MCDIR%"
"%NODE%" bot.js %*

echo.
echo [exited]
pause
