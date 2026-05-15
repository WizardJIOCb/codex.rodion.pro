# AGENTS.md

## Project rules

- This is a security-sensitive remote control app.
- Do not add arbitrary shell execution.
- Do not enable `danger-full-access`, `--yolo`, or `--dangerously-bypass-approvals-and-sandbox`.
- Do not open inbound ports on the Windows agent.
- Preserve repo allowlist behavior.
- All WebSocket payloads must be validated with Zod.
- All child process calls must use args arrays with `shell:false` unless explicitly justified.
- Do not log secrets, tokens, cookies, or full environment variables.
- Run typecheck and build before final response when possible.

## Commands

- `pnpm typecheck`
- `pnpm build`
