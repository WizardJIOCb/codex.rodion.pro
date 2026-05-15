import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { JobStatus, RepoInfo, Sandbox } from "@cmc/protocol";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
};

export type SessionRow = {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
  created_at: string;
};

export type AgentRow = {
  id: string;
  name: string;
  token_hash: string;
  hostname: string | null;
  os: string | null;
  agent_version: string | null;
  codex_version: string | null;
  git_version: string | null;
  status: "online" | "offline";
  current_job_id: string | null;
  last_seen_at: string | null;
  created_at: string;
};

export type RepoRow = {
  id: string;
  agent_id: string;
  name: string;
  path_masked: string;
  current_branch: string | null;
  dirty: number;
  default_sandbox: Sandbox;
  allowed_sandboxes: string;
  test_commands: string;
  updated_at: string;
};

export type JobRow = {
  id: string;
  chat_id: string | null;
  agent_id: string;
  repo_id: string;
  prompt: string;
  sandbox: Sandbox;
  branch_mode: "current" | "create-per-job";
  kind: "codex" | "test";
  test_command_id: string | null;
  status: JobStatus;
  exit_code: number | null;
  final_message: string | null;
  git_status: string | null;
  git_diff_stat: string | null;
  git_diff: string | null;
  branch_name: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type ChatRow = {
  id: string;
  agent_id: string;
  repo_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type LogRow = {
  id: string;
  job_id: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
  at: string;
};

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      hostname TEXT,
      os TEXT,
      agent_version TEXT,
      codex_version TEXT,
      git_version TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      current_job_id TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path_masked TEXT NOT NULL,
      current_branch TEXT,
      dirty INTEGER NOT NULL,
      default_sandbox TEXT NOT NULL,
      allowed_sandboxes TEXT NOT NULL,
      test_commands TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      sandbox TEXT NOT NULL,
      branch_mode TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'codex',
      test_command_id TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      final_message TEXT,
      git_status TEXT,
      git_diff_stat TEXT,
      git_diff TEXT,
      branch_name TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_logs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stream TEXT NOT NULL,
      message TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_agent_status ON jobs(agent_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_chats_repo_updated ON chats(agent_id, repo_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_logs_job_at ON job_logs(job_id, at);
  `);
  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "chat_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN chat_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_chat_created ON jobs(chat_id, created_at)");
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function mapRepo(row: RepoRow): RepoInfo {
  return {
    id: row.id,
    name: row.name,
    pathMasked: row.path_masked,
    currentBranch: row.current_branch ?? undefined,
    dirty: row.dirty === 1,
    defaultSandbox: row.default_sandbox,
    allowedSandboxes: JSON.parse(row.allowed_sandboxes) as Sandbox[],
    testCommands: JSON.parse(row.test_commands) as Array<{ id: string; label: string }>
  };
}
