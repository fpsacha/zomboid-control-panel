@echo off
title Zomboid Control Panel (Source)
echo ============================================
echo   ZOMBOID CONTROL PANEL - Run from Source
echo ============================================
echo.
echo Checking for Node.js...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please download it from: https://nodejs.org
    echo.
    pause
    exit /b 1
)
echo Node.js found: 
node --version
echo.
echo Installing dependencies...
call npm run install:all
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo.
echo Building client...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to build client
    pause
    exit /b 1
)
echo.
echo ============================================
echo Starting server...
echo Open your browser to: http://localhost:3001
echo ============================================
echo.
start "" "http://localhost:3001"
npm start
pause
