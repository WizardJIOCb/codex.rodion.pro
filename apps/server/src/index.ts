import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  AgentToServerSchema,
  CreateChatSchema,
  DeploySchema,
  GitSyncSchema,
  CreateJobSchema,
  CreateProjectSchema,
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
  type AgentRow,
  type ChatMessageRow,
  type ChatRow,
  type JobRow,
  type LogRow,
  type RepoRow,
  type UserRow
} from "./db.js";
import {
  clearSessionCookie,
  createSession,
  getSession,
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
const uiClients = new Set<{ send: (event: UiEvent) => void }>();
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
const STALE_JOB_GRACE_MS = 2 * 60 * 1000;

function broadcast(event: UiEvent): void {
  for (const client of uiClients) client.send(event);
}

function sendAgent(agentId: string, message: ServerToAgent): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.send(message);
  return true;
}

function requestAgentProject(
  agentId: string,
  message: Extract<ServerToAgent, { type: "project.create" | "project.update" }>
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

function markAgentStatus(agentId: string, status: "online" | "offline"): void {
  db.prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?").run(status, nowIso(), agentId);
  broadcast({ type: "agent.status", agentId, status });
}

function upsertRepos(agentId: string, repos: RepoInfo[]): void {
  const stamp = nowIso();
  const upsert = db.prepare(`
    INSERT INTO repos (id,agent_id,name,path_masked,github_url,server_path,domain,current_branch,dirty,default_sandbox,allowed_sandboxes,test_commands,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,id) DO UPDATE SET
      name=excluded.name,
      path_masked=excluded.path_masked,
      github_url=excluded.github_url,
      server_path=excluded.server_path,
      domain=excluded.domain,
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
  return {
    id: message.id,
    chatId: message.chat_id,
    role: message.role,
    content: message.content,
    source: message.source,
    externalId: message.external_id,
    metadata: message.metadata_json ? JSON.parse(message.metadata_json) : undefined,
    createdAt: message.created_at
  };
}

function upsertSyncedChat(agentId: string, sync: Extract<AgentToServer, { type: "chat.sync" }>): void {
  const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?").get(agentId, sync.repoId) as RepoRow | undefined;
  if (!repo) return;
  const stamp = nowIso();
  let chat = db.prepare("SELECT * FROM chats WHERE agent_id = ? AND source = ? AND external_id = ?")
    .get(agentId, sync.source, sync.externalId) as ChatRow | undefined;
  if (chat) {
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
      db.prepare("INSERT INTO chat_messages (id,chat_id,role,content,source,external_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(message.id ?? id("msg"), chat.id, message.role, message.content.slice(0, 200000), message.source, message.externalId ?? null, message.metadata ? JSON.stringify(message.metadata) : null, message.createdAt);
    }
  }
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(sync.updatedAt || stamp, chat.id);
  broadcast({ type: "chats.updated", agentId, repoId: sync.repoId });
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
      prompt: job.prompt,
      sandbox: job.sandbox,
      branchMode: job.branch_mode,
      kind: job.kind,
      testCommandId: job.test_command_id ?? undefined
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

async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true });
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
    return { user: { id: auth.user.id, email: auth.user.email }, csrfToken: auth.session.csrf_token };
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
    return { user: { id: user.id, email: user.email }, csrfToken: session.csrf_token };
  });

  app.post("/api/logout", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const sessionId = request.cookies.cmc_session;
    if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get("/api/agents", async (request, reply) => {
    if (!requireAuth(db, request, reply)) return;
    const rows = db.prepare("SELECT id,name,hostname,os,agent_version,codex_version,git_version,status,current_job_id,last_seen_at,created_at FROM agents ORDER BY created_at")
      .all() as AgentRow[];
    return { agents: rows };
  });

  app.get("/api/repos", async (request, reply) => {
    if (!requireAuth(db, request, reply)) return;
    const rows = db.prepare("SELECT * FROM repos ORDER BY name").all() as RepoRow[];
    return { repos: rows.map((row) => ({ ...mapRepo(row), agentId: row.agent_id, updatedAt: row.updated_at })) };
  });

  app.post("/api/projects", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", details: parsed.error.flatten() });
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
    if (!requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
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

  app.post("/api/projects/:agentId/:repoId/git-sync", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
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
    if (!requireCsrf(db, request, reply)) return;
    const params = request.params as { agentId: string; repoId: string };
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

  app.get("/api/chats", async (request, reply) => {
    if (!requireAuth(db, request, reply)) return;
    const query = request.query as { agentId?: string; repoId?: string };
    if (!query.agentId || !query.repoId) return reply.code(400).send({ error: "agent_and_repo_required" });
    const rows = db.prepare("SELECT * FROM chats WHERE agent_id = ? AND repo_id = ? ORDER BY updated_at DESC")
      .all(query.agentId, query.repoId) as ChatRow[];
    return { chats: rows.map(serializeChat) };
  });

  app.post("/api/chats", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const parsed = CreateChatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat", details: parsed.error.flatten() });
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
    if (!requireAuth(db, request, reply)) return;
    const chatId = (request.params as { id: string }).id;
    const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!chat) return reply.code(404).send({ error: "not_found" });
    const rows = db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as JobRow[];
    const messages = db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC").all(chatId) as ChatMessageRow[];
    return { chat: serializeChat(chat), jobs: rows.map(serializeJob), messages: messages.map(serializeMessage) };
  });

  app.get("/api/jobs", async (request, reply) => {
    if (!requireAuth(db, request, reply)) return;
    const query = request.query as { chatId?: string };
    const rows = query.chatId
      ? db.prepare("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50").all(query.chatId) as JobRow[]
      : db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all() as JobRow[];
    return { jobs: rows.map(serializeJob) };
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    if (!requireAuth(db, request, reply)) return;
    const jobId = (request.params as { id: string }).id;
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!job) return reply.code(404).send({ error: "not_found" });
    const logs = db.prepare("SELECT * FROM job_logs WHERE job_id = ? ORDER BY at ASC").all(jobId) as LogRow[];
    return { job: serializeJob(job), logs };
  });

  app.post("/api/jobs", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const parsed = CreateJobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_job", details: parsed.error.flatten() });
    const repo = db.prepare("SELECT * FROM repos WHERE agent_id = ? AND id = ?")
      .get(parsed.data.agentId, parsed.data.repoId) as RepoRow | undefined;
    if (!repo) return reply.code(404).send({ error: "repo_not_found" });
    const allowed = JSON.parse(repo.allowed_sandboxes) as string[];
    if (!allowed.includes(parsed.data.sandbox)) return reply.code(400).send({ error: "sandbox_not_allowed" });
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
    db.prepare(`
      INSERT INTO jobs (id,chat_id,agent_id,repo_id,prompt,sandbox,branch_mode,kind,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(jobId, chatId, parsed.data.agentId, parsed.data.repoId, parsed.data.prompt, parsed.data.sandbox, parsed.data.branchMode, "codex", "queued", createdAt);
    appendChatMessage({
      chat_id: chatId,
      role: "user",
      content: parsed.data.prompt,
      source: "web",
      external_id: `job:${jobId}:prompt`,
      metadata_json: JSON.stringify({ jobId }),
      created_at: createdAt
    });
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(createdAt, chatId);
    broadcast({ type: "chats.updated", agentId: parsed.data.agentId, repoId: parsed.data.repoId });
    broadcast({ type: "job.created", jobId });
    broadcast({ type: "job.updated", jobId, status: "queued" });
    dispatchQueue(parsed.data.agentId);
    return reply.code(201).send({ jobId });
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    if (!requireCsrf(db, request, reply)) return;
    const jobId = (request.params as { id: string }).id;
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
          UPDATE agents SET hostname=?, os=?, agent_version=?, codex_version=?, git_version=?, last_seen_at=?, status='online'
          WHERE id=?
        `).run(parsed.hostname, parsed.os, parsed.agentVersion, parsed.codexVersion ?? null, parsed.gitVersion ?? null, nowIso(), agent.id);
        upsertRepos(agent.id, parsed.repos);
        dispatchQueue(agent.id);
      }
      if (parsed.type === "agent.heartbeat") {
        db.prepare("UPDATE agents SET last_seen_at=?, current_job_id=? WHERE id=?").run(nowIso(), parsed.currentJobId ?? null, agent.id);
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
