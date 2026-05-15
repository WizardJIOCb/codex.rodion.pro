# Codex Mobile Controller

Phone-first control plane for running Codex CLI jobs on a home Windows PC from `https://codex.rodion.pro`.

```text
iPhone PWA -> HTTPS/WSS -> VPS Fastify + SQLite
                               ^
                               |
Windows agent -> outbound WSS --
Windows agent -> allowlisted repos -> codex exec / git / allowed tests
```

## Local Setup

```powershell
corepack enable
pnpm install
pnpm build
```

Run server:

```powershell
$env:SESSION_SECRET="dev_secret_64_chars_minimum_change_me_please_123456"
pnpm --filter @cmc/server dev
```

Create owner and agent token:

```powershell
pnpm --filter @cmc/server seed:user --email you@example.com --password "change-me"
pnpm --filter @cmc/server agents:create --id home-windows --name "Home Windows"
```

Start the Windows agent:

```powershell
Copy-Item apps/agent-windows/agent.config.example.json apps/agent-windows/agent.config.json
$env:CMC_AGENT_TOKEN="token_printed_by_agents_create"
pnpm --filter @cmc/agent-windows dev -- --config apps/agent-windows/agent.config.json
```

Use `CMC_FAKE_RUNNER=1` to test live logs without running Codex.

## VPS Deploy

The app is designed to run behind Caddy:

```bash
cd /var/www/codex.rodion.pro
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
pnpm --filter @cmc/server start
```

For production use the Docker Compose and Caddy files in `infra/`.

## Security Checklist

- Use a long random `SESSION_SECRET`.
- Keep agent token only in an environment variable.
- Run the Windows agent as a non-admin user.
- Only list trusted local repos in `agent.config.json`.
- Keep `danger-full-access` disabled.
- Put Caddy/Nginx TLS in front of the server.
