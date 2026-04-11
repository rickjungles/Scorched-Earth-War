@echo off
cd /d "%~dp0"

:: Check if node is available
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js not found. Install it from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if ws package is installed
if not exist "node_modules\ws" (
    echo Installing dependencies...
    npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

:: Start the server in a new window (stays open so you can see logs)
start "Scorched Earth Server" cmd /k "node server.js"

:: Give the server a moment to bind the port
timeout /t 2 /nobreak >nul

:: Open the game in the default browser
start "" "%~dp0index.html"
