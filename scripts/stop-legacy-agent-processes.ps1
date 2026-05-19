$ErrorActionPreference = "Stop"

$agentNodes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*apps/agent-windows/dist/index.js*"
  }

$parentIds = @($agentNodes | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique)

foreach ($process in $agentNodes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped legacy Node agent PID $($process.ProcessId)"
}

$legacyLaunchers = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -in @("powershell.exe", "cmd.exe") -and (
      $_.CommandLine -like "*scripts\run-agent.ps1*" -or
      $_.CommandLine -like "*start-agent.bat*"
    )
  }

foreach ($process in $legacyLaunchers) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped legacy agent launcher PID $($process.ProcessId)"
}

foreach ($parentId in $parentIds) {
  if (-not $parentId -or $parentId -eq $PID) {
    continue
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
  if (-not $process) {
    continue
  }
  if ($process.Name -in @("powershell.exe", "cmd.exe") -and (
      $process.CommandLine -like "*scripts\run-agent.ps1*" -or
      $process.CommandLine -like "*start-agent.bat*"
    )) {
    Stop-Process -Id $parentId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped legacy agent parent PID $parentId"
  }
}
