# Codex Mobile Controller

`codex.rodion.pro` - личная панель управления Codex CLI на домашнем Windows ПК через web/PWA. Сервер живет на VPS, Windows агент подключается к нему только исходящим WebSocket, а web-интерфейс позволяет запускать Codex-задачи, смотреть логи, синхронизировать локальные чаты и управлять проектами.

```text
Browser/PWA
  |
  | HTTPS + /api/ui/ws
  v
VPS: Fastify server + SQLite + React web
  ^
  | outbound WSS /api/agent/ws
  |
Windows agent
  |-- allowlisted repos
  |-- Codex CLI jobs
  |-- Git / deploy / Nginx / SSL commands declared per project
  |-- local Codex/VS Code chat sync
  `-- VS Code bridge over local named pipe
```

## Что Есть

- Web app `apps/web`: проекты, чаты, jobs, live logs, sync/status, profile, OAuth UI, mobile-friendly layout.
- Server `apps/server`: Fastify API, WebSocket для UI и агента, SQLite, auth/sessions, agent package download, job queue.
- Windows agent `apps/agent-windows`: outbound WSS агент, allowlisted repos, Codex CLI runner, local chat sync, VS Code bridge client.
- VS Code bridge `apps/vscode-bridge`: локальное расширение VS Code с named pipe API и отдельной панелью `codex.rodion.pro -> Chats`.
- Desktop agent `apps/desktop-agent`: Tauri tray app/manager для compact Node agent package.
- Protocol package `packages/protocol`: Zod-схемы для WebSocket payloads и shared types.
- Compact setup: web может выдать `setup-agent.bat`, который скачивает `agent-package.zip` без клонирования всего репозитория.

## Основной Поток

1. Пользователь открывает `https://codex.rodion.pro`.
2. Web ходит в REST API и держит `/api/ui/ws` для live-событий.
3. Windows agent держит исходящее подключение к `/api/agent/ws`.
4. Job из web попадает в SQLite queue.
5. Agent забирает job, запускает Codex CLI в allowlisted repo и отправляет progress/log/done обратно.
6. Server сохраняет результат и рассылает обновления web-клиентам.
7. Local chat sync подтягивает локальные Codex/VS Code чаты из Windows профиля в server DB.
8. VS Code bridge открывает/переоткрывает локальные Codex threads в VS Code и показывает отдельный список локальных threads.

## Монорепозиторий

```text
apps/
  agent-windows/   Windows Node agent
  desktop-agent/   Tauri native tray manager
  server/          Fastify API + static web serving
  vscode-bridge/   Local VS Code companion extension
  web/             React/Vite frontend
packages/
  protocol/        Zod schemas and shared protocol types
scripts/
  prepare-vscode-bridge.ps1
  run-agent.ps1
  stop-desktop-agent-dev-server.ps1
  stop-legacy-agent-processes.ps1
infra/
  docker-compose.yml
  Caddyfile
```

Root scripts:

```powershell
pnpm build          # protocol + all apps build
pnpm typecheck      # protocol + all apps typecheck
pnpm server:dev     # Fastify dev server
pnpm web:dev        # Vite web dev server
pnpm agent:dev      # Windows agent dev entry
pnpm server:seed    # create user
pnpm server:agent   # create agent/token
```

## Требования

Для web/server/agent:

- Node.js LTS
- Corepack
- pnpm через Corepack
- Git
- Codex CLI на Windows машине, если нужен настоящий runner

Для native desktop app:

- Все выше
- Rust toolchain (`cargo`, `rustc`)
- Tauri prerequisites для Windows

## Environment

`.env.example`:

```dotenv
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://codex.rodion.pro
DATABASE_URL=file:/app/data/cmc.db
SESSION_SECRET=change_me_64_random_chars
COOKIE_DOMAIN=codex.rodion.pro
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
VK_CLIENT_ID=
VK_CLIENT_SECRET=
MAILRU_CLIENT_ID=
MAILRU_CLIENT_SECRET=
```

Локально обычно достаточно:

```powershell
$env:NODE_ENV="development"
$env:PORT="3000"
$env:PUBLIC_BASE_URL="http://localhost:3000"
$env:DATABASE_URL="file:./data/cmc.db"
$env:SESSION_SECRET="dev_secret_64_chars_minimum_change_me_please_123456"
```

OAuth callback URLs описаны в `docs/OAUTH.md`.

## Локальный Запуск Web + Server

```powershell
corepack enable
pnpm install
pnpm build
pnpm server:dev
```

Server отдает API и, после `pnpm build`, собранный web из `apps/web/dist`.

Health check:

```powershell
Invoke-WebRequest http://localhost:3000/api/health -UseBasicParsing
```

Создать пользователя:

```powershell
pnpm --filter @cmc/server seed:user --email you@example.com --password "change-me"
```

Создать агента и получить token:

```powershell
pnpm --filter @cmc/server agents:create --id home-windows --name "Home Windows"
```

Повернуть token:

```powershell
pnpm --filter @cmc/server agents:rotate-token --id home-windows
```

## Windows Agent

Agent config пример: `apps/agent-windows/agent.config.example.json`.

Важные поля:

- `agentId`: id агента на сервере.
- `serverUrl`: `ws://.../api/agent/ws` или `wss://.../api/agent/ws`.
- `tokenEnv`: имя env-переменной с agent token, обычно `CMC_AGENT_TOKEN`.
- `heartbeatIntervalMs`: heartbeat/status интервал.
- `fakeRunner`: тестовый режим без реального Codex CLI.
- `repos`: allowlist проектов. Agent работает только с ними.
- `defaultSandbox` / `allowedSandboxes`: sandbox policy для Codex jobs.
- `testCommands`: разрешенные команды тестов/проверок, отображаются в web.
- `redactPatterns`: маски для секретов в логах.

Dev запуск:

```powershell
Copy-Item apps/agent-windows/agent.config.example.json apps/agent-windows/agent.config.json
$env:CMC_AGENT_TOKEN="token_from_agents_create"
pnpm --filter @cmc/agent-windows dev -- --config apps/agent-windows/agent.config.json
```

Doctor/scan:

```powershell
pnpm --filter @cmc/agent-windows doctor -- --config apps/agent-windows/agent.config.json
pnpm --filter @cmc/agent-windows scan-repos -- --config apps/agent-windows/agent.config.json
```

Fake runner:

```powershell
$env:CMC_FAKE_RUNNER="1"
pnpm --filter @cmc/agent-windows dev -- --config apps/agent-windows/agent.config.json
```

## Compact Agent Package

Production web отдает компактный zip:

```text
GET /api/agent/package.zip
```

В zip входят только нужные runtime/build artifacts:

- root `package.json`, lockfile, workspace file
- `start-agent.bat`, `stop-agent.bat`
- `scripts/run-agent.ps1`
- `scripts/prepare-vscode-bridge.ps1`
- `apps/agent-windows/dist`
- `apps/vscode-bridge/dist`
- `apps/vscode-bridge/resources`
- `packages/protocol/dist`

Sync menu в web может выдать персональный `setup-agent.bat`. Он:

1. Скачивает `agent-package.zip`.
2. Распаковывает его в `%USERPROFILE%\codex-agent`.
3. Создает `apps/agent-windows/agent.config.json`.
4. Сохраняет `CMC_AGENT_TOKEN` в user env.
5. Запускает `start-agent.bat`.

Установленный агент запускается так:

```powershell
%USERPROFILE%\codex-agent\start-agent.bat
```

Остановить:

```powershell
%USERPROFILE%\codex-agent\stop-agent.bat
```

Repo root `start-agent.bat` делает то же для локальной разработки: готовит VS Code bridge, останавливает старый node-agent процесс и стартует agent в фоне через `scripts/run-agent.ps1`.

## Sync и Чаты

Есть три источника чатов:

- `web`: чаты, созданные на `codex.rodion.pro`.
- `codex`: локальные Codex CLI threads из Windows профиля.
- `vscode`: локальные VS Code chat sessions.

Sync local chats:

```text
POST /api/agents/:agentId/sync-local-chats
```

Endpoint отвечает быстро `202 Accepted`, а реальная синхронизация идет через agent WebSocket. Agent читает локальные данные, нормализует title/date/messages и отправляет `chat.sync` события серверу.

В web:

- слева у выбранного проекта есть кнопка `Sync`;
- в `Sync` меню есть общая кнопка синхронизации;
- скрытые локальные чаты можно вернуть или связать с текущим web-чатом через свойства чата.

Названия и даты нормализуются одинаково:

- служебные `AGENTS.md instructions`, `<INSTRUCTIONS>`, IDE-context не становятся title;
- дата списка = последнее реальное сообщение, если оно доступно;
- формат UI дат: `ru-RU`, `dd.mm.yyyy, hh:mm:ss`.

## VS Code Bridge

`apps/vscode-bridge` - локальное VS Code расширение. Оно ставится скриптом:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-vscode-bridge.ps1
```

Скрипт:

1. При необходимости собирает bridge.
2. Копирует extension в `%USERPROFILE%\.vscode\extensions\local.codex-rodion-bridge-0.0.1`.
3. Открывает workspace в VS Code.
4. Проверяет named pipe `codex-rodion-vscode-bridge`.

Если VS Code уже был открыт до первой установки, сделай:

```text
Developer: Reload Window
```

Bridge умеет:

- `ping`
- открыть Codex sidebar
- открыть новый Codex panel
- открыть локальный Codex thread по id
- переоткрыть thread, чтобы подтянуть свежие сообщения
- показать отдельную Activity Bar панель `codex.rodion.pro -> Chats`

Панель `Chats` читает локальные rollout-файлы из `%USERPROFILE%\.codex\sessions`, показывает нормализованные title/date и кнопки `Открыть` / `Переоткрыть`.

Важно: официальный Codex VS Code extension не дает публичный API, чтобы добавить thread в его внутренний список `Tasks`. Поэтому у нас отдельная панель со списком локальных threads.

## Native Desktop Agent

`apps/desktop-agent` - Tauri app для удобного управления агентом.

Запуск в dev:

```powershell
.\start-native-agent.bat
```

Режимы:

```powershell
.\start-native-agent.bat check
.\start-native-agent.bat dev
.\start-native-agent.bat release
```

Сборка exe:

```powershell
.\build-native-agent.bat
```

Готовый exe копируется в:

```text
dist-native\CodexAgent.exe
```

Native app сейчас является manager shell вокруг compact Node agent package. Он умеет:

- хранить server URL, agent ID, папку агента и token;
- импортировать существующий compact setup;
- хранить token в OS keychain, если доступно;
- генерировать local `agent.config.json`;
- стартовать/останавливать managed Node agent фиксированными аргументами;
- показывать логи;
- работать из tray.

## Web UI

Основные разделы:

- `Projects`: проекты, repo allowlist, project chats, jobs, commit/push/deploy/nginx/ssl actions.
- `Settings`: пользователи/агенты/проекты и настройки.
- `Sync`: состояние web service, Windows agent, Codex CLI, Git, VS Code bridge, sync target, setup agent download.
- `Profile`: профиль, пароль, OAuth providers.

Project chat:

- первое сообщение создает chat;
- следующие сообщения продолжают выбранный chat;
- вложения-изображения поддерживаются до лимитов protocol;
- Codex progress/logs/git diff/actions показываются в timeline;
- active local Codex activity может блокировать отправку, чтобы не наложить два запуска на один локальный thread.

## Server API

Основные группы endpoint'ов:

- Auth/profile: `/api/login`, `/api/register`, `/api/logout`, `/api/me`, `/api/profile`.
- OAuth: `/api/oauth/providers`, `/api/oauth/:provider/start`, `/api/oauth/:provider/callback`.
- Agents: `/api/agents`, `/api/agents/:agentId/setup`, `/api/agent/package.zip`.
- Projects: `/api/repos`, `/api/projects`, `/api/projects/:agentId/:repoId`.
- Project actions: `git-sync`, `deploy`, `nginx`, `ssl`.
- VS Code: `/api/agents/:agentId/vscode-command`.
- Chat sync: `/api/agents/:agentId/sync-local-chats`.
- Chats/messages: `/api/chats`, `/api/chats/:id`, attachments/details endpoints.
- Jobs: `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/cancel`.
- WebSockets: `/api/ui/ws`, `/api/agent/ws`.
- Health: `/api/health`.

## Production Deploy

Current production path:

```text
/var/www/codex.rodion.pro
```

Manual deploy:

```bash
cd /var/www/codex.rodion.pro
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm build
systemctl restart codex-controller.service
systemctl is-active codex-controller.service
```

Smoke check:

```bash
curl -I https://codex.rodion.pro
curl https://codex.rodion.pro/api/health
```

Production service currently runs as:

```text
codex-controller.service
```

Server start command from package:

```bash
pnpm --filter @cmc/server start
```

That runs:

```bash
node --no-warnings=ExperimentalWarning dist/index.js
```

## Docker/Caddy

`infra/docker-compose.yml` builds `apps/server/Dockerfile`, loads `../.env`, stores DB in Docker volume `cmc_data`, and exposes server only on localhost:

```text
127.0.0.1:3000:3000
```

`infra/Caddyfile`:

```caddyfile
codex.rodion.pro {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

## Проверки Перед Коммитом

```powershell
pnpm typecheck
pnpm build
```

Для bridge отдельно:

```powershell
pnpm --filter @cmc/vscode-bridge typecheck
pnpm --filter @cmc/vscode-bridge build
```

Для agent отдельно:

```powershell
pnpm --filter @cmc/agent-windows typecheck
pnpm --filter @cmc/agent-windows build
```

## Security Notes

- Windows agent делает только outbound WebSocket, входящие порты на домашнем ПК не нужны.
- Agent работает только с repos из allowlist.
- WebSocket payloads валидируются через Zod в `packages/protocol`.
- Agent token хранится в `CMC_AGENT_TOKEN`/keychain, не должен попадать в logs.
- `redactPatterns` в agent config маскируют секреты.
- Не добавлять произвольное shell execution.
- Child process calls должны использовать args arrays и `shell:false`, если нет явной причины.
- Не включать `danger-full-access`, `--yolo`, `--dangerously-bypass-approvals-and-sandbox` по умолчанию.
- Для production использовать HTTPS reverse proxy и длинный `SESSION_SECRET`.

## Частые Сценарии

Обновить prod:

```powershell
git push origin master
ssh myserver "set -e; cd /var/www/codex.rodion.pro; git pull --ff-only; corepack pnpm install --frozen-lockfile; corepack pnpm build; systemctl restart codex-controller.service; systemctl is-active codex-controller.service"
```

Обновить локальный VS Code bridge:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-vscode-bridge.ps1
```

Перезапустить локальный compact agent:

```powershell
%USERPROFILE%\codex-agent\stop-agent.bat
%USERPROFILE%\codex-agent\start-agent.bat
```

Пересобрать native agent exe:

```powershell
.\build-native-agent.bat
```

Синхронизировать чаты:

1. Убедиться, что agent online.
2. Открыть проект в web.
3. Нажать `Sync` в левом списке проекта или в меню `Sync`.
4. При необходимости нажать `Обновить` в VS Code bridge панели `codex.rodion.pro -> Chats`.
