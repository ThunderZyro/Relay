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

if "%RELAY_GITHUB_OWNER%"=="" (
  set /p RELAY_GITHUB_OWNER=GitHub username or organization for desktop updates: 
)
if "%RELAY_GITHUB_REPO%"=="" (
  set /p RELAY_GITHUB_REPO=GitHub release repository name: 
)
if "%RELAY_GITHUB_OWNER%"=="" goto no_updates
if "%RELAY_GITHUB_REPO%"=="" goto no_updates

echo.
echo Update feed: github.com/%RELAY_GITHUB_OWNER%/%RELAY_GITHUB_REPO%
echo.
call npm run build
if errorlevel 1 goto failed
call npm run desktop:prepare
if errorlevel 1 goto failed
call npx electron-builder --config desktop/electron-builder.config.cjs --win nsis --x64 --publish never
if errorlevel 1 goto failed

echo.
echo SUCCESS. Your installer is in release\desktop\
echo The installed app runs locally and does not require Node.js or npm.
echo For automatic release updates, configure a GitHub Releases repository as described in README-DESKTOP.md.
explorer "%CD%\release\desktop"
pause
exit /b 0

:failed
echo.
echo The build failed. Read the error above and see README-DESKTOP.md.
pause
exit /b 1

:no_updates
echo.
echo A GitHub owner and release repository are required so this installer knows where to check for updates.
echo Create an empty GitHub repository first, then run this builder again.
pause
exit /b 1
