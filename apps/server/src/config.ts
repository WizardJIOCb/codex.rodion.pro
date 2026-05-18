import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ServerConfig = {
  port: number;
  databasePath: string;
  sessionSecret: string;
  cookieDomain?: string;
  publicBaseUrl?: string;
  publicDir: string;
  nodeEnv: string;
};

function workspaceRoot(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

function sqlitePath(databaseUrl: string | undefined): string {
  if (!databaseUrl) return resolve(workspaceRoot(), "data", "cmc.db");
  if (databaseUrl.startsWith("file:")) return databaseUrl.slice("file:".length);
  return databaseUrl;
}

export function loadConfig(): ServerConfig {
  const databasePath = sqlitePath(process.env.DATABASE_URL);
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath,
    sessionSecret: process.env.SESSION_SECRET ?? "dev_secret_change_me_64_chars_minimum_for_local_only",
    cookieDomain: process.env.COOKIE_DOMAIN,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    publicDir: resolve(workspaceRoot(), "apps", "web", "dist"),
    nodeEnv: process.env.NODE_ENV ?? "development"
  };
}
