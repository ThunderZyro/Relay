@echo off
setlocal
cd /d "%~dp0"
title Relay Platform

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required.
  echo Install Node.js once, then reopen this file.
  pause
  exit /b 1
)

REM This launcher NEVER installs or downloads packages.
REM Keep this project's node_modules folder when applying source updates.
if not exist "node_modules\concurrently\package.json" goto deps_missing
if not exist "node_modules\vite\bin\vite.js" goto deps_missing
if not exist "node_modules\tsx\dist\cli.mjs" goto deps_missing
if not exist "node_modules\better-sqlite3\package.json" goto deps_missing

goto start_relay

:deps_missing
echo.
echo [ERROR] Relay dependencies are not present in this folder.
echo Start Relay.bat does NOT download or install anything.
echo.
echo For a new installation only, double-click "Install Dependencies.bat" once.
echo For updates, extract the new source OVER this same project folder and KEEP:
echo   - node_modules
echo   - .env
echo   - server data and uploads
 echo.
echo Do not create a fresh project folder for every source update.
pause
exit /b 1

:start_relay
if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  echo Created .env from .env.example. Review it before using Relay.
)

echo.
echo Relay dependencies found. No install or download will run.
echo Starting Relay Platform...
echo Keep this window open while using Relay.
echo Frontend: http://localhost:5173
echo API:      http://localhost:3001
echo.
call npm run dev
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" echo Relay stopped with exit code %EXITCODE%.
pause
exit /b %EXITCODE%
