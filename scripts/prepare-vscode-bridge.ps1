param(
  [switch]$SkipBuild,
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step([string]$Message) {
  Write-Host "[vscode-bridge] $Message"
}

function Find-CodeCommand {
  $Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\bin\code.cmd")
  ) | Where-Object { $_ }

  foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate) {
      return $Candidate
    }
  }

  $Command = Get-Command code.cmd -ErrorAction SilentlyContinue
  if ($Command) {
    return $Command.Source
  }

  $Command = Get-Command code -ErrorAction SilentlyContinue
  if ($Command) {
    return $Command.Source
  }

  return $null
}

function Test-VscodeBridge {
  $PipeName = "codex-rodion-vscode-bridge"
  $ConfiguredPipe = $env:CMC_VSCODE_BRIDGE_PIPE
  if ($ConfiguredPipe -and $ConfiguredPipe -match '^\\\\\.\\pipe\\(.+)$') {
    $PipeName = $Matches[1]
  }

  $Client = $null
  try {
    $Client = [System.IO.Pipes.NamedPipeClientStream]::new(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $Client.Connect(500)
    $Reader = [System.IO.StreamReader]::new($Client)
    $Writer = [System.IO.StreamWriter]::new($Client)
    $Writer.AutoFlush = $true
    $Writer.WriteLine('{"command":"ping"}')
    $Line = $Reader.ReadLine()
    return ($Line -match '"ok"\s*:\s*true' -and $Line -match '"output"\s*:\s*"pong"')
  } catch {
    return $false
  } finally {
    if ($Client) {
      $Client.Dispose()
    }
  }
}

if (-not $SkipBuild) {
  Write-Step "Building protocol, Windows agent and VS Code bridge..."
  corepack pnpm --filter @cmc/protocol build
  corepack pnpm --filter @cmc/agent-windows build
  corepack pnpm --filter @cmc/vscode-bridge build
}

$CodeCommand = Find-CodeCommand
if (-not $CodeCommand) {
  Write-Warning "VS Code command was not found. Agent can start, but Web -> VS Code bridge will be unavailable."
  exit 0
}

$ExtensionSource = Join-Path $Root "apps\vscode-bridge"
$ExtensionDist = Join-Path $ExtensionSource "dist"
if (-not (Test-Path (Join-Path $ExtensionDist "extension.js"))) {
  throw "VS Code bridge is not built. Missing apps\vscode-bridge\dist\extension.js."
}

$ExtensionTarget = Join-Path $env:USERPROFILE ".vscode\extensions\local.codex-rodion-bridge-0.0.1"
Write-Step "Installing local VS Code bridge extension to $ExtensionTarget"
if (Test-Path $ExtensionTarget) {
  Remove-Item -LiteralPath $ExtensionTarget -Recurse -Force
}
New-Item -ItemType Directory -Path $ExtensionTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $ExtensionSource "package.json") -Destination $ExtensionTarget
Copy-Item -LiteralPath $ExtensionDist -Destination $ExtensionTarget -Recurse
$ExtensionResources = Join-Path $ExtensionSource "resources"
if (Test-Path $ExtensionResources) {
  Copy-Item -LiteralPath $ExtensionResources -Destination $ExtensionTarget -Recurse
}

if (Test-VscodeBridge) {
  Write-Step "VS Code bridge is already responding."
  exit 0
}

Write-Step "Opening VS Code workspace to activate bridge extension..."
Start-Process -FilePath $CodeCommand -ArgumentList @("--reuse-window", $Root) | Out-Null

$Deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $Deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-VscodeBridge) {
    Write-Step "VS Code bridge is ready."
    exit 0
  }
}

Write-Warning "VS Code bridge did not respond yet. If VS Code was already open before first install, reload the VS Code window once or restart VS Code, then run start-agent.bat again."
