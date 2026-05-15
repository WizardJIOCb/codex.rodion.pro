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

node apps/agent-windows/dist/index.js --config $Config
