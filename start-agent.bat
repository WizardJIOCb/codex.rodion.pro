@echo off
setlocal
cd /d "%~dp0"

if not exist "data" mkdir "data"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-vscode-bridge.ps1" -SkipBuild
if errorlevel 1 (
  echo Failed to prepare VS Code bridge.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=(Resolve-Path '.').Path; " ^
  "$running=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*apps/agent-windows/dist/index.js*' -and $_.CommandLine -like '*apps/agent-windows/agent.config.json*' }; " ^
  "$parents=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*scripts\run-agent.ps1*' }; " ^
  "if ($running) { Write-Host ('Restarting existing Codex agent PID: ' + (($running | ForEach-Object ProcessId) -join ', ')); $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1 }; " ^
  "if ($parents) { $parents | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; " ^
  "$out=Join-Path $root 'data\prod-agent.log'; $err=Join-Path $root 'data\prod-agent.err.log'; " ^
  "$script=Join-Path $root 'scripts\run-agent.ps1'; " ^
  "$p=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$script) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru; " ^
  "Write-Host ('Codex agent started. PID: ' + $p.Id); Write-Host ('Logs: ' + $out);"

pause
