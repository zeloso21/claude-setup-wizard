@echo off
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on this computer.
    echo.
    echo Trying to install it automatically using winget...
    where winget >nul 2>nul
    if errorlevel 1 (
        echo winget is not available. Please install Node.js manually.
        echo Open https://nodejs.org and download the LTS version.
        echo After installing, run this file again.
        pause
        exit /b 1
    )
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    echo.
    echo Node.js install attempted. Please close this window, then run start.bat again.
    pause
    exit /b 0
)

node "%~dp0server.js"
pause
