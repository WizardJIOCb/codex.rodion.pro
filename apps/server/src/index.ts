import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
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
  RegisterSchema,
  SslSchema,
  UpdateProjectSchema,
  VscodeCommandRequestSchema,
  type AgentToServer,
  type LocalCodexActivity,
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
  parseLocalActivity,
  type AgentRow,
  type AttachmentRow,
  type ChatAttachmentRow,
  type ChatMessageRow,
  type ChatRow,
  type JobRow,
  type LogRow,
  type OAuthConnectionRow,
  type OAuthStateRow,
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
  connectionId: string;
  send: (message: ServerToAgent) => void;
  close: () => void;
};

const agents = new Map<string, AgentConnection>();
type AuthUser = Pick<UserRow, "id" | "role">;
const uiClients = new Set<{ user: AuthUser; send: (event: UiEvent) => void }>();
type OAuthProviderId = "google" | "github" | "vk" | "mailru";
const oauthProviderIds: OAuthProviderId[] = ["google", "vk"];
type OAuthProfile = {
  provider: OAuthProviderId;
  providerUserId: string;
  email: string;
  displayName?: string;
};
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
const vscodeRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "vscode.result" }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const chatSyncRequests = new Map<string, {
  resolve: (value: Extract<AgentToServer, { type: "chat.sync.result" }>) => void;
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

function isOAuthProvider(value: string): value is OAuthProviderId {
  return oauthProviderIds.includes(value as OAuthProviderId);
}

function publicOrigin(request: { protocol: string; hostname: string }): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  return `${request.protocol}://${request.hostname}`;
}

function oauthEnvPrefix(provider: OAuthProviderId): string {
  return provider === "mailru" ? "MAILRU" : provider.toUpperCase();
}

function oauthClient(provider: OAuthProviderId): { clientId: string; clientSecret: string } | null {
  const prefix = oauthEnvPrefix(provider);
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function oauthRedirectUri(request: { protocol: string; hostname: string }, provider: OAuthProviderId): string {
  return `${publicOrigin(request)}/api/oauth/${provider}/callback`;
}

function pkceVerifier(): string {
  return randomToken("pkce").replace(/^pkce_/, "");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthAuthorizeUrl(provider: OAuthProviderId, clientId: string, redirectUri: string, state: string, codeChallenge?: string): string {
  const urls: Record<OAuthProviderId, string> = {
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    github: "https://github.com/login/oauth/authorize",
    vk: "https://id.vk.ru/authorize",
    mailru: "https://oauth.mail.ru/login"
  };
  const url = new URL(urls[provider]);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider === "google") {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
  }
  if (provider === "github") url.searchParams.set("scope", "read:user user:email");
  if (provider === "vk") {
    url.searchParams.set("scope", "vkid.personal_info email");
    if (codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
  }
  if (provider === "mailru") url.searchParams.set("scope", "userinfo");
  return url.toString();
}

function oauthProviders(userId?: string) {
  const rows = userId ? db.prepare("SELECT * FROM oauth_connections WHERE user_id = ?").all(userId) as OAuthConnectionRow[] : [];
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return oauthProviderIds.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected: Boolean(row),
      displayName: row?.display_name,
      connectedAt: row?.connected_at,
      configured: Boolean(oauthClient(provider))
    };
  });
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
  try {
    agent.send(message);
    return true;
  } catch {
    if (agents.get(agentId)?.connectionId === agent.connectionId) agents.delete(agentId);
    return false;
  }
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

function requestAgentVscode(
  agentId: string,
  message: Extract<ServerToAgent, { type: "vscode.command" }>
): Promise<Extract<AgentToServer, { type: "vscode.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      vscodeRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 30000);
    vscodeRequests.set(message.requestId, { resolve, reject, timer });
    agent.send(message);
  });
}

function requestAgentChatSync(
  agentId: string,
  message: Extract<ServerToAgent, { type: "chat.sync.request" }>
): Promise<Extract<AgentToServer, { type: "chat.sync.result" }>> {
  const agent = agents.get(agentId);
  if (!agent) return Promise.reject(new Error("agent_offline"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chatSyncRequests.delete(message.requestId);
      reject(new Error("agent_timeout"));
    }, 45000);
    chatSyncRequests.set(message.requestId, { resolve, reject, timer });
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
  broadcast({ type: "chats.updated", agentId: chatAgentId(message.chat_id), repoId: chatRepoId(message.chat_id), chatId: message.chat_id });
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

function idleLocalActivity(summary = "No recent local Codex activity."): LocalCodexActivity {
  return { status: "idle", summary, source: "agent heartbeat", detectedAt: nowIso() };
}

function freshLocalActivity(activity: LocalCodexActivity | undefined, _agentId?: string): LocalCodexActivity | undefined {
  if (!activity) return undefined;
  const timestamp = Date.parse(activity.detectedAt);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > 90000) {
    return idleLocalActivity();
  }
  return activity;
}

function broadcastAgentActivity(agentId: string, activity: LocalCodexActivity): void {
  const localActivity = freshLocalActivity(activity, agentId) ?? idleLocalActivity();
  broadcast({ type: "agent.activity", agentId, localActivity });
}

function isAgentLocallyBusy(agentId: string): boolean {
  const row = db.prepare("SELECT local_activity_json FROM agents WHERE id = ?").get(agentId) as Pick<AgentRow, "local_activity_json"> | undefined;
  return freshLocalActivity(parseLocalActivity(row?.local_activity_json ?? null), agentId)?.status === "busy";
}

function chatAgentId(chatId: string): string {
  const row = db.prepare("SELECT agent_id FROM chats WHERE id = ?").get(chatId) as { agent_id: string } | undefined;
  return row?.agent_id ?? "";
}

function chatRepoId(chatId: string): string {
  const row = db.prepare("SELECT repo_id FROM chats WHERE id = ?").get(chatId) as { repo_id: string } | undefined;
  return row?.repo_id ?? "";
}

type SerializeAttachmentOptions = {
  includeData?: boolean;
  lightMetadata?: boolean;
};

function serializeMessageMetadata(metadataJson: string | null, options: SerializeAttachmentOptions = {}) {
  if (!metadataJson) return undefined;
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  if (!options.lightMetadata) return metadata;
  let omitted = false;
  const light = { ...metadata };
  if (typeof light.gitDiff === "string") {
    delete light.gitDiff;
    light.gitDiffOmitted = true;
    omitted = true;
  }
  if (Array.isArray(light.codexActions)) {
    light.codexActions = light.codexActions.map((item) => {
      if (!item || typeof item !== "object") return item;
      const value = item as Record<string, unknown>;
      if (typeof value.output !== "string") return value;
      omitted = true;
      const rest = { ...value };
      delete rest.output;
      return { ...rest, outputOmitted: true };
    });
  }
  if (omitted) light.metadataOmitted = true;
  return light;
}

function serializeMessage(message: ChatMessageRow, options: SerializeAttachmentOptions = {}) {
  const jobAttachments = db.prepare("SELECT * FROM job_attachments WHERE chat_message_id = ? ORDER BY created_at ASC")
    .all(message.id) as AttachmentRow[];
  const chatAttachments = db.prepare("SELECT * FROM chat_attachments WHERE chat_message_id = ? ORDER BY created_at ASC")
    .all(message.id) as ChatAttachmentRow[];
  return {
    id: message.id,
    chatId: message.chat_id,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.external_id,
    metadata: serializeMessageMetadata(message.metadata_json, options),
    createdAt: message.created_at,
    attachments: [
      ...jobAttachments.map((attachment) => serializeAttachment(attachment, options)),
      ...chatAttachments.map((attachment) => serializeChatAttachment(attachment, options))
    ]
  };
}

function serializeMessagesForChat(chatId: string, messages: ChatMessageRow[], options: SerializeAttachmentOptions = {}) {
  const jobAttachments = db.prepare(`
    SELECT a.*
    FROM job_attachments a
    JOIN chat_messages m ON m.id = a.chat_message_id
    WHERE m.chat_id = ?
    ORDER BY a.created_at ASC
  `).all(chatId) as AttachmentRow[];
  const chatAttachments = db.prepare(`
    SELECT a.*
    FROM chat_attachments a
    JOIN chat_messages m ON m.id = a.chat_message_id
    WHERE m.chat_id = ?
    ORDER BY a.created_at ASC
  `).all(chatId) as ChatAttachmentRow[];
  const jobAttachmentsByMessage = new Map<string, AttachmentRow[]>();
  const chatAttachmentsByMessage = new Map<string, ChatAttachmentRow[]>();
  jobAttachments.forEach((attachment) => {
    if (!attachment.chat_message_id) return;
    const current = jobAttachmentsByMessage.get(attachment.chat_message_id) ?? [];
    current.push(attachment);
    jobAttachmentsByMessage.set(attachment.chat_message_id, current);
  });
  chatAttachments.forEach((attachment) => {
    const current = chatAttachmentsByMessage.get(attachment.chat_message_id) ?? [];
    current.push(attachment);
    chatAttachmentsByMessage.set(attachment.chat_message_id, current);
  });
  return messages.map((message) => ({
    id: message.id,
    chatId: message.chat_id,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.external_id,
    metadata: serializeMessageMetadata(message.metadata_json, options),
    createdAt: message.created_at,
    attachments: [
      ...(jobAttachmentsByMessage.get(message.id) ?? []).map((attachment) => serializeAttachment(attachment, options)),
      ...(chatAttachmentsByMessage.get(message.id) ?? []).map((attachment) => serializeChatAttachment(attachment, options))
    ]
  }));
}

function serializeAttachment(attachment: AttachmentRow, options: SerializeAttachmentOptions = {}) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mime_type,
    size: attachment.size,
    url: `/api/job-attachments/${encodeURIComponent(attachment.id)}`,
    dataBase64: options.includeData && isPreviewableImageMime(attachment.mime_type) ? attachment.data_base64 : undefined,
    createdAt: attachment.created_at
  };
}

function serializeChatAttachment(attachment: ChatAttachmentRow, options: SerializeAttachmentOptions = {}) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mime_type,
    size: attachment.size,
    url: `/api/chat-attachments/${encodeURIComponent(attachment.id)}`,
    dataBase64: options.includeData && isPreviewableImageMime(attachment.mime_type) ? attachment.data_base64 : undefined,
    createdAt: attachment.created_at
  };
}

function sendAttachment(reply: FastifyReply, attachment: Pick<AttachmentRow, "name" | "mime_type" | "data_base64">) {
  reply.header("Content-Type", attachment.mime_type);
  reply.header("Cache-Control", "private, max-age=86400");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Disposition", `inline; filename="${attachment.name.replace(/["\r\n]/g, "_")}"`);
  return reply.send(Buffer.from(attachment.data_base64, "base64"));
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

function replaceChatMessageAttachments(
  messageId: string,
  attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }> | undefined,
  createdAt: string
): void {
  db.prepare("DELETE FROM chat_attachments WHERE chat_message_id = ?").run(messageId);
  const safeAttachments = (attachments ?? []).filter((attachment) => isPreviewableImageMime(attachment.mimeType));
  const totalSize = safeAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (!safeAttachments.length || totalSize > 12 * 1024 * 1024) return;
  const insert = db.prepare(`
    INSERT INTO chat_attachments (id,chat_message_id,name,mime_type,size,data_base64,created_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const attachment of safeAttachments) {
    insert.run(
      id("att"),
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
  let changed = false;
  const latestSyncedMessage = sync.messages.at(-1);
  if (!linkedChat && chat && chat.updated_at === sync.updatedAt && latestSyncedMessage?.externalId) {
    const latestExists = db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND source = ? AND external_id = ?")
      .get(chat.id, latestSyncedMessage.source, latestSyncedMessage.externalId) as { 1: number } | undefined;
    if (latestExists) return;
  }
  if (linkedChat) {
    if (chat && chat.id !== linkedChat.id) {
      db.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
      changed = true;
    }
    chat = linkedChat;
    const nextCwd = chat.cwd ?? sync.cwd ?? null;
    if (chat.cwd !== nextCwd || chat.updated_at !== sync.updatedAt) {
      db.prepare("UPDATE chats SET cwd=?, updated_at=? WHERE id=?")
        .run(nextCwd, sync.updatedAt, chat.id);
      changed = true;
    }
  } else if (chat) {
    const nextCwd = sync.cwd ?? null;
    if (chat.repo_id !== sync.repoId || chat.title !== sync.title || chat.cwd !== nextCwd || chat.updated_at !== sync.updatedAt) {
      db.prepare("UPDATE chats SET repo_id=?, title=?, cwd=?, updated_at=? WHERE id=?")
        .run(sync.repoId, sync.title, nextCwd, sync.updatedAt, chat.id);
      changed = true;
    }
  } else {
    const chatId = id("chat");
    db.prepare("INSERT INTO chats (id,agent_id,repo_id,title,source,external_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(chatId, agentId, sync.repoId, sync.title, sync.source, sync.externalId, sync.cwd ?? null, sync.updatedAt, sync.updatedAt);
    chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow;
    changed = true;
  }
  for (const message of sync.messages) {
    const content = message.content.slice(0, 200000);
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;
    const existing = message.externalId
      ? db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? AND source = ? AND external_id = ?")
        .get(chat.id, message.source, message.externalId) as ChatMessageRow | undefined
      : undefined;
    if (existing) {
      if (
        existing.role !== message.role
        || existing.content !== content
        || existing.metadata_json !== metadataJson
        || existing.created_at !== message.createdAt
      ) {
        db.prepare("UPDATE chat_messages SET role=?, content=?, metadata_json=?, created_at=? WHERE id=?")
          .run(message.role, content, metadataJson, message.createdAt, existing.id);
        replaceChatMessageAttachments(existing.id, message.attachments, message.createdAt);
        changed = true;
      }
    } else {
      const duplicate = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = ? AND content = ? LIMIT 1")
        .get(chat.id, message.role, content) as { id: string } | undefined;
      if (duplicate) {
        continue;
      }
      const messageId = message.id ?? id("msg");
      db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,source,external_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(messageId, chat.id, message.role, content, message.source, message.externalId ?? null, metadataJson, message.createdAt);
      replaceChatMessageAttachments(messageId, message.attachments, message.createdAt);
      changed = true;
    }
  }
  if (changed) {
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(sync.updatedAt || stamp, chat.id);
    broadcast({
      type: "chats.updated",
      agentId,
      repoId: sync.repoId,
      chatId: chat.id,
      source: sync.source,
      externalId: sync.externalId
    });
  }
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
  if (isAgentLocallyBusy(agentId)) return;
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
      model: job.model ?? undefined,
      reasoningEffort: job.reasoning_effort ?? undefined,
      speed: job.speed ?? undefined,
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

function serializeJob(job: JobRow, options: { includeDiff?: boolean } = {}) {
  const includeDiff = options.includeDiff ?? true;
  const progress = parseJobProgress(job.progress_json);
  return {
    id: job.id,
    chatId: job.chat_id,
    agentId: job.agent_id,
    repoId: job.repo_id,
    prompt: job.prompt,
    sandbox: job.sandbox,
    branchMode: job.branch_mode,
    model: job.model,
    reasoningEffort: job.reasoning_effort,
    speed: job.speed,
    kind: job.kind,
    testCommandId: job.test_command_id,
    status: job.status,
    exitCode: job.exit_code,
    finalMessage: job.final_message,
    gitStatus: job.git_status,
    gitDiffStat: job.git_diff_stat,
    gitDiff: includeDiff ? job.git_diff : null,
    gitDiffOmitted: !includeDiff && Boolean(job.git_diff),
    progress,
    branchName: job.branch_name,
    codexThreadId: job.codex_thread_id,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at
  };
}

function parseJobProgress(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Extract<AgentToServer, { type: "job.progress" }>;
    return parsed.type === "job.progress" ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    hiddenAt: chat.hidden_at,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at
  };
}

function chatEtag(chat: ChatRow, messages: ChatMessageRow[], jobs: JobRow[]) {
  const value = JSON.stringify({
    id: chat.id,
    updatedAt: chat.updated_at,
    messageCount: messages.length,
    lastMessageAt: messages.at(-1)?.created_at ?? "",
    jobCount: jobs.length,
    jobs: jobs.map((job) => [job.id, job.status, job.started_at, job.finished_at, job.git_diff_stat?.length ?? 0, job.git_diff?.length ?? 0, job.progress_json?.length ?? 0])
  });
  return `W/"${createHash("sha256").update(value).digest("base64url")}"`;
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

type ZipEntry = {
  path: string;
  data: Buffer;
};

let crc32Table: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crc32Table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function addFile(entries: ZipEntry[], from: string, to: string): void {
  entries.push({ path: to, data: readFileSync(from) });
}

function addDir(entries: ZipEntry[], fromDir: string, toDir: string): void {
  for (const name of readdirSync(fromDir)) {
    const from = join(fromDir, name);
    const to = `${toDir}/${name}`;
    const stat = statSync(from);
    if (stat.isDirectory()) addDir(entries, from, to);
    if (stat.isFile()) addFile(entries, from, to);
  }
}

function agentPackageZip(): Buffer {
  const root = process.cwd();
  const entries: ZipEntry[] = [];
  addFile(entries, join(root, "package.json"), "package.json");
  addFile(entries, join(root, "pnpm-lock.yaml"), "pnpm-lock.yaml");
  addFile(entries, join(root, "pnpm-workspace.yaml"), "pnpm-workspace.yaml");
  addFile(entries, join(root, "start-agent.bat"), "start-agent.bat");
  addFile(entries, join(root, "stop-agent.bat"), "stop-agent.bat");
  addFile(entries, join(root, "scripts", "run-agent.ps1"), "scripts/run-agent.ps1");
  addFile(entries, join(root, "scripts", "prepare-vscode-bridge.ps1"), "scripts/prepare-vscode-bridge.ps1");
  addFile(entries, join(root, "apps", "agent-windows", "package.json"), "apps/agent-windows/package.json");
  addDir(entries, join(root, "apps", "agent-windows", "dist"), "apps/agent-windows/dist");
  addFile(entries, join(root, "apps", "vscode-bridge", "package.json"), "apps/vscode-bridge/package.json");
  addDir(entries, join(root, "apps", "vscode-bridge", "dist"), "apps/vscode-bridge/dist");
  addFile(entries, join(root, "packages", "protocol", "package.json"), "packages/protocol/package.json");
  addDir(entries, join(root, "packages", "protocol", "dist"), "packages/protocol/dist");
  return createStoredZip(entries.sort((a, b) => a.path.localeCompare(b.path)));
}

function agentSetupPayload(request: { protocol: string; hostname: string }, agentId: string, token: string) {
  const origin = publicOrigin(request);
  const serverUrl = `${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/api/agent/ws`;
  const packageUrl = `${origin}/api/agent/package.zip`;
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
    "$Root = Join-Path $env:USERPROFILE \"codex-agent\"",
    `$PackageUrl = "${packageUrl}"`,
    "if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw \"Install Node.js LTS first.\" }",
    "if (-not (Get-Command codex.cmd -ErrorAction SilentlyContinue)) { throw \"Install Codex CLI and run: codex login\" }",
    "New-Item -ItemType Directory -Force -Path $Root | Out-Null",
    "$Zip = Join-Path $Root \"agent-package.zip\"",
    "Invoke-WebRequest -Uri $PackageUrl -OutFile $Zip",
    "Expand-Archive -Path $Zip -DestinationPath $Root -Force",
    "Remove-Item -LiteralPath $Zip -Force",
    "Set-Location $Root",
    "corepack enable",
    "corepack pnpm install --prod --frozen-lockfile",
    `[Environment]::SetEnvironmentVariable("CMC_AGENT_TOKEN", "${token}", "User")`,
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedConfig}"))`,
    "$config | Set-Content -Path \"apps/agent-windows/agent.config.json\" -Encoding UTF8",
    ".\\start-agent.bat"
  ].join("\n");
  const setupBatch = [
    "@echo off",
    "setlocal",
    "set \"CODEX_AGENT_ROOT=%USERPROFILE%\\codex-agent\"",
    `set "CODEX_AGENT_PACKAGE_URL=${packageUrl}"`,
    `set "CODEX_AGENT_TOKEN=${token}"`,
    `set "CODEX_AGENT_CONFIG_B64=${encodedConfig}"`,
    "",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command ^",
    "  \"$ErrorActionPreference='Stop'; \" ^",
    "  \"$root=$env:CODEX_AGENT_ROOT; \" ^",
    "  \"$packageUrl=$env:CODEX_AGENT_PACKAGE_URL; \" ^",
    "  \"if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS first.' }; \" ^",
    "  \"if (-not (Get-Command codex.cmd -ErrorAction SilentlyContinue)) { throw 'Install Codex CLI and run: codex login' }; \" ^",
    "  \"New-Item -ItemType Directory -Force -Path $root | Out-Null; \" ^",
    "  \"$zip=Join-Path $root 'agent-package.zip'; \" ^",
    "  \"Invoke-WebRequest -Uri $packageUrl -OutFile $zip; \" ^",
    "  \"Expand-Archive -Path $zip -DestinationPath $root -Force; \" ^",
    "  \"Remove-Item -LiteralPath $zip -Force; \" ^",
    "  \"Set-Location $root; \" ^",
    "  \"corepack enable; \" ^",
    "  \"corepack pnpm install --prod --frozen-lockfile; \" ^",
    "  \"[Environment]::SetEnvironmentVariable('CMC_AGENT_TOKEN',$env:CODEX_AGENT_TOKEN,'User'); \" ^",
    "  \"$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_AGENT_CONFIG_B64)); \" ^",
    "  \"$config | Set-Content -Path (Join-Path $root 'apps\\agent-windows\\agent.config.json') -Encoding UTF8; \" ^",
    "  \"& (Join-Path $root 'start-agent.bat')\"",
    "set \"CODEX_AGENT_SETUP_EXIT=%ERRORLEVEL%\"",
    "pause",
    "exit /b %CODEX_AGENT_SETUP_EXIT%"
  ].join("\r\n");
  return { agentId, serverUrl, token, configJson, setupPowerShell, setupBatch, setupFileName: "setup-agent.bat", packageUrl };
}

async function tokenRequest(url: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = Object.fromEntries(new URLSearchParams(text)) as Record<string, unknown>;
  }
  if (!response.ok) throw new Error(String(data.error_description ?? data.error ?? "oauth_token_failed"));
  return data;
}

async function jsonGet(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error_description ?? data.error ?? "oauth_profile_failed"));
  return data;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jwtPayload(token: unknown): Record<string, unknown> {
  const value = stringValue(token);
  if (!value) return {};
  const [, payload] = value.split(".");
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fetchOAuthProfile(
  provider: OAuthProviderId,
  code: string,
  redirectUri: string,
  client: { clientId: string; clientSecret: string },
  options: { codeVerifier?: string | null; deviceId?: string; state?: string } = {}
): Promise<OAuthProfile> {
  if (provider === "google") {
    const token = await tokenRequest("https://oauth2.googleapis.com/token", {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    const accessToken = stringValue(token.access_token);
    if (!accessToken) throw new Error("oauth_token_missing");
    const profile = await jsonGet("https://www.googleapis.com/oauth2/v3/userinfo", { authorization: `Bearer ${accessToken}` });
    const email = stringValue(profile.email);
    const providerUserId = stringValue(profile.sub);
    if (!email || !providerUserId) throw new Error("oauth_email_missing");
    return { provider, email: email.toLowerCase(), providerUserId, displayName: stringValue(profile.name) ?? email };
  }
  if (provider === "github") {
    const token = await tokenRequest("https://github.com/login/oauth/access_token", {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri
    }, { accept: "application/json" });
    const accessToken = stringValue(token.access_token);
    if (!accessToken) throw new Error("oauth_token_missing");
    const profile = await jsonGet("https://api.github.com/user", {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "codex.rodion.pro"
    });
    let email = stringValue(profile.email);
    if (!email) {
      const emails = await fetch("https://api.github.com/user/emails", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "codex.rodion.pro"
        }
      }).then((response) => response.json().catch(() => [])) as Array<Record<string, unknown>>;
      email = stringValue(emails.find((item) => item.primary === true && item.verified === true)?.email)
        ?? stringValue(emails.find((item) => item.verified === true)?.email);
    }
    const providerUserId = String(profile.id ?? "");
    if (!email || !providerUserId) throw new Error("oauth_email_missing");
    return { provider, email: email.toLowerCase(), providerUserId, displayName: stringValue(profile.name) ?? stringValue(profile.login) ?? email };
  }
  if (provider === "vk") {
    if (!options.codeVerifier) throw new Error("oauth_pkce_missing");
    const token = await tokenRequest("https://id.vk.ru/oauth2/auth", {
      client_id: client.clientId,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: options.codeVerifier,
      ...(options.deviceId ? { device_id: options.deviceId } : {}),
      ...(options.state ? { state: options.state } : {})
    });
    const accessToken = stringValue(token.access_token);
    const providerUserId = String(token.user_id ?? "");
    if (!accessToken || !providerUserId) throw new Error("oauth_token_missing");
    const idToken = jwtPayload(token.id_token);
    const userInfo = await tokenRequest("https://id.vk.ru/oauth2/user_info", {
      access_token: accessToken,
      client_id: client.clientId
    });
    const user = typeof userInfo.user === "object" && userInfo.user ? userInfo.user as Record<string, unknown> : userInfo;
    const email = stringValue(user.email)
      ?? stringValue(token.email)
      ?? stringValue(idToken.email)
      ?? `vk-${providerUserId}@users.noreply.codex.rodion.pro`;
    const userId = String(user.user_id ?? user.id ?? idToken.sub ?? providerUserId);
    if (!userId) throw new Error("oauth_profile_missing");
    const displayName = [stringValue(user.first_name), stringValue(user.last_name)].filter(Boolean).join(" ")
      || stringValue(user.name)
      || stringValue(idToken.name)
      || email;
    return { provider, email: email.toLowerCase(), providerUserId: userId, displayName };
  }
  const token = await tokenRequest("https://oauth.mail.ru/token", {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error("oauth_token_missing");
  const profile = await jsonGet(`https://oauth.mail.ru/userinfo?access_token=${encodeURIComponent(accessToken)}`);
  const email = stringValue(profile.email);
  const providerUserId = String(profile.id ?? profile.uid ?? "");
  if (!email || !providerUserId) throw new Error("oauth_email_missing");
  return { provider, email: email.toLowerCase(), providerUserId, displayName: stringValue(profile.name) ?? stringValue(profile.nickname) ?? email };
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 300);
}

function userCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}

async function createUserSession(reply: FastifyReply, userId: string) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
  const session = await createSession(db, user.id);
  setSessionCookie(reply, config, session.id);
  return { user: serializeUser(user), csrfToken: session.csrf_token };
}

async function createOrLoginOAuthUser(profile: OAuthProfile, linkUserId?: string): Promise<string> {
  const stamp = nowIso();
  if (linkUserId) {
    const existing = db.prepare("SELECT user_id FROM oauth_connections WHERE provider = ? AND provider_user_id = ? AND user_id != ?")
      .get(profile.provider, profile.providerUserId, linkUserId) as { user_id: string } | undefined;
    if (existing) throw new Error("oauth_account_already_linked");
    db.prepare(`
      INSERT INTO oauth_connections (user_id,provider,provider_user_id,display_name,connected_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_user_id=excluded.provider_user_id,
        display_name=excluded.display_name,
        connected_at=excluded.connected_at
    `).run(linkUserId, profile.provider, profile.providerUserId, profile.displayName ?? null, stamp);
    return linkUserId;
  }
  const connection = db.prepare("SELECT user_id FROM oauth_connections WHERE provider = ? AND provider_user_id = ?")
    .get(profile.provider, profile.providerUserId) as { user_id: string } | undefined;
  if (connection) return connection.user_id;
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(profile.email) as UserRow | undefined;
  if (!user) {
    const userId = id("usr");
    const role = userCount() === 0 ? "admin" : "user";
    db.prepare("INSERT INTO users (id,email,password_hash,role,nickname,created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, profile.email, await hashSecret(randomToken("oauth_password")), role, null, stamp);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
  }
  db.prepare("INSERT OR IGNORE INTO oauth_connections (user_id,provider,provider_user_id,display_name,connected_at) VALUES (?,?,?,?,?)")
    .run(user.id, profile.provider, profile.providerUserId, profile.displayName ?? null, stamp);
  return user.id;
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

  app.get("/api/oauth/providers", async () => ({ providers: oauthProviders() }));

  app.post("/api/oauth/:provider/start", async (request, reply) => {
    const provider = (request.params as { provider: string }).provider;
    if (!isOAuthProvider(provider)) return reply.code(404).send({ error: "provider_not_found" });
    const client = oauthClient(provider);
    if (!client) return reply.code(501).send({ error: "oauth_provider_not_configured", provider });
    const state = randomToken("oauth_state");
    const codeVerifier = provider === "vk" ? pkceVerifier() : null;
    const stamp = nowIso();
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(stamp);
    db.prepare("INSERT INTO oauth_states (state,provider,user_id,return_to,code_verifier,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(state, provider, null, safeReturnTo((request.body as { returnTo?: string } | undefined)?.returnTo), codeVerifier, stamp, new Date(Date.now() + 10 * 60 * 1000).toISOString());
    return { url: oauthAuthorizeUrl(provider, client.clientId, oauthRedirectUri(request, provider), state, codeVerifier ? pkceChallenge(codeVerifier) : undefined) };
  });

  app.get("/api/oauth/:provider/callback", async (request, reply) => {
    const provider = (request.params as { provider: string }).provider;
    if (!isOAuthProvider(provider)) return reply.code(404).send("Provider not found.");
    const query = request.query as { code?: string; state?: string; error?: string; device_id?: string };
    if (query.error) return reply.redirect(`/?oauth_error=${encodeURIComponent(query.error)}`);
    if (!query.code || !query.state) return reply.code(400).send("Missing OAuth code/state.");
    const row = db.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = ?").get(query.state, provider) as OAuthStateRow | undefined;
    db.prepare("DELETE FROM oauth_states WHERE state = ?").run(query.state);
    if (!row || Date.parse(row.expires_at) < Date.now()) return reply.code(400).send("OAuth state expired.");
    const client = oauthClient(provider);
    if (!client) return reply.code(501).send("OAuth provider is not configured.");
    try {
      const profile = await fetchOAuthProfile(provider, query.code, oauthRedirectUri(request, provider), client, {
        codeVerifier: row.code_verifier,
        deviceId: query.device_id,
        state: query.state
      });
      const userId = await createOrLoginOAuthUser(profile, row.user_id ?? undefined);
      if (row.user_id) return reply.redirect(safeReturnTo(row.return_to ?? "/profile"));
      await createUserSession(reply, userId);
      return reply.redirect(safeReturnTo(row.return_to ?? "/"));
    } catch (error) {
      request.log.warn({ provider, error: error instanceof Error ? error.message : String(error) }, "OAuth callback failed");
      return reply.redirect(`/?oauth_error=${encodeURIComponent("oauth_failed")}`);
    }
  });

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
    if (!isOAuthProvider(provider)) return reply.code(404).send({ error: "provider_not_found" });
    const client = oauthClient(provider);
    if (!client) return reply.code(501).send({ error: "oauth_provider_not_configured", provider });
    const state = randomToken("oauth_state");
    const codeVerifier = provider === "vk" ? pkceVerifier() : null;
    const stamp = nowIso();
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(stamp);
    db.prepare("INSERT INTO oauth_states (state,provider,user_id,return_to,code_verifier,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(state, provider, auth.user.id, "/profile", codeVerifier, stamp, new Date(Date.now() + 10 * 60 * 1000).toISOString());
    return { url: oauthAuthorizeUrl(provider, client.clientId, oauthRedirectUri(request, provider), state, codeVerifier ? pkceChallenge(codeVerifier) : undefined) };
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
    return { user: serializeUser(user), csrfToken: session.csrf_token };
  });

  app.post("/api/register", async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_registration", details: parsed.error.flatten() });
    const email = parsed.data.email.trim().toLowerCase();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    if (existing) return reply.code(409).send({ error: "user_exists" });
    const nickname = parsed.data.nickname ? parsed.data.nickname.trim().toLowerCase() : null;
    if (nickname) {
      const nicknameOwner = db.prepare("SELECT id FROM users WHERE nickname = ?").get(nickname) as { id: string } | undefined;
      if (nicknameOwner) return reply.code(409).send({ error: "nickname_taken" });
    }
    const userId = id("usr");
    db.prepare("INSERT INTO users (id,email,password_hash,role,nickname,created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, email, await hashSecret(parsed.data.password), userCount() === 0 ? "admin" : "user", nickname, nowIso());
    return reply.code(201).send(await createUserSession(reply, userId));
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

  app.get("/api/agent/package.zip", async (_request, reply) => {
    try {
      const zip = agentPackageZip();
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", "attachment; filename=\"codex-agent-package.zip\"")
        .header("cache-control", "no-store")
        .send(zip);
    } catch (error) {
      return reply.code(500).send({ error: "agent_package_unavailable", message: error instanceof Error ? error.message : String(error) });
    }
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

  app.post("/api/agents/:agentId/setup", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const agentId = (request.params as { agentId: string }).agentId;
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "not_found" });
    if (agents.has(agentId)) return reply.code(409).send({ error: "agent_online" });
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as { id: string } | undefined;
    if (!agent) return reply.code(404).send({ error: "not_found" });
    const token = randomToken("cmc_agent");
    db.prepare("UPDATE agents SET token_hash = ?, status = 'offline', last_seen_at = ? WHERE id = ?")
      .run(await hashSecret(token), nowIso(), agentId);
    const setup = agentSetupPayload({ protocol: request.protocol, hostname: request.hostname }, agentId, token);
    return { setup };
  });

  app.get("/api/agents", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const rows = db.prepare(`SELECT id,user_id,name,hostname,os,agent_version,codex_version,git_version,codex_usage_json,local_activity_json,status,current_job_id,last_seen_at,created_at FROM agents ${agentAccessWhere(auth.user)} ORDER BY created_at`)
      .all(...agentAccessArgs(auth.user)) as AgentRow[];
    return { agents: rows.map((row) => ({ ...row, codexUsage: parseCodexUsage(row.codex_usage_json), localActivity: freshLocalActivity(parseLocalActivity(row.local_activity_json), row.id) })) };
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

  app.post("/api/agents/:agentId/vscode-command", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const { agentId } = request.params as { agentId: string };
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "agent_not_found" });
    const parsed = VscodeCommandRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_vscode_command", details: parsed.error.flatten() });
    try {
      const result = await requestAgentVscode(agentId, {
        type: "vscode.command",
        requestId: id("req"),
        command: parsed.data.command,
        text: parsed.data.text?.trim() || undefined,
        filePath: parsed.data.filePath?.trim() || undefined,
        threadId: parsed.data.threadId?.trim() || undefined
      });
      if (!result.ok) return reply.code(400).send({ error: result.error ?? "vscode_command_failed", output: result.output });
      return { ok: true, output: result.output };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.post("/api/agents/:agentId/sync-local-chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const { agentId } = request.params as { agentId: string };
    if (!canAccessAgent(auth.user, agentId)) return reply.code(404).send({ error: "agent_not_found" });
    try {
      const result = await requestAgentChatSync(agentId, {
        type: "chat.sync.request",
        requestId: id("req")
      });
      if (!result.ok) return reply.code(502).send({ error: result.error ?? "chat_sync_failed" });
      return { ok: true, sent: result.sent ?? 0 };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "agent_error" });
    }
  });

  app.get("/api/chats", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const query = request.query as { agentId?: string; repoId?: string; includeHidden?: string; localOnly?: string };
    if (!query.agentId || !query.repoId) return reply.code(400).send({ error: "agent_and_repo_required" });
    if (!canAccessRepo(auth.user, query.agentId, query.repoId)) return reply.code(404).send({ error: "repo_not_found" });
    const filters = ["agent_id = ?", "repo_id = ?"];
    const args = [query.agentId, query.repoId];
    if (query.includeHidden !== "1") filters.push("hidden_at IS NULL");
    if (query.localOnly === "1") filters.push("source IN ('codex','vscode')");
    const rows = db.prepare(`SELECT * FROM chats WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...args) as ChatRow[];
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
    const etag = chatEtag(chat, messages, rows);
    reply.header("ETag", etag);
    reply.header("Cache-Control", "private, max-age=0, must-revalidate");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return {
      chat: serializeChat(chat),
      jobs: rows.map((row) => serializeJob(row, { includeDiff: false })),
      messages: serializeMessagesForChat(chatId, messages, { lightMetadata: true })
    };
  });

  app.get("/api/chat-messages/:id/details", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const messageId = (request.params as { id: string }).id;
    const message = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as ChatMessageRow | undefined;
    if (!message || !canAccessChat(auth.user, message.chat_id)) return reply.code(404).send({ error: "not_found" });
    return { message: serializeMessage(message, { includeData: true }) };
  });

  app.get("/api/job-attachments/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const attachmentId = (request.params as { id: string }).id;
    const row = db.prepare(`
      SELECT a.*, j.chat_id AS chat_id
      FROM job_attachments a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ?
    `).get(attachmentId) as (AttachmentRow & { chat_id: string | null }) | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    const allowed = row.chat_id ? canAccessChat(auth.user, row.chat_id) : canAccessJob(auth.user, row.job_id);
    if (!allowed) return reply.code(404).send({ error: "not_found" });
    return sendAttachment(reply, row);
  });

  app.get("/api/chat-attachments/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth) return;
    const attachmentId = (request.params as { id: string }).id;
    const row = db.prepare(`
      SELECT a.*, m.chat_id AS chat_id
      FROM chat_attachments a
      JOIN chat_messages m ON m.id = a.chat_message_id
      WHERE a.id = ?
    `).get(attachmentId) as (ChatAttachmentRow & { chat_id: string }) | undefined;
    if (!row || !canAccessChat(auth.user, row.chat_id)) return reply.code(404).send({ error: "not_found" });
    return sendAttachment(reply, row);
  });

  app.put("/api/chats/:id", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const body = request.body as { title?: string; linkedChatId?: string };
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const stamp = nowIso();
    if (body.linkedChatId) {
      const linked = db.prepare("SELECT * FROM chats WHERE id = ? AND agent_id = ? AND repo_id = ? AND source IN ('codex','vscode')")
        .get(body.linkedChatId, chat.agent_id, chat.repo_id) as ChatRow | undefined;
      if (!linked) return reply.code(404).send({ error: "linked_chat_not_found" });
      db.prepare("UPDATE chats SET title=?, hidden_at=NULL, updated_at=? WHERE id=?")
        .run(body.title?.trim() || linked.title, stamp, linked.id);
      if (linked.id !== chatId) {
        const currentMessages = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? LIMIT 1").get(chatId) as { id: string } | undefined;
        if (!currentMessages) db.prepare("UPDATE chats SET hidden_at = COALESCE(hidden_at, ?), updated_at=? WHERE id=?").run(stamp, stamp, chatId);
      }
    } else {
      db.prepare("UPDATE chats SET title=COALESCE(?, title), updated_at=? WHERE id=?")
        .run(body.title?.trim() || null, stamp, chatId);
    }
    const updated = db.prepare("SELECT * FROM chats WHERE id = ?").get(body.linkedChatId || chatId) as ChatRow;
    broadcast({ type: "chats.updated", agentId: updated.agent_id, repoId: updated.repo_id });
    return { chat: serializeChat(updated) };
  });

  app.post("/api/chats/:id/hide", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const running = db.prepare("SELECT id FROM jobs WHERE chat_id = ? AND status IN ('queued','assigned','running') LIMIT 1").get(chatId) as { id: string } | undefined;
    if (running) return reply.code(409).send({ error: "chat_has_running_job" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    db.prepare("UPDATE chats SET hidden_at = COALESCE(hidden_at, ?), updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), chatId);
    broadcast({ type: "chats.updated", agentId: chat.agent_id, repoId: chat.repo_id });
    return { ok: true };
  });

  app.post("/api/chats/:id/unhide", async (request, reply) => {
    const auth = requireAuth(db, request, reply);
    if (!auth || !requireCsrf(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    if (!canAccessChat(auth.user, chatId)) return reply.code(404).send({ error: "not_found" });
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    db.prepare("UPDATE chats SET hidden_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), chatId);
    broadcast({ type: "chats.updated", agentId: chat.agent_id, repoId: chat.repo_id });
    return { chat: serializeChat({ ...chat, hidden_at: null, updated_at: nowIso() }) };
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
    return { jobs: rows.map((row) => serializeJob(row)) };
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
    if (isAgentLocallyBusy(parsed.data.agentId)) return reply.code(409).send({ error: "agent_local_busy" });
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
      INSERT INTO jobs (id,chat_id,agent_id,repo_id,prompt,sandbox,branch_mode,model,reasoning_effort,speed,kind,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      jobId,
      chatId,
      parsed.data.agentId,
      parsed.data.repoId,
      parsed.data.prompt,
      parsed.data.sandbox,
      parsed.data.branchMode,
      parsed.data.model ?? null,
      parsed.data.reasoningEffort ?? null,
      parsed.data.speed ?? null,
      "codex",
      "queued",
      createdAt
    );
    appendChatMessage({
      id: promptMessageId,
      chat_id: chatId,
      role: "user",
      content: parsed.data.prompt,
      source: "web",
      external_id: `job:${jobId}:prompt`,
      metadata_json: JSON.stringify({
        jobId,
        model: parsed.data.model,
        reasoningEffort: parsed.data.reasoningEffort,
        speed: parsed.data.speed
      }),
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
    const connectionId = id("agent_ws");
    const previous = agents.get(agent.id);
    if (previous) previous.close();
    const connection: AgentConnection = {
      id: agent.id,
      connectionId,
      send: (message) => {
        if (socket.readyState !== socket.OPEN) throw new Error("agent_socket_closed");
        socket.send(JSON.stringify(message));
      },
      close: () => {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(1000, "replaced");
      }
    };
    agents.set(agent.id, connection);
    markAgentStatus(agent.id, "online");
    dispatchQueue(agent.id);

    socket.on("message", (raw) => {
      let parsed: AgentToServer;
      try {
        parsed = AgentToServerSchema.parse(JSON.parse(raw.toString()));
      } catch (error) {
        request.log.warn({
          error: error instanceof Error ? error.message : String(error),
          bytes: Buffer.byteLength(raw.toString())
        }, "Invalid agent websocket message");
        socket.close(1003, "invalid message");
        return;
      }
      if (parsed.type === "agent.hello") {
        if (parsed.agentId !== agent.id) {
          socket.close(1008, "agent id mismatch");
          return;
        }
        db.prepare(`
          UPDATE agents SET hostname=?, os=?, agent_version=?, codex_version=?, git_version=?, codex_usage_json=?, local_activity_json=?, last_seen_at=?, status='online'
          WHERE id=?
        `).run(
          parsed.hostname,
          parsed.os,
          parsed.agentVersion,
          parsed.codexVersion ?? null,
          parsed.gitVersion ?? null,
          parsed.codexUsage ? JSON.stringify(parsed.codexUsage) : null,
          parsed.localActivity ? JSON.stringify(parsed.localActivity) : null,
          nowIso(),
          agent.id
        );
        if (parsed.localActivity) broadcastAgentActivity(agent.id, parsed.localActivity);
        upsertRepos(agent.id, parsed.repos);
        dispatchQueue(agent.id);
      }
      if (parsed.type === "agent.heartbeat") {
        const localActivityJson = parsed.localActivity ? JSON.stringify(parsed.localActivity) : null;
        if (parsed.codexUsage) {
          db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=?, codex_usage_json=?, local_activity_json=COALESCE(?, local_activity_json) WHERE id=?")
            .run(nowIso(), parsed.currentJobId ?? null, JSON.stringify(parsed.codexUsage), localActivityJson, agent.id);
        } else {
          db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=?, local_activity_json=COALESCE(?, local_activity_json) WHERE id=?").run(nowIso(), parsed.currentJobId ?? null, localActivityJson, agent.id);
        }
        if (parsed.localActivity) broadcastAgentActivity(agent.id, parsed.localActivity);
        if (parsed.repos) upsertRepos(agent.id, parsed.repos);
        clearOrphanedAgentJobs(agent.id, parsed.currentJobId);
        dispatchQueue(agent.id);
      }
      if (parsed.type === "job.log") {
        const previous = db.prepare("SELECT status FROM jobs WHERE id = ?").get(parsed.jobId) as { status: string } | undefined;
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?").run(nowIso(), parsed.jobId);
        if (previous?.status !== "running") broadcast({ type: "job.updated", jobId: parsed.jobId, status: "running" });
        appendLog({ job_id: parsed.jobId, stream: parsed.stream, message: parsed.message, at: parsed.at });
      }
      if (parsed.type === "job.progress") {
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?), progress_json=? WHERE id=?")
          .run(nowIso(), JSON.stringify(parsed), parsed.jobId);
        broadcast(parsed);
      }
      if (parsed.type === "job.done") {
        const finishedAt = nowIso();
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
          finishedAt,
          parsed.jobId
        );
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(parsed.jobId) as JobRow | undefined;
        if (job?.chat_id && parsed.codexThreadId) {
          db.prepare("UPDATE chats SET external_id = COALESCE(external_id, ?), updated_at = ? WHERE id = ?")
            .run(parsed.codexThreadId, finishedAt, job.chat_id);
        }
        if (job?.chat_id && parsed.finalMessage) {
          const startedAt = job.started_at ?? job.created_at;
          const startedAtMs = Date.parse(startedAt);
          const finishedAtMs = Date.parse(finishedAt);
          const durationSeconds = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
            ? Math.max(0, Math.floor((finishedAtMs - startedAtMs) / 1000))
            : undefined;
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
              gitDiffStat: parsed.gitDiffStat,
              model: job.model,
              reasoningEffort: job.reasoning_effort,
              speed: job.speed,
              startedAt,
              finishedAt,
              durationSeconds
            }),
            created_at: finishedAt
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
      if (parsed.type === "vscode.result") {
        const pending = vscodeRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          vscodeRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
      if (parsed.type === "chat.sync.result") {
        const pending = chatSyncRequests.get(parsed.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          chatSyncRequests.delete(parsed.requestId);
          pending.resolve(parsed);
        }
      }
    });

    socket.on("close", () => {
      if (agents.get(agent.id)?.connectionId !== connectionId) return;
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
      if (request.raw.url?.startsWith("/assets/")) return reply.code(404).send("Not found");
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
