@echo off
setlocal
cd /d "%~dp0"
title Publish Relay Desktop Update

echo This publishes a NEW Relay Desktop version to GitHub Releases.
echo Configure RELAY_GITHUB_OWNER, RELAY_GITHUB_REPO and GH_TOKEN first.
echo.
if "%GH_TOKEN%"=="" (
  echo GH_TOKEN is not set. Create a GitHub token with permission to publish releases,
  echo then set it in this PowerShell session before running this file:
  echo   $env:GH_TOKEN = "YOUR_TOKEN"
  echo.
  pause
  exit /b 1
)
if "%RELAY_GITHUB_OWNER%"=="" (
  set /p RELAY_GITHUB_OWNER=GitHub username or organization: 
)
if "%RELAY_GITHUB_REPO%"=="" (
  set /p RELAY_GITHUB_REPO=GitHub repository name [relay-platform]: 
)
if "%RELAY_GITHUB_REPO%"=="" set RELAY_GITHUB_REPO=relay-platform
call npm run build
if errorlevel 1 goto failed
call npm run desktop:prepare
if errorlevel 1 goto failed
call npx electron-builder --config desktop/electron-builder.config.cjs --win nsis --x64 --publish always
if errorlevel 1 goto failed

echo.
echo Relay update release published. Existing desktop installs will detect it on their next update check.
pause
exit /b 0
:failed
echo Publish failed. Check the build output and GitHub token permissions.
pause
exit /b 1
