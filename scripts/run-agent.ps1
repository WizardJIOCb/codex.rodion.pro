param(
  [string]$Config = "apps/agent-windows/agent.config.json"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $env:CMC_AGENT_TOKEN) {
  $env:CMC_AGENT_TOKEN = [Environment]::GetEnvironmentVariable("CMC_AGENT_TOKEN", "User")
}

if (-not $env:CMC_AGENT_TOKEN) {
  throw "CMC_AGENT_TOKEN is not set. Put it in the CMC_AGENT_TOKEN user environment variable."
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$NpmPath = Join-Path $env:APPDATA "npm"
$NodePath = Split-Path -Parent (Get-Command node.exe -ErrorAction Stop).Source
$PathParts = @($NpmPath, $NodePath, $UserPath, $MachinePath) | Where-Object { $_ }
$env:Path = ($PathParts -join ";")

if (-not $env:CMC_CODEX_BIN) {
  $CodexCmd = Get-Command codex.cmd -ErrorAction SilentlyContinue
  if ($CodexCmd) {
    $env:CMC_CODEX_BIN = $CodexCmd.Source
    $env:CMC_CODEX_JS = Join-Path (Split-Path -Parent $CodexCmd.Source) "node_modules\@openai\codex\bin\codex.js"
    $env:CMC_CODEX_NODE = (Get-Command node.exe -ErrorAction Stop).Source
  }
}

if (-not $env:CMC_CODEX_BIN -and -not ($env:CMC_CODEX_NODE -and $env:CMC_CODEX_JS)) {
  throw "codex.cmd is not available in PATH. Install or expose Codex CLI for the Windows agent."
}

node apps/agent-windows/dist/index.js --config $Config
