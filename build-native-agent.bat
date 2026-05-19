@echo off
setlocal

set "ROOT=%~dp0"
set "OUT_DIR=%ROOT%dist-native"
set "EXE=%ROOT%apps\desktop-agent\src-tauri\target\release\codex-desktop-agent.exe"
set "OUT_EXE=%OUT_DIR%\CodexAgent.exe"

if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required. Install it first: https://nodejs.org/
  exit /b 1
)

where corepack.cmd >nul 2>nul
if errorlevel 1 (
  echo Corepack is required and usually ships with Node.js LTS.
  exit /b 1
)

where cargo.exe >nul 2>nul
if errorlevel 1 (
  echo Rust toolchain is required. Install Rust from https://rustup.rs/ and reopen this terminal.
  exit /b 1
)

cd /d "%ROOT%"

echo Installing workspace dependencies...
call corepack pnpm install
if errorlevel 1 exit /b %ERRORLEVEL%

echo Building native Codex Agent exe...
call corepack pnpm --filter @cmc/desktop-agent tauri:build
if errorlevel 1 exit /b %ERRORLEVEL%

if not exist "%EXE%" (
  echo Release exe was not found:
  echo %EXE%
  exit /b 1
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
copy /Y "%EXE%" "%OUT_EXE%" >nul
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo Built:
echo %OUT_EXE%
