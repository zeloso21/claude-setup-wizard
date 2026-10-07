@echo off
setlocal
title Claude Code Setup Wizard
cd /d "%~dp0"
rem ---------------------------------------------------------------
rem  IMPORTANT: keep this file ASCII only (no Korean). cmd.exe breaks
rem  non-ASCII text in .bat files. All Korean guidance is shown in
rem  the browser (public\node-install.html and server.js pages).
rem ---------------------------------------------------------------
echo ==============================================
echo   Claude Code Setup Wizard
echo ==============================================
echo.
echo [1/2] Checking for Node.js ...

where node >nul 2>nul
if not errorlevel 1 goto run

rem Node.js may already be installed but not yet on PATH (right after install).
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    goto run
)

echo.
echo Node.js is not installed yet.
echo A help page (in Korean) is opening in your browser now.
start "" "%~dp0public\node-install.html"

where winget >nul 2>nul
if errorlevel 1 goto nowinget

echo.
echo Installing Node.js LTS with winget (the installer built into Windows).
echo Windows may ask "Do you want to allow this app to make changes?"
echo Please click "Yes". It can take 1 to 3 minutes. Please wait...
echo.
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    echo.
    echo Node.js is installed. Continuing...
    goto run
)
echo.
echo Node.js could not be installed automatically.
echo Please follow the help page in your browser, then run start.bat again.
echo.
pause
exit /b 1

:nowinget
echo.
echo Automatic install is not available on this PC (winget not found).
echo Please follow the help page in your browser, then run start.bat again.
echo.
pause
exit /b 1

:run
echo.
echo [2/2] Starting the wizard. Your browser will open in a few seconds.
echo Keep THIS window open while you use the wizard.
echo Closing this window stops the wizard.
echo.
node "%~dp0server.js"
if errorlevel 1 pause
