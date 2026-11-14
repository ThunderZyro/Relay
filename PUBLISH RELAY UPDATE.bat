@echo off
setlocal
cd /d "%~dp0"
title Publish Relay Desktop Update

echo This publishes a NEW Relay Desktop version to GitHub Releases.
echo The GitHub token is only used by this publishing process.
echo.
if "%GH_TOKEN%"=="" (
  echo GH_TOKEN is not set. Set it in this PowerShell session first:
  echo   $env:GH_TOKEN = "YOUR_TOKEN"
  echo.
  pause
  exit /b 1
)

if "%RELAY_GITHUB_OWNER%"=="" set RELAY_GITHUB_OWNER=ThunderZyro
if "%RELAY_GITHUB_REPO%"=="" set RELAY_GITHUB_REPO=Relay

call npm run desktop:publish
if errorlevel 1 goto failed

echo.
echo Relay desktop update release published.
pause
exit /b 0

:failed
echo Publish failed. Check the build output and GitHub token permissions.
pause
exit /b 1
