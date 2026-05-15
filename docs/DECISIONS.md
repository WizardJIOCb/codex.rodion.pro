# Decisions

## 2026-05-16: MVP storage

Use Node 22 `node:sqlite` directly instead of Prisma/Drizzle for the first MVP. It keeps the VPS deploy small, avoids native ORM/client generation during early iteration, and still gives us a real SQLite database. Revisit once the schema stabilizes.

## 2026-05-16: Web app shape

Use a Vite React PWA served by the Fastify control-plane server. The SDD mentions Next.js, but this single-service layout is simpler for a phone-first control surface and for Docker/Caddy deployment on `codex.rodion.pro`.

## 2026-05-16: Execution safety

The Windows agent never opens inbound ports and never exposes arbitrary shell execution. It accepts only validated protocol messages, runs `codex exec` with args arrays and `shell:false`, rejects `danger-full-access`, and runs tests only from repo-local allowlists.
