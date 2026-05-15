param(
  [string]$Config = "apps/agent-windows/agent.config.json"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $env:CMC_AGENT_TOKEN) {
  throw "CMC_AGENT_TOKEN is not set for this Windows user."
}

node apps/agent-windows/dist/index.js --config $Config
