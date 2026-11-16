@echo off
setlocal
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer first.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js was found, but npm is unavailable. Please repair the Node.js installation.
  pause
  exit /b 1
)
if not exist node_modules\playwright-core (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set "NODE_USE_SYSTEM_CA=1"
set "OPEN_BROWSER=1"
node scripts\start-background.mjs
if errorlevel 1 pause
