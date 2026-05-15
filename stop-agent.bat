@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$procs=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*apps/agent-windows/dist/index.js*' }; " ^
  "if (-not $procs) { Write-Host 'Codex agent is not running.'; exit 0 }; " ^
  "$procs | ForEach-Object { Write-Host ('Stopping PID: ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " ^
  "Write-Host 'Codex agent stopped.';"

pause
