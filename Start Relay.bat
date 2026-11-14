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

if not exist "node_modules\concurrently\package.json" goto deps_missing
if not exist "node_modules\vite\bin\vite.js" goto deps_missing
if not exist "node_modules\tsx\dist\cli.mjs" goto deps_missing
goto check_database

:deps_missing
echo.
echo [ERROR] Relay dependencies are not present in this folder.
echo For a new installation, double-click "Install Dependencies.bat" once.
echo Do not delete node_modules when applying a source update.
pause
exit /b 1

:check_database
if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  echo Created .env. Open it and set DATABASE_URL before starting Relay.
)
if not exist ".env" goto database_missing
findstr /B /C:"DATABASE_URL=" .env >nul
if errorlevel 1 goto database_missing

echo.
echo Starting Relay in development mode...
echo Frontend: http://localhost:5173
echo API:      http://localhost:3001
echo.
call npm run dev
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" echo Relay stopped with exit code %EXITCODE%.
pause
exit /b %EXITCODE%

:database_missing
echo.
echo [ERROR] DATABASE_URL is missing from .env.
echo Relay now uses PostgreSQL for shared accounts, messages and servers.
echo Add your PostgreSQL connection string to .env, then start Relay again.
pause
exit /b 1
