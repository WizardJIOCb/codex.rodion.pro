import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { CodexUsage, DeployConfig, JobStatus, RepoInfo, Sandbox } from "@cmc/protocol";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: "admin" | "user";
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
  user_id: string | null;
  name: string;
  token_hash: string;
  hostname: string | null;
  os: string | null;
  agent_version: string | null;
  codex_version: string | null;
  git_version: string | null;
  codex_usage_json: string | null;
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
  github_url: string | null;
  server_path: string | null;
  domain: string | null;
  deploy_json: string | null;
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
  codex_thread_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type ChatRow = {
  id: string;
  agent_id: string;
  repo_id: string;
  title: string;
  source: string;
  external_id: string | null;
  cwd: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatMessageRow = {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  source: string;
  external_id: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type AttachmentRow = {
  id: string;
  job_id: string;
  chat_message_id: string | null;
  name: string;
  mime_type: string;
  size: number;
  data_base64: string;
  created_at: string;
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
      role TEXT NOT NULL DEFAULT 'user',
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
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      hostname TEXT,
      os TEXT,
      agent_version TEXT,
      codex_version TEXT,
      git_version TEXT,
      codex_usage_json TEXT,
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
      github_url TEXT,
      server_path TEXT,
      domain TEXT,
      deploy_json TEXT,
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
      codex_thread_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'web',
      external_id TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_logs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stream TEXT NOT NULL,
      message TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_attachments (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_chat_sync (
      agent_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, repo_id, source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_agent_status ON jobs(agent_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_chats_repo_updated ON chats(agent_id, repo_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_logs_job_at ON job_logs(job_id, at);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_at ON chat_messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_attachments_job ON job_attachments(job_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON job_attachments(chat_message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external ON chat_messages(chat_id, source, external_id) WHERE external_id IS NOT NULL;
  `);
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  const firstUser = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
  const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: string } | undefined;
  if (firstUser && !adminUser) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(firstUser.id);
  }
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentColumns.some((column) => column.name === "user_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN user_id TEXT");
  }
  if (firstUser) {
    db.prepare("UPDATE agents SET user_id = ? WHERE user_id IS NULL").run(firstUser.id);
  }
  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "chat_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN chat_id TEXT");
  }
  if (!jobColumns.some((column) => column.name === "codex_thread_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN codex_thread_id TEXT");
  }
  const repoColumns = db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
  if (!repoColumns.some((column) => column.name === "github_url")) {
    db.exec("ALTER TABLE repos ADD COLUMN github_url TEXT");
  }
  if (!repoColumns.some((column) => column.name === "server_path")) {
    db.exec("ALTER TABLE repos ADD COLUMN server_path TEXT");
  }
  if (!repoColumns.some((column) => column.name === "domain")) {
    db.exec("ALTER TABLE repos ADD COLUMN domain TEXT");
  }
  if (!repoColumns.some((column) => column.name === "deploy_json")) {
    db.exec("ALTER TABLE repos ADD COLUMN deploy_json TEXT");
  }
  if (!agentColumns.some((column) => column.name === "codex_usage_json")) {
    db.exec("ALTER TABLE agents ADD COLUMN codex_usage_json TEXT");
  }
  const chatColumns = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  if (!chatColumns.some((column) => column.name === "source")) {
    db.exec("ALTER TABLE chats ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
  }
  if (!chatColumns.some((column) => column.name === "external_id")) {
    db.exec("ALTER TABLE chats ADD COLUMN external_id TEXT");
  }
  if (!chatColumns.some((column) => column.name === "cwd")) {
    db.exec("ALTER TABLE chats ADD COLUMN cwd TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_chat_created ON jobs(chat_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_at ON chat_messages(chat_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attachments_job ON job_attachments(job_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attachments_message ON job_attachments(chat_message_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_external ON chats(agent_id, source, external_id) WHERE external_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external ON chat_messages(chat_id, source, external_id) WHERE external_id IS NOT NULL");
  return db;
}

export function parseCodexUsage(value: string | null): CodexUsage | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as CodexUsage;
  } catch {
    return undefined;
  }
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
    githubUrl: row.github_url ?? undefined,
    serverPath: row.server_path ?? undefined,
    domain: row.domain ?? undefined,
    deploy: parseDeployConfig(row.deploy_json),
    currentBranch: row.current_branch ?? undefined,
    dirty: row.dirty === 1,
    defaultSandbox: row.default_sandbox,
    allowedSandboxes: JSON.parse(row.allowed_sandboxes) as Sandbox[],
    testCommands: JSON.parse(row.test_commands) as Array<{ id: string; label: string }>
  };
}

function parseDeployConfig(value: string | null): DeployConfig | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as DeployConfig;
  } catch {
    return undefined;
  }
}
