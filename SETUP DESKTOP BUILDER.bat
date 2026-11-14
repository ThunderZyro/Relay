@echo off
setlocal
cd /d "%~dp0"
title Relay Desktop Builder Setup

echo =============================================
echo   RELAY DESKTOP BUILDER - SETUP OPTIONS
echo =============================================
echo.
echo RECOMMENDED: Build the Windows installer on GitHub Actions.
echo This avoids downloading Electron and the build dependencies onto your PC.
echo You only download the finished Relay installer.
echo.
echo To use the cloud build:
echo   1. Upload this project's CONTENTS to a GitHub repository.
echo   2. Keep the .github folder.
echo   3. Run Actions → Build Relay Desktop when you are ready to publish a desktop release.
echo   4. Open Actions and download the installer from the release.
echo.
echo Local building is optional and downloads the Electron packaging tools once.
echo.
choice /C YN /N /M "Do you still want to install the local Windows build tools? [Y/N] "
if errorlevel 2 goto cloud

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required only on the PC that builds RelaySetup.exe locally.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js with npm, then retry.
  pause
  exit /b 1
)
node -e "const v=Number(process.versions.node.split('.')[0]);if(v<22)process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)

echo Installing the local builder. This is optional and happens once per folder.
echo npm will reuse its existing package cache where possible.
echo.
npm install --prefer-offline --no-audit --no-fund
if errorlevel 1 (
  echo Setup failed. The npm cache is preserved; do not clear it.
  pause
  exit /b 1
)
echo.
echo Local setup complete. You can now run BUILD RELAY DESKTOP.bat. The installed app uses the shared online Relay service.
pause
exit /b 0

:cloud
echo.
echo Great. No local npm installation is needed for the cloud build.
echo Read README-DESKTOP.md, then upload the project contents to GitHub.
start "" notepad.exe "%CD%\README-DESKTOP.md"
exit /b 0
