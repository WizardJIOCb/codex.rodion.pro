import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import {
  AgentToServerSchema,
  CreateAgentSchema,
  CreateChatSchema,
  DeploySchema,
  GitSyncSchema,
  CreateJobSchema,
  CreateProjectSchema,
  CreateUserSchema,
  NginxSchema,
  PasswordUpdateSchema,
  ProfileUpdateSchema,
  SslSchema,
  UpdateProjectSchema,
  type AgentToServer,
  type RepoInfo,
  type ServerToAgent,
  type UiEvent
} from "@cmc/protocol";
import { loadConfig } from "./config.js";
import {
  id,
  mapRepo,
  nowIso,
  openDb,
  parseCodexUsage,
  type AgentRow,
  type AttachmentRow,
  type ChatMessageRow,
  type ChatRow,
  type JobRow,
  type LogRow,
  type OAuthConnectionRow,
  type RepoRow,
  type UserRow
} from "./db.js";
import {
  clearSessionCookie,
  createSession,
  getSession,
  hashSecret,
  randomToken,
  requireAuth,
  requireCsrf,
  setSessionCookie,
  verifySecret
} from "./auth.js";

const config = loadConfig();
const db = openDb(config.databasePath);

type AgentConnection = {
  id: string;
  send: (message: ServerToAgent) => void;
};

const agents = new Map<string, AgentConnection>();
type AuthUser = Pick<UserRow, "id" | "role">;
const uiClients = new Set<{ user: AuthUser; send: (event: UiEvent) => void }>();
const projectRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "project.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const gitRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "git.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const deployRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "deploy.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const nginxRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "nginx.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const sslRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "ssl.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const STALE_JOB_GRACE_MS = 2 * 60 * 1000;

function isAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

function agentAccessWhere(user: AuthUser): string {
  return isAdmin(user) ? "" : "WHERE user_id = ?";
}

function agentAccessArgs(user: AuthUser): string[] {
  return isAdmin(user) ? [] : [user.id];
}

function canAccessAgent(user: AuthUser, agentId: string): boolean {
  if (isAdmin(user)) return true;
  const row = db.prepare("SELECT 1 FROM agents WHERE id = ? AND user_id = ?").get(agentId, user.id) as { 1: number } | undefined;
  return Boolean(row);
}

function requireAdminUser(auth: { user: UserRow }, reply: FastifyReply): boolean {
  if (auth.user.role === "admin") return true;
  reply.code(403).send({ error: "admin_required" });
  return false;
}

function serializeUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    nickname: user.nickname,
    bio: user.bio,
    avatarDataUrl: user.avatar_data_url,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function profileStats(user: AuthUser) {
  const agentFilter = isAdmin(user) ? "" : "AND a.user_id = ?";
  const args = isAdmin(user) ? [] : [user.id];
  const chatStats = db.prepare(`
    SELECT COUNT(*) AS chats
    FROM chats c
    JOIN agents a ON a.id = c.agent_id
    WHERE 1=1 ${agentFilter}
  `).get(...args) as { chats: number };
  const jobStats = db.prepare(`
    SELECT
      COUNT(*) AS jobs,
      SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE
        WHEN j.finished_at IS NOT NULL THEN
          MAX(0, CAST(ROUND((julianday(j.finished_at) - julianday(COALESCE(j.started_at, j.created_at))) * 86400) AS INTEGER))
        ELSE 0
      END) AS seconds
    FROM jobs j
    JOIN agents a ON a.id = j.agent_id
    WHERE 1=1 ${agentFilter}
  `).get(...args) as { jobs: number; completed: number | null; failed: number | null; seconds: number | null };
  const repoStats = db.prepare(`
    SELECT COUNT(*) AS projects
    FROM repos r
    JOIN agents a ON a.id = r.agent_id
    WHERE 1=1 ${agentFilter}
  `).get(...args) as { projects: number };
  return {
    chats: chatStats.chats,
    jobs: jobStats.jobs,
    completedJobs: jobStats.completed ?? 0,
    failedJobs: jobStats.failed ?? 0,
    projects: repoStats.projects,
    generationSeconds: jobStats.seconds ?? 0
  };
}

function oauthProviders(userId: string) {
  const rows = db.prepare("SELECT * FROM oauth_connections WHERE user_id = ?").all(userId) as OAuthConnectionRow[];
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return ["google", "github", "vk", "mailru"].map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected: Boolean(row),
      displayName: row?.display_name,
      connectedAt: row?.connected_at,
      configured: false
    };
  });
}

function visibleAgentIds(user: AuthUser): string[] {
  const rows = isAdmin(user)
    ? db.prepare("SELECT id FROM agents").all() as Array<{ id: string }>
    : db.prepare("SELECT id FROM agents WHERE user_id = ?").all(user.id) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function canAccessRepo(user: AuthUser, agentId: string, repoId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM repos r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.agent_id = ? AND r.id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(agentId, repoId, ...(isAdmin(user) ? [] : [user.id])) as { 1: number } | undefined;
  return Boolean(row);
}

function canAccessChat(user: AuthUser, chatId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM chats c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(chatId, ...(isAdmin(user) ? [] : [user.id])) as { 1: number } | undefined;
  return Boolean(row);
}

function canAccessJob(user: AuthUser, jobId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM jobs j
    JOIN agents a ON a.id = j.agent_id
    WHERE j.id = ? ${isAdmin(user) ? "" : "AND a.user_id = ?"}
  `).get(jobId, ...(isAdmin(user) ? [] : [user.id])) as { 1: number } | undefined;
  return Boolean(row);
}

function eventAgentId(event: UiEvent): string | undefined {
  if ("agentId" in event) return event.agentId;
  if ("jobId" in event) {
    const row = db.prepare("SELECT agent_id FROM jobs WHERE id = ?").get(event.jobId) as { agent_id: string } | undefined;
    return row?.agent_id;
  }
  return undefined;
}

function broadcast(event: UiEvent): void {
  const agentId = eventAgentId(event);
  for (const client of uiClients) {
    if (agentId && !canAccessAgent(client.user, agentId)) continue;
    client.send(event);
  }
}

function sendAgent(agentId: string, message: ServerToAgent): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.send(message);
  return true;
}

function requestAgentProject(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.create" | "project.update" | "project.delete" }>
): Promise<Extract<AgentToServer, { type: "project.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      projectRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 30000);
    projectRequests.set(message.requestId, { resolve, reject, timer });
    agent.send(message);
  });
}

function requestAgentGit(
  agentId: string,
  message: Extract<ServerToAgent, { type: "git.sync" }>
): Promise<Extract<AgentToServer, { type: "git.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      gitRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 120000);
    gitRequests.set(message.requestId, { resolve, reject, timer });
    agent.send(message);
  });
}

function requestAgentDeploy(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.deploy" }>
): Promise<Extract<AgentToServer, { type: "deploy.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      deployRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 300000);
    deployRequests.set(message.requestId, { resolve, reject, timer });
    agent.send(message);
  });
}

function requestAgentNginx(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.nginx" }>
): Promise<Extract<AgentToServer, { type: "nginx.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nginxRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 120000);
    nginxRequests.set(message.requestId, { resolve, reject, timer });
    agent.send(message);
  });
}

function requestAgentSsl(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.ssl" }>
): Promise<Extract<AgentToServer, { type: "ssl.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sslRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 300000);
    sslRequests.set(message.requestId, { resolve, reject, timer });
    agent.send(message);
  });
}

function markAgentStatus(agentId: string, status: "online" | "offline"): void {
  db.prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?").run(status, nowIso(), agentId);
  broadcast({ type: "agent.status", agentId, status });
}

function upsertRepos(agentId: string, repos: RepoInfo[]): void {
  const stamp = nowIso();
  const upsert = db.prepare(`
    INSERT INTO repos (id,agent_id,name,path_masked,github_url,server_path,domain,deploy_json,current_branch,dirty,default_sandbox,allowed_sandboxes,test_commands,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,id) DO UPDATE SET
      name=excluded.name,
      path_masked=excluded.path_masked,
      github_url=excluded.github_url,
      server_path=excluded.server_path,
      domain=excluded.domain,
      deploy_json=excluded.deploy_json,
      current_branch=excluded.current_branch,
      dirty=excluded.dirty,
      default_sandbox=excluded.default_sandbox,
      allowed_sandboxes=excluded.allowed_sandboxes,
      test_commands=excluded.test_commands,
      updated_at=excluded.updated_at
  `);
  for (const repo of repos) {
    upsert.run(
      repo.id,
      agentId,
      repo.name,
      repo.pathMasked,
      repo.githubUrl ?? null,
      repo.serverPath ?? null,
      repo.domain ?? null,
      repo.deploy ? JSON.stringify(repo.deploy) : null,
      repo.currentBranch ?? null,
      repo.dirty ? 1 : 0,
      repo.defaultSandbox,
      JSON.stringify(repo.allowedSandboxes),
      JSON.stringify(repo.testCommands),
      stamp
    );
  }
  broadcast({ type: "repos.updated", agentId, repos });
}

function appendLog(log: Omit<LogRow, "id">): void {
  db.prepare("INSERT INTO job_logs (id,job_id,stream,message,at) VALUES (?,?,?,?,?)")
    .run(id("log"), log.job_id, log.stream, log.message.slice(0, 20000), log.at);
  broadcast({ type: "job.log", jobId: log.job_id, stream: log.stream, message: log.message, at: log.at });
}

function appendChatMessage(message: Omit<ChatMessageRow, "id"> & { id?: string }): void {
  db.prepare(`
    INSERT INTO chat_messages (id,chat_id,role,content,source,external_id,metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      role=excluded.role,
      content=excluded.content,
      source=excluded.source,
      external_id=excluded.external_id,
      metadata_json=excluded.metadata_json,
      created_at=excluded.created_at
  `).run(
    message.id ?? id("msg"),
    message.chat_id,
    message.role,
    message.content.slice(0, 200000),
    message.source,
    message.external_id ?? null,
    message.metadata_json ?? null,
    message.created_at
  );
  broadcast({ type: "chats.updated", agentId: chatAgentId(message.chat_id), repoId: chatRepoId(message.chat_id) });
}

function clearOrphanedAgentJobs(agentId: string, currentJobId: string | undefined, reason = "Agent heartbeat has no active job; marking stale job as disconnected."): void {
  if (currentJobId) return;
  const rows = db.prepare("SELECT id, created_at, started_at FROM jobs WHERE agent_id = ? AND status IN ('assigned','running')")
    .all(agentId) as Array<{ id: string; created_at: string; started_at: string | null }>;
  const cutoff = Date.now() - STALE_JOB_GRACE_MS;
  const staleRows = rows.filter((row) => {
    const timestamp = Date.parse(row.started_at ?? row.created_at);
    return Number.isFinite(timestamp) && timestamp < cutoff;
  });
  if (!staleRows.length) return;
  const stamp = nowIso();
  const update = db.prepare("UPDATE jobs SET status='agent_disconnected', finished_at=? WHERE id=? AND status IN ('assigned','running')");
  for (const row of staleRows) {
    update.run(stamp, row.id);
    appendLog({
      job_id: row.id,
      stream: "system",
      message: reason,
      at: stamp
    });
    broadcast({ type: "job.updated", jobId: row.id, status: "agent_disconnected" });
  }
}

function chatAgentId(chatId: string): string {
  const row = db.prepare("SELECT agent_id FROM chats WHERE id = ?").get(chatId) as { agent_id: string } | undefined;
  return row?.agent_id ?? "";
}

function chatRepoId(chatId: string): string {
  const row = db.prepare("SELECT repo_id FROM chats WHERE id = ?").get(chatId) as { repo_id: string } | undefined;
  return row?.repo_id ?? "";
}

function serializeMessage(message: ChatMessageRow) {
  const attachments = db.prepare("SELECT * FROM job_attachments WHERE chat_message_id = ? ORDER BY created_at ASC")
    .all(message.id) as AttachmentRow[];
  return {
    id: message.id,
    chatId: message.chat_id,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.external_id,
    metadata: message.metadata_json ? JSON.parse(message.metadata_json) : undefined,
    createdAt: message.created_at,
    attachments: attachments.map(serializeAttachment)
  };
}

function serializeAttachment(attachment: AttachmentRow) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mime_type,
    size: attachment.size,
    dataBase64: isPreviewableImageMime(attachment.mime_type) ? attachment.data_base64 : undefined,
    createdAt: attachment.created_at
  };
}

function isPreviewableImageMime(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mimeType.toLowerCase());
}

function storeJobAttachments(
  jobId: string,
  messageId: string,
  attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>,
  createdAt: string
): void {
  const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalSize > 12 * 1024 * 1024) throw new Error("attachments_too_large");
  const insert = db.prepare(`
    INSERT INTO job_attachments (id,job_id,chat_message_id,name,mime_type,size,data_base64,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const attachment of attachments) {
    insert.run(
      id("att"),
      jobId,
      messageId,
      attachment.name,
      attachment.mimeType,
      attachment.size,
      attachment.dataBase64,
      createdAt
    );
  }
}

function upsertSyncedChat(agentId: string, sync: Extract<AgentToServer, { type: "chat.sync" }>): void {
  const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?").get(agentId, sync.repoId) as RepoRow | undefined;
  if (!repo) return;
  const tombstone = db.prepare("SELECT 1 FROM deleted_chat_sync WHERE agent_id = ? AND repo_id = ? AND source = ? AND external_id = ?")
    .get(agentId, sync.repoId, sync.source, sync.externalId) as { 1: number } | undefined;
  if (tombstone) return;
  const stamp = nowIso();
  const linkedChat = sync.source === "codex"
    ? db.prepare(`
      SELECT c.* FROM jobs j
      JOIN chats c ON c.id = j.chat_id
      WHERE j.agent_id = ? AND j.repo_id = ? AND j.codex_thread_id = ?
      ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) DESC
      LIMIT 1
    `).get(agentId, sync.repoId, sync.externalId) as ChatRow | undefined
    : undefined;
  let chat = db.prepare("SELECT * FROM chats WHERE agent_id = ? AND source = ? AND external_id = ?")
    .get(agentId, sync.source, sync.externalId) as ChatRow | undefined;
  if (linkedChat) {
    if (chat && chat.id !== linkedChat.id) {
      db.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
    }
    chat = linkedChat;
    db.prepare("UPDATE chats SET cwd=COALESCE(cwd, ?), updated_at=? WHERE id=?")
      .run(sync.cwd ?? null, sync.updatedAt, chat.id);
  } else if (chat) {
    db.prepare("UPDATE chats SET repo_id=?, title=?, cwd=?, updated_at=? WHERE id=?")
      .run(sync.repoId, sync.title, sync.cwd ?? null, sync.updatedAt, chat.id);
  } else {
    const chatId = id("chat");
    db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,source,external_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(chatId, agentId, sync.repoId, sync.title, sync.source, sync.externalId, sync.cwd ?? null, sync.updatedAt, sync.updatedAt);
    chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow;
  }
  for (const message of sync.messages) {
    const existing = message.externalId
      ? db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND source = ? AND external_id = ?")
        .get(chat.id, message.source, message.externalId) as { id: string } | undefined
      : undefined;
    if (existing) {
      db.prepare("UPDATE chat_messages SET role=?, content=?, metadata_json=?, created_at=? WHERE id=?")
        .run(message.role, message.content.slice(0, 200000), message.metadata ? JSON.stringify(message.metadata) : null, message.createdAt, existing.id);
    } else {
      const duplicate = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = ? AND content = ? LIMIT 1")
        .get(chat.id, message.role, message.content.slice(0, 200000)) as { id: string } | undefined;
      if (duplicate) continue;
      db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,source,external_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(message.id ?? id("msg"), chat.id, message.role, message.content.slice(0, 200000), message.source, message.externalId ?? null, message.metadata ? JSON.stringify(message.metadata) : null, message.createdAt);
    }
  }
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(sync.updatedAt || stamp, chat.id);
  broadcast({ type: "chats.updated", agentId, repoId: sync.repoId });
}

function tombstoneDeletedChat(chat: ChatRow, jobRows: Array<{ id: string; codex_thread_id?: string | null }>): void {
  const stamp = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO deleted_chat_sync (agent_id, repo_id, source, external_id, deleted_at)
    VALUES (?,?,?,?,?)
  `);
  if (chat.external_id) insert.run(chat.agent_id, chat.repo_id, chat.source, chat.external_id, stamp);
  for (const job of jobRows) {
    if (job.codex_thread_id) insert.run(chat.agent_id, chat.repo_id, "codex", job.codex_thread_id, stamp);
  }
}

function latestCodexThreadIdForChat(chatId: string | null, currentJobId: string): string | undefined {
  if (!chatId) return undefined;
  const chat = db.prepare("SELECT source, external_id FROM chats WHERE id = ?").get(chatId) as Pick<ChatRow, "source" | "external_id"> | undefined;
  if (chat?.source === "codex" && chat.external_id) return chat.external_id;
  const row = db.prepare(`
    SELECT codex_thread_id FROM jobs
    WHERE chat_id = ? AND id != ? AND codex_thread_id IS NOT NULL AND codex_thread_id != ''
    ORDER BY COALESCE(finished_at, started_at, created_at) DESC
    LIMIT 1
  `).get(chatId, currentJobId) as { codex_thread_id: string } | undefined;
  return row?.codex_thread_id;
}

function dispatchQueue(agentId: string): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  const running = db.prepare("SELECT * FROM jobs WHERE agent_id = ? AND status IN ('assigned','running') LIMIT 1")
    .get(agentId) as JobRow | undefined;
  if (running) return;
  const job = db.prepare("SELECT * FROM jobs WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get(agentId) as JobRow | undefined;
  if (!job) return;
  const stamp = nowIso();
  db.prepare("UPDATE jobs SET status = 'assigned', started_at = ? WHERE id = ?").run(stamp, job.id);
  db.prepare("UPDATE agents SET current_job_id = ? WHERE id = ?").run(job.id, agentId);
  broadcast({ type: "job.updated", jobId: job.id, status: "assigned" });
  agent.send({
    type: "job.run",
    job: {
      id: job.id,
      repoId: job.repo_id,
      chatId: job.chat_id ?? undefined,
      codexThreadId: latestCodexThreadIdForChat(job.chat_id, job.id),
      prompt: job.prompt,
      sandbox: job.sandbox,
      branchMode: job.branch_mode,
      kind: job.kind,
      testCommandId: job.test_command_id ?? undefined,
      attachments: (db.prepare("SELECT * FROM job_attachments WHERE job_id = ? ORDER BY created_at ASC").all(job.id) as AttachmentRow[])
        .map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mime_type,
          size: attachment.size,
          dataBase64: attachment.data_base64
        }))
    }
  });
}

async function authenticateAgent(token: string | undefined): Promise<AgentRow | null> {
  if (!token) return null;
  const rows = db.prepare("SELECT * FROM agents").all() as AgentRow[];
  for (const row of rows) {
    if (await bcrypt.compare(token, row.token_hash)) return row;
  }
  return null;
}

function serializeJob(job: JobRow) {
  return {
    id: job.id,
    chatId: job.chat_id,
    agentId: job.agent_id,
    repoId: job.repo_id,
    prompt: job.prompt,
    sandbox: job.sandbox,
    branchMode: job.branch_mode,
    kind: job.kind,
    testCommandId: job.test_command_id,
    status: job.status,
    exitCode: job.exit_code,
    finalMessage: job.final_message,
    gitStatus: job.git_status,
    gitDiffStat: job.git_diff_stat,
    gitDiff: job.git_diff,
    branchName: job.branch_name,
    codexThreadId: job.codex_thread_id,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at
  };
}

function serializeChat(chat: ChatRow) {
  return {
    id: chat.id,
    agentId: chat.agent_id,
    repoId: chat.repo_id,
    title: chat.title,
    source: chat.source,
    externalId: chat.external_id,
    cwd: chat.cwd,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at
  };
}

function projectIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
  return slug || id("project");
}

function agentIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54) || id("agent");
}

function uniqueAgentId(preferred: string): string {
  let candidate = preferred;
  let index = 2;
  while (db.prepare("SELECT 1 FROM agents WHERE id = ?").get(candidate)) {
    candidate = `${preferred.slice(0, 48)}-${index}`;
    index += 1;
  }
  return candidate;
}

function agentSetupPayload(request: { protocol: string; hostname: string }, agentId: string, token: string) {
  const wsProtocol = request.protocol === "https" ? "wss" : "ws";
  const serverUrl = `${wsProtocol}://${request.hostname}/api/agent/ws`;
  const configJson = JSON.stringify({
    agentId,
    serverUrl,
    tokenEnv: "CMC_AGENT_TOKEN",
    heartbeatIntervalMs: 20000,
    maxJobDurationMs: 3600000,
    cancelGraceMs: 5000,
    maxLogBytesPerJob: 10485760,
    fakeRunner: false,
    repos: [],
    redactPatterns: [
      "sk-[A-Za-z0-9_-]+",
      "ghp_[A-Za-z0-9_]+",
      "OPENAI_API_KEY=\\S+",
      "cmc_agent_[A-Za-z0-9_-]+"
    ]
  }, null, 2);
  const encodedConfig = Buffer.from(configJson, "utf8").toString("base64");
  const setupPowerShell = [
    "$ErrorActionPreference = \"Stop\"",
    "$Root = Join-Path $env:USERPROFILE \"codex.rodion.pro\"",
    "if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw \"Install Git for Windows first.\" }",
    "if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw \"Install Node.js LTS first.\" }",
    "if (-not (Get-Command codex.cmd -ErrorAction SilentlyContinue)) { throw \"Install Codex CLI and run: codex login\" }",
    "if (-not (Test-Path $Root)) { git clone https://github.com/WizardJIOCb/codex.rodion.pro.git $Root }",
    "Set-Location $Root",
    "corepack pnpm install",
    "corepack pnpm build",
    `[Environment]::SetEnvironmentVariable("CMC_AGENT_TOKEN", "${token}", "User")`,
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedConfig}"))`,
    "$config | Set-Content -Path \"apps/agent-windows/agent.config.json\" -Encoding UTF8",
    ".\\start-agent.bat"
  ].join("\n");
  return { agentId, serverUrl, token, configJson, setupPowerShell };
}

async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 20 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:");
  });

  app.get("/api/health", async () => ({ ok: true, now: nowIso() }));

  app.get("/api/me", async (request, reply) => {
    const auth = getSession(db, request);
    if (!auth) return reply.code(401).send({ user: null });
    return { user: serializeUser(auth.user), csrfToken: auth.session.csrf_token };
  });

  app.get("/api/profile", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    return {
      user: serializeUser(auth.user),
      stats: profileStats(auth.user),
      oauth: oauthProviders(auth.user.id)
    };
  });

  app.put("/api/profile", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = ProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_profile", details: parsed.error.flatten() });
    const nickname = parsed.data.nickname ? parsed.data.nickname.trim().toLowerCase() : null;
    if (nickname) {
      const existing = db.prepare("SELECT id FROM users WHERE nickname = ? AND id != ?").get(nickname, auth.user.id) as { id: string } | undefined;
      if (existing) return reply.code(409).send({ error: "nickname_taken" });
    }
    const stamp = nowIso();
    db.prepare("UPDATE users SET nickname = ?, bio = ?, avatar_data_url = ?, updated_at = ? WHERE id = ?")
      .run(nickname, parsed.data.bio?.trim() || null, parsed.data.avatarDataUrl || null, stamp, auth.user.id);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(auth.user.id) as UserRow;
    return { user: serializeUser(user), stats: profileStats(user), oauth: oauthProviders(user.id) };
  });

  app.post("/api/profile/password", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = PasswordUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_password", details: parsed.error.flatten() });
    if (!(await verifySecret(parsed.data.currentPassword, auth.user.password_hash))) {
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(await hashSecret(parsed.data.newPassword), nowIso(), auth.user.id);
    return { ok: true };
  });

  app.post("/api/profile/oauth/:provider/start", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const provider = (request.params as { provider: string }).provider;
    if (!["google", "github", "vk", "mailru"].includes(provider)) return reply.code(404).send({ error: "provider_not_found" });
    return reply.code(501).send({ error: "oauth_provider_not_configured", provider });
  });

  app.post("/api/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email || !body.password) return reply.code(400).send({ error: "email_and_password_required" });
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    if (!user || !(await verifySecret(body.password, user.password_hash))) {
      return reply.code(401).send({ error: "invalid_login" });
    }
    const session = await createSession(db, user.id);
    setSessionCookie(reply, config, session.id);
    return { user: { id: user.id, email: user.email, role: user.role }, csrfToken: session.csrf_token };
  });

  app.post("/api/logout", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const sessionId = request.cookies.cmc_session;
    if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get("/api/users", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireAdminUser(auth, reply)) return;
    const rows = db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    return { users: rows.map(serializeUser) };
  });

  app.post("/api/users", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply) || !requireAdminUser(auth, reply)) return;
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_user", details: parsed.error.flatten() });
    const email = parsed.data.email.trim().toLowerCase();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    if (existing) return reply.code(409).send({ error: "user_exists" });
    const userId = id("usr");
    db.prepare("INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)")
      .run(userId, email, await hashSecret(parsed.data.password), parsed.data.role, nowIso());
    return reply.code(201).send({ user: { id: userId, email, role: parsed.data.role } });
  });

  app.post("/api/agents", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_agent", details: parsed.error.flatten() });
    const ownerId = parsed.data.userId && isAdmin(auth.user) ? parsed.data.userId : auth.user.id;
    const owner = db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId) as { id: string } | undefined;
    if (!owner) return reply.code(404).send({ error: "user_not_found" });
    const agentId = uniqueAgentId(parsed.data.id?.trim() || agentIdFromName(parsed.data.name));
    const token = randomToken("cmc_agent");
    db.prepare("INSERT INTO agents (id,user_id,name,token_hash,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(agentId, ownerId, parsed.data.name.trim(), await hashSecret(token), "offline", nowIso());
    const setup = agentSetupPayload({ protocol: request.protocol, hostname: request.hostname }, agentId, token);
    return reply.code(201).send({ agent: { id: agentId, name: parsed.data.name.trim(), userId: ownerId }, setup });
  });

  app.get("/api/agents", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const rows = db.prepare(`SELECT id,user_id,name,hostname,os,agent_version,codex_version,git_version,codex_usage_json,status,current_job_id,last_seen_at,created_at FROM agents ${agentAccessWhere(auth.user)} ORDER BY created_at`)
      .all(...agentAccessArgs(auth.user)) as AgentRow[];
    return { agents: rows.map((row) => ({ ...row, codexUsage: parseCodexUsage(row.codex_usage_json) })) };
  });

  app.get("/api/repos", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const rows = db.prepare(`
      SELECT r.* FROM repos r
      JOIN agents a ON a.id = r.agent_id
      ${isAdmin(auth.user) ? "" : "WHERE a.user_id = ?"}
      ORDER BY r.name
    `).all(...(isAdmin(auth.user) ? [] : [auth.user.id])) as RepoRow[];
    return { repos: rows.map((row) => ({ ...mapRepo(row), agentId: row.agent_id, updatedAt: row.updated_at })) };
  });

  app.post("/api/projects", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", details: parsed.error.flatten() });
    if (!canAccessAgent(auth.user, parsed.data.agentId)) return reply.code(404).send({ error: "agent_not_found" });
    let repoId = projectIdFromName(parsed.data.name);
    const existing = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, repoId) as RepoRow | undefined;
    if (existing) repoId = `${repoId}-${Date.now().toString(36)}`;
    try {
      const result = await requestAgentProject(parsed.data.agentId, {
        type: "project.create",
        requestId: id("req"),
        project: {
          id: repoId,
          name: parsed.data.name,
          path: parsed.data.path,
          githubUrl: parsed.data.githubUrl?.trim() || undefined,
          serverPath: parsed.data.serverPath?.trim() || undefined,
          domain: parsed.data.domain?.trim() || undefined,
          deploy: parsed.data.deploy ?? undefined,
          defaultSandbox: parsed.data.defaultSandbox,
          allowedSandboxes: ["read-only", "workspace-write", "danger-full-access"]
        }
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_create_failed" });
      if (result.repos) upsertRepos(parsed.data.agentId, result.repos);
      return reply.code(201).send({ repoId });
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.put("/api/projects/:agentId/:repoId", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = UpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", details: parsed.error.flatten() });
    try {
      const result = await requestAgentProject(params.agentId, {
        type: "project.update",
        requestId: id("req"),
        repoId: params.repoId,
        patch: parsed.data
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_update_failed" });
      if (result.repos) upsertRepos(params.agentId, result.repos);
      return { ok: true };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.delete("/api/projects/:agentId/:repoId", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const active = db.prepare("SELECT id FROM jobs WHERE agent_id = ? AND repo_id = ? AND status IN ('queued','assigned','running') LIMIT 1")
      .get(params.agentId, params.repoId) as { id: string } | undefined;
    if (active) return reply.code(409).send({ error: "project_has_running_job" });
    try {
      const result = await requestAgentProject(params.agentId, {
        type: "project.delete",
        requestId: id("req"),
        repoId: params.repoId
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "project_delete_failed" });
      const chatRows = db.prepare("SELECT id FROM chats WHERE agent_id = ? AND repo_id = ?")
        .all(params.agentId, params.repoId) as Array<{ id: string }>;
      const jobRows = db.prepare("SELECT id FROM jobs WHERE agent_id = ? AND repo_id = ?")
        .all(params.agentId, params.repoId) as Array<{ id: string }>;
      db.exec("BEGIN");
      try {
        for (const job of jobRows) db.prepare("DELETE FROM job_logs WHERE job_id = ?").run(job.id);
        db.prepare("DELETE FROM jobs WHERE agent_id = ? AND repo_id = ?").run(params.agentId, params.repoId);
        for (const chat of chatRows) db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chat.id);
        db.prepare("DELETE FROM chats WHERE agent_id = ? AND repo_id = ?").run(params.agentId, params.repoId);
        db.prepare("DELETE FROM deleted_chat_sync WHERE agent_id = ? AND repo_id = ?").run(params.agentId, params.repoId);
        db.prepare("DELETE FROM repos WHERE agent_id = ? AND id = ?").run(params.agentId, params.repoId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (result.repos) upsertRepos(params.agentId, result.repos);
      broadcast({ type: "repos.updated", agentId: params.agentId, repos: result.repos ?? [] });
      return { ok: true };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/git-sync", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = GitSyncSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_git_sync", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    try {
      const result = await requestAgentGit(params.agentId, {
        type: "git.sync",
        requestId: id("req"),
        repoId: params.repoId,
        message: parsed.data.message,
        remoteUrl: parsed.data.remoteUrl?.trim() || undefined
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "git_sync_failed", output: result.output });
      if (result.repos) upsertRepos(params.agentId, result.repos);
      return { ok: true, output: result.output, status: result.status };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/deploy", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = DeploySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_deploy", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    try {
      const result = await requestAgentDeploy(params.agentId, {
        type: "project.deploy",
        requestId: id("req"),
        repoId: params.repoId
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "deploy_failed", output: result.output });
      if (result.repos) upsertRepos(params.agentId, result.repos);
      return { ok: true, output: result.output };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/nginx", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = NginxSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_nginx", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    try {
      const result = await requestAgentNginx(params.agentId, {
        type: "project.nginx",
        requestId: id("req"),
        repoId: params.repoId
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "nginx_failed", output: result.output });
      if (result.repos) upsertRepos(params.agentId, result.repos);
      return { ok: true, output: result.output };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/projects/:agentId/:repoId/ssl", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
    if (!canAccessRepo(auth.user, params.agentId, params.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const parsed = SslSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_ssl", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(params.agentId, params.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    try {
      const result = await requestAgentSsl(params.agentId, {
        type: "project.ssl",
        requestId: id("req"),
        repoId: params.repoId
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "ssl_failed", output: result.output });
      if (result.repos) upsertRepos(params.agentId, result.repos);
      return { ok: true, output: result.output };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.get("/api/chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const query = request.query as { agentId?: string; repoId?: string };
    if (!query.agentId || !query.repoId) return reply.code(400).send({ error: "agent_and_repo_required" });
    if (!canAccessRepo(auth.user, query.agentId, query.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const rows = db.prepare("SELECT * FROM chats WHERE agent_id = ? AND repo_id = ? ORDER BY updated_at DESC")
      .all(query.agentId, query.repoId) as ChatRow[];
    return { chats: rows.map(serializeChat) };
  });

  app.post("/api/chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateChatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat", details: parsed.error.flatten() });
    if (!canAccessRepo(auth.user, parsed.data.agentId, parsed.data.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, parsed.data.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const chatId = id("chat");
    const stamp = nowIso();
    db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(chatId, parsed.data.agentId, parsed.data.repoId, parsed.data.title, stamp, stamp);
    appendChatMessage({
      chat_id: chatId,
      role: "system",
      content: "Chat created on codex.rodion.pro.",
      source: "web",
      external_id: `chat:${chatId}:created`,
      metadata_json: null,
      created_at: stamp
    });
    broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    return reply.code(201).send({ chatId });
  });

  app.get("/api/chats/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const rows = db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as JobRow[];
    const messages = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC").all(chatId) as ChatMessageRow[];
    return { chat: serializeChat(chat), jobs: rows.map(serializeJob), messages: messages.map(serializeMessage) };
  });

  app.delete("/api/chats/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const active = db.prepare("SELECT id FROM jobs WHERE chat_id = ? AND status IN ('queued','assigned','running') LIMIT 1")
      .get(chatId) as { id: string } | undefined;
    if (active) return reply.code(409).send({ error: "chat_has_running_job" });
    const jobRows = db.prepare("SELECT id, codex_thread_id FROM jobs WHERE chat_id = ?").all(chatId) as Array<{ id: string; codex_thread_id: string | null }>;
    db.exec("BEGIN");
    try {
      tombstoneDeletedChat(chat, jobRows);
      for (const job of jobRows) db.prepare("DELETE FROM job_logs WHERE job_id = ?").run(job.id);
      db.prepare("DELETE FROM jobs WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    broadcast({ type: "chats.updated", agentId: chat.agent_id, repoId: chat.repo_id });
    return { ok: true };
  });

  app.get("/api/jobs", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const query = request.query as { chatId?: string };
    if (query.chatId && !canAccessChat(auth.user, query.chatId)) return reply.code(404).send({ error: "chat_not_found" });
    const rows = query.chatId
      ? db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50").all(query.chatId) as JobRow[]
      : db.prepare(`
          SELECT j.* FROM jobs j
          JOIN agents a ON a.id = j.agent_id
          ${isAdmin(auth.user) ? "" : "WHERE a.user_id = ?"}
          ORDER BY j.created_at DESC LIMIT 50
        `).all(...(isAdmin(auth.user) ? [] : [auth.user.id])) as JobRow[];
    return { jobs: rows.map(serializeJob) };
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const jobId = (request.params as { id: string }).id;
    if (!canAccessJob(auth.user, jobId)) return reply.code(404).send({ error: "not_found" });
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!job) return reply.code(404).send({ error: "not_found" });
    const logs = db.prepare("SELECT * FROM job_logs WHERE job_id = ? ORDER BY at ASC").all(jobId) as LogRow[];
    return { job: serializeJob(job), logs };
  });

  app.post("/api/jobs", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const parsed = CreateJobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_job", details: parsed.error.flatten() });
    if (!canAccessRepo(auth.user, parsed.data.agentId, parsed.data.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, parsed.data.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const allowed = JSON.parse(repo.allowed_sandboxes) as string[];
    if (!allowed.includes(parsed.data.sandbox)) return reply.code(400).send({ error: "sandbox_not_allowed" });
    const attachmentTotal = parsed.data.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (attachmentTotal > 12 * 1024 * 1024) return reply.code(400).send({ error: "attachments_too_large" });
    let chatId = parsed.data.chatId;
    if (chatId) {
      const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND agent_id = ? AND repo_id = ?")
        .get(chatId, parsed.data.agentId, parsed.data.repoId) as ChatRow | undefined;
      if (!chat) return reply.code(404).send({ error: "chat_not_found" });
    } else {
      chatId = id("chat");
      const stamp = nowIso();
      db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(chatId, parsed.data.agentId, parsed.data.repoId, parsed.data.prompt.slice(0, 80), "web", stamp, stamp);
      broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    }
    const jobId = id("job");
    const createdAt = nowIso();
    const promptMessageId = id("msg");
    db.prepare(`
      INSERT INTO jobs (id,chat_id,agent_id,repo_id,prompt,sandbox,branch_mode,kind,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(jobId, chatId, parsed.data.agentId, parsed.data.repoId, parsed.data.prompt, parsed.data.sandbox, parsed.data.branchMode, "codex", "queued", createdAt);
    appendChatMessage({
      id: promptMessageId,
      chat_id: chatId,
      role: "user",
      content: parsed.data.prompt,
      source: "web",
      external_id: `job:${jobId}:prompt`,
      metadata_json: JSON.stringify({ jobId }),
      created_at: createdAt
    });
    storeJobAttachments(jobId, promptMessageId, parsed.data.attachments, createdAt);
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(createdAt, chatId);
    broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    broadcast({ type: "job.created", jobId });
    broadcast({ type: "job.updated", jobId, status: "queued" });
    dispatchQueue(parsed.data.agentId);
    return reply.code(201).send({ jobId });
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const jobId = (request.params as { id: string }).id;
    if (!canAccessJob(auth.user, jobId)) return reply.code(404).send({ error: "not_found" });
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!job) return reply.code(404).send({ error: "not_found" });
    if (!["queued", "assigned", "running"].includes(job.status)) return { ok: true };
    if (job.status === "queued") {
      db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(nowIso(), jobId);
      broadcast({ type: "job.updated", jobId, status: "cancelled" });
      return { ok: true };
    }
    sendAgent(job.agent_id, { type: "job.cancel", jobId });
    appendLog({ job_id: jobId, stream: "system", message: "Cancel requested from mobile UI.", at: nowIso() });
    return { ok: true };
  });

  app.get("/api/ui/ws", { websocket: true }, (socket, request) => {
    const auth = getSession(db, request);
    if (!auth) {
      socket.close(1008, "unauthorized");
      return;
    }
    const client = {
      user: { id: auth.user.id, role: auth.user.role },
      send: (event: UiEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      }
    };
    uiClients.add(client);
    socket.on("close", () => uiClients.delete(client));
  });

  app.get("/api/agent/ws", { websocket: true }, async (socket, request) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const agent = await authenticateAgent(token);
    if (!agent) {
      socket.close(1008, "invalid token");
      return;
    }
    agents.set(agent.id, {
      id: agent.id,
      send: (message) => socket.send(JSON.stringify(message))
    });
    markAgentStatus(agent.id, "online");
    dispatchQueue(agent.id);

    socket.on("message", (raw) => {
      let parsed: AgentToServer;
      try {
        parsed = AgentToServerSchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.close(1003, "invalid message");
        return;
      }
      if (parsed.type === "agent.hello") {
        if (parsed.agentId !== agent.id) {
          socket.close(1008, "agent id mismatch");
          return;
        }
        db.prepare(`
          UPDATE agents SET hostname=?, os=?, agent_version=?, codex_version=?, git_version=?, codex_usage_json=?, last_seen_at=?, status='online'
          WHERE id=?
        `).run(
          parsed.hostname,
          parsed.os,
          parsed.agentVersion,
          parsed.codexVersion ?? null,
          parsed.gitVersion ?? null,
          parsed.codexUsage ? JSON.stringify(parsed.codexUsage) : null,
          nowIso(),
          agent.id
        );
        upsertRepos(agent.id, parsed.repos);
        dispatchQueue(agent.id);
      }
      if (parsed.type === "agent.heartbeat") {
        if (parsed.codexUsage) {
          db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=?, codex_usage_json=? WHERE id=?")
            .run(nowIso(), parsed.currentJobId ?? null, JSON.stringify(parsed.codexUsage), agent.id);
        } else {
          db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=? WHERE id=?").run(nowIso(), parsed.currentJobId ?? null, agent.id);
        }
        if (parsed.repos) upsertRepos(agent.id, parsed.repos);
        clearOrphanedAgentJobs(agent.id, parsed.currentJobId);
        dispatchQueue(agent.id);
      }
      if (parsed.type === "job.log") {
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?").run(nowIso(), parsed.jobId);
        broadcast({ type: "job.updated", jobId: parsed.jobId, status: "running" });
        appendLog({ job_id: parsed.jobId, stream: parsed.stream, message: parsed.message, at: parsed.at });
      }
      if (parsed.type === "job.progress") {
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?").run(nowIso(), parsed.jobId);
        broadcast(parsed);
      }
      if (parsed.type === "job.done") {
        db.prepare(`
          UPDATE jobs SET status=?, exit_code=?, final_message=?, git_status=?, git_diff_stat=?, git_diff=?, branch_name=?, codex_thread_id=?, finished_at=?
          WHERE id=?
        `).run(
          parsed.status,
          parsed.exitCode,
          parsed.finalMessage ?? null,
          parsed.gitStatus ?? null,
          parsed.gitDiffStat ?? null,
          parsed.gitDiff ?? null,
          parsed.branchName ?? null,
          parsed.codexThreadId ?? null,
          nowIso(),
          parsed.jobId
        );
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(parsed.jobId) as JobRow | undefined;
        if (job?.chat_id && parsed.finalMessage) {
          appendChatMessage({
            chat_id: job.chat_id,
            role: "assistant",
            content: parsed.finalMessage,
            source: "codex",
            external_id: `job:${parsed.jobId}:final`,
            metadata_json: JSON.stringify({
              jobId: parsed.jobId,
              status: parsed.status,
              codexThreadId: parsed.codexThreadId,
              gitStatus: parsed.gitStatus,
              gitDiffStat: parsed.gitDiffStat
            }),
            created_at: nowIso()
          });
        }
        db.prepare("UPDATE agents SET current_job_id = NULL WHERE id = ?").run(agent.id);
        broadcast({ type: "job.updated", jobId: parsed.jobId, status: parsed.status });
        dispatchQueue(agent.id);
      }
      if (parsed.type === "chat.sync") {
        upsertSyncedChat(agent.id, parsed);
      }
      if (parsed.type === "project.result") {
        const pending = projectRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          projectRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "git.result") {
        const pending = gitRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          gitRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "deploy.result") {
        const pending = deployRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          deployRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "nginx.result") {
        const pending = nginxRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          nginxRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "ssl.result") {
        const pending = sslRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          sslRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
    });

    socket.on("close", () => {
      agents.delete(agent.id);
      markAgentStatus(agent.id, "offline");
      db.prepare("UPDATE agents SET current_job_id = NULL WHERE id = ?").run(agent.id);
      setTimeout(() => {
        if (agents.has(agent.id)) return;
        clearOrphanedAgentJobs(agent.id, undefined, "Agent socket stayed disconnected; marking stale job as disconnected.");
      }, STALE_JOB_GRACE_MS + 1000);
    });
  });

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      prefix: "/"
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({ ok: true, message: "Build apps/web first." }));
  }

  return app;
}

createApp()
  .then((app) => app.listen({ host: "0.0.0.0", port: config.port }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
