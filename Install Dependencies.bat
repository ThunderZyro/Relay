@echo off
setlocal
cd /d "%~dp0"
title Relay Platform - One-time dependency setup

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Install Node.js 22 or newer first.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm included.
  pause
  exit /b 1
)

echo This is the one-time dependency setup for this project folder.
echo It downloads packages only when needed. Do NOT run it for normal launches.
echo Keep this folder's node_modules when applying future source updates.
echo.
call npm install
set "EXITCODE=%ERRORLEVEL%"
echo.
if "%EXITCODE%"=="0" (
  echo Dependencies installed. From now on, double-click "Start Relay.bat".
) else (
  echo [ERROR] Dependency installation failed with exit code %EXITCODE%.
)
pause
exit /b %EXITCODE%
