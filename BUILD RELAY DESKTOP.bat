@echo off
setlocal
cd /d "%~dp0"
title Build Relay Desktop Installer

echo =============================================
echo       BUILD RELAY DESKTOP - WINDOWS x64
echo =============================================
echo.
if not exist "node_modules\electron-builder\cli.js" (
  echo Desktop build tools are not installed yet.
  echo Run SETUP DESKTOP BUILDER.bat once, then run this file again.
  pause
  exit /b 1
)

echo.
echo Relay Desktop connects to the same hosted Relay website as everyone else.
echo.
call npm run desktop:build:win
if errorlevel 1 goto failed

echo.
echo SUCCESS. Your installer is in release\desktop\
echo All desktop users will use the same hosted accounts and conversations.
explorer "%CD%\release\desktop"
pause
exit /b 0

:failed
echo.
echo The build failed. Read the error above and see README-DESKTOP.md.
pause
exit /b 1
