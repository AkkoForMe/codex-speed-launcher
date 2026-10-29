@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
set "SPEED_NODE=%~dp0runtime\node.exe"
if exist "%SPEED_NODE%" goto run_launcher
where.exe node >nul 2>nul
if errorlevel 1 goto missing_node
set "SPEED_NODE=node"
:run_launcher
"%SPEED_NODE%" "%~dp0src\cli.mjs" inspect %*
set "SPEED_EXIT=%ERRORLEVEL%"
goto finished
:missing_node
echo Node.js is missing. Extract the complete portable package, or install Node.js 22+.
set "SPEED_EXIT=1"
:finished
echo.
echo Inspection finished. Press any key to close this window.
pause >nul
exit /b %SPEED_EXIT%
