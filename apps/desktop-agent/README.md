# Codex Agent Desktop

Native tray manager for `codex.rodion.pro`.

The desktop app is intentionally a manager shell around the existing compact Node agent package. The Node agent keeps the WebSocket protocol handling in TypeScript, where server messages are already validated with Zod. The native app owns the user experience: tray, settings, OS keychain token storage, process start/stop, and logs.

## Development

From the repository root:

```powershell
.\start-native-agent.bat
```

This checks prerequisites, installs workspace dependencies, and starts the native app in Tauri dev mode.

```powershell
pnpm --filter @cmc/desktop-agent dev
```

This runs only the React settings UI in a browser-like Vite shell.

```powershell
pnpm --filter @cmc/desktop-agent tauri:dev
```

This runs the native tray app. It expects the compact agent package to exist in `%USERPROFILE%\codex-agent` by default.

## Build

```powershell
pnpm --filter @cmc/desktop-agent build
pnpm --filter @cmc/desktop-agent tauri:build
```

From the repository root you can also build and run the release exe:

```powershell
.\build-native-agent.bat
.\start-native-agent.bat release
```

The repository root `pnpm build` only builds the web assets for this app, so VPS deploys do not need Rust or native build tooling.

## MVP Scope

- Save server URL, agent ID, compact agent folder, and token.
- Import an existing `setup-agent.bat` installation from the compact agent config and `CMC_AGENT_TOKEN`.
- Store token in the OS keychain when available and fall back to the existing `CMC_AGENT_TOKEN` environment value.
- Generate a local `agent.config.json` for the managed Node agent.
- Start and stop the managed agent using fixed process arguments and `shell:false` behavior.
- Show recent agent logs in the native window.
- Keep the tray menu available for show/start/stop/quit.

Next steps are installer packaging, downloading/updating the compact agent package from the web app, and deeper VS Code bridge health checks.
