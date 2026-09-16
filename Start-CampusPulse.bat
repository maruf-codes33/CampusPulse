@echo off
setlocal
title CampusPulse local server
cd /d "%~dp0"

echo.
echo   Starting CampusPulse...
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON=py"
) else (
  set "PYTHON=python"
)

%PYTHON% -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo CampusPulse needs Python 3.10 or newer and an internet connection
  echo the first time it is started.
  pause
  exit /b 1
)

echo.
echo CampusPulse is ready at http://localhost:8000
echo Keep this window open while using the website.
start "" http://localhost:8000
%PYTHON% app.py
pause
