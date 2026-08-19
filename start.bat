@echo off
title Claude Code Setup Wizard
echo ============================================
echo   Claude Code Setup Wizard - starting up
echo ============================================
echo.
echo Step 1 of 2: Checking whether Node.js is installed on this computer.
echo (Node.js is required both to run this wizard and to run Claude Code itself.)
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was NOT found on this computer.
    echo.
    echo This wizard will now try to install it automatically using "winget"
    echo ^(the official installer tool built into Windows 10/11^).
    echo A separate installer window may briefly appear on its own - that is normal,
    echo please just wait for it to finish.
    echo.
    where winget >nul 2>nul
    if errorlevel 1 (
        echo winget is not available on this computer, so it cannot be installed automatically.
        echo Please install Node.js manually instead, then come back:
        echo   1. Open https://nodejs.org in your web browser
        echo   2. Download and run the "LTS" version installer ^(click Next / Next / Finish^)
        echo   3. After it finishes, close this window and double-click start.bat again
        echo.
        pause
        exit /b 1
    )
    echo Installing Node.js now, this can take one to two minutes. Please wait...
    echo.
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    echo.
    echo ============================================
    echo   Node.js install finished.
    echo   IMPORTANT: please CLOSE this window now,
    echo   then double-click start.bat again so the
    echo   new installation can be detected properly.
    echo ============================================
    echo.
    pause
    exit /b 0
)

echo Node.js was found - good, moving on.
echo.
echo Step 2 of 2: Starting the setup wizard.
echo A browser window should open by itself in a few seconds.
echo If it does not open automatically, look below for a web address
echo starting with "http://127.0.0.1" and open that in your browser.
echo.
echo Please keep THIS black window open in the background while you use
echo the wizard in your browser - closing this window will stop the wizard.
echo From here on, all instructions will appear inside the browser window.
echo.
node "%~dp0server.js"
pause
