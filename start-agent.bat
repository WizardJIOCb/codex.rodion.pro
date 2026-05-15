@echo off
setlocal
cd /d "%~dp0"

if not exist "data" mkdir "data"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=(Resolve-Path '.').Path; " ^
  "$running=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*apps/agent-windows/dist/index.js*' -and $_.CommandLine -like '*apps/agent-windows/agent.config.json*' }; " ^
  "if ($running) { Write-Host ('Codex agent is already running. PID: ' + (($running | ForEach-Object ProcessId) -join ', ')); exit 0 }; " ^
  "$out=Join-Path $root 'data\prod-agent.log'; $err=Join-Path $root 'data\prod-agent.err.log'; " ^
  "$script=Join-Path $root 'scripts\run-agent.ps1'; " ^
  "$p=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$script) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru; " ^
  "Write-Host ('Codex agent started. PID: ' + $p.Id); Write-Host ('Logs: ' + $out);"

pause
