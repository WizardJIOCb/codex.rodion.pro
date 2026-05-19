@echo off
setlocal

set "ROOT=%~dp0"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=dev"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

if /I "%MODE%"=="--help" goto :help
if /I "%MODE%"=="help" goto :help
if /I "%MODE%"=="check" goto :check
if /I "%MODE%"=="dev" goto :dev
if /I "%MODE%"=="release" goto :release

echo Unknown mode: %MODE%
echo.
goto :help

:check
call :check_prereqs
exit /b %ERRORLEVEL%

:dev
call :check_prereqs
if errorlevel 1 exit /b %ERRORLEVEL%

cd /d "%ROOT%"
echo.
echo Installing workspace dependencies...
call corepack pnpm install
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Starting Codex Agent native app in dev mode...
call powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\stop-desktop-agent-dev-server.ps1"
if errorlevel 1 exit /b %ERRORLEVEL%
call powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\stop-legacy-agent-processes.ps1"
if errorlevel 1 exit /b %ERRORLEVEL%
call corepack pnpm --filter @cmc/desktop-agent tauri:dev
exit /b %ERRORLEVEL%

:release
call :check_prereqs
if errorlevel 1 exit /b %ERRORLEVEL%

cd /d "%ROOT%"
echo.
echo Installing workspace dependencies...
call corepack pnpm install
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Building Codex Agent native release...
call corepack pnpm --filter @cmc/desktop-agent tauri:build
if errorlevel 1 exit /b %ERRORLEVEL%

set "EXE=%ROOT%apps\desktop-agent\src-tauri\target\release\codex-desktop-agent.exe"
if exist "%EXE%" (
  echo.
  echo Starting %EXE%
  start "" "%EXE%"
  exit /b 0
)

echo.
echo Release build completed, but the exe was not found at:
echo %EXE%
echo Check apps\desktop-agent\src-tauri\target\release\bundle for installers.
exit /b 1

:check_prereqs
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required. Install it first: https://nodejs.org/
  exit /b 1
)

where corepack.cmd >nul 2>nul
if errorlevel 1 (
  echo Corepack is required and usually ships with Node.js LTS.
  echo Try reinstalling Node.js LTS: https://nodejs.org/
  exit /b 1
)

where cargo.exe >nul 2>nul
if errorlevel 1 (
  echo Rust toolchain is required for the native Tauri app.
  echo Install Rust from https://rustup.rs/ and reopen this terminal.
  exit /b 1
)

where rustc.exe >nul 2>nul
if errorlevel 1 (
  echo rustc.exe was not found. Install Rust from https://rustup.rs/ and reopen this terminal.
  exit /b 1
)

exit /b 0

:help
echo Usage:
echo   start-native-agent.bat          Starts native app in Tauri dev mode
echo   start-native-agent.bat dev      Starts native app in Tauri dev mode
echo   start-native-agent.bat release  Builds release exe and starts it
echo   start-native-agent.bat check    Checks Node/Corepack/Rust prerequisites
exit /b 0
