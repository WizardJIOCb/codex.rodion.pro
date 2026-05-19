$ErrorActionPreference = "Stop"

$connections = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
  exit 0
}

foreach ($connection in $connections) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
  $commandLine = ""
  if ($process -and $process.CommandLine) {
    $commandLine = $process.CommandLine
  }
  $isDesktopAgentVite =
    $commandLine -like "*apps\desktop-agent*" -and
    $commandLine -like "*vite*" -and
    $commandLine -like "*--port 1420*"

  if (-not $isDesktopAgentVite) {
    Write-Error "Port 1420 is busy by PID $($connection.OwningProcess): $commandLine"
    exit 1
  }

  Stop-Process -Id $connection.OwningProcess -Force
  Write-Host "Stopped previous desktop-agent Vite server PID $($connection.OwningProcess)"
}
