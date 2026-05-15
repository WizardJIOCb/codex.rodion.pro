import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  AgentToServerSchema,
  CreateJobSchema,
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

function broadcast(event: UiEvent): void {
  for (const client of uiClients) client.send(event);
}

function sendAgent(agentId: string, message: ServerToAgent): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.send(message);
  return true;
}

function markAgentStatus(agentId: string, status: "online" | "offline"): void {
  db.prepare("UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?").run(status, nowIso(), agentId);
  broadcast({ type: "agent.status", agentId, status });
}

function upsertRepos(agentId: string, repos: RepoInfo[]): void {
  const stamp = nowIso();
  const upsert = db.prepare(`
    INSERT INTO repos (id,agent_id,name,path_masked,current_branch,dirty,default_sandbox,allowed_sandboxes,test_commands,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,id) DO UPDATE SET
      name=excluded.name,
      path_masked=excluded.path_masked,
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
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at
  };
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

  app.get("/api/jobs", async (request, reply) => {
    if (!requireAuth(db, request, reply)) return;
    const rows = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all() as JobRow[];
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
    const jobId = id("job");
    db.prepare(`
      INSERT INTO jobs (id,agent_id,repo_id,prompt,sandbox,branch_mode,kind,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(jobId, parsed.data.agentId, parsed.data.repoId, parsed.data.prompt, parsed.data.sandbox, parsed.data.branchMode, "codex", "queued", nowIso());
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
      }
      if (parsed.type === "job.log") {
        db.prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?").run(nowIso(), parsed.jobId);
        broadcast({ type: "job.updated", jobId: parsed.jobId, status: "running" });
        appendLog({ job_id: parsed.jobId, stream: parsed.stream, message: parsed.message, at: parsed.at });
      }
      if (parsed.type === "job.done") {
        db.prepare(`
          UPDATE jobs SET status=?, exit_code=?, final_message=?, git_status=?, git_diff_stat=?, git_diff=?, branch_name=?, finished_at=?
          WHERE id=?
        `).run(
          parsed.status,
          parsed.exitCode,
          parsed.finalMessage ?? null,
          parsed.gitStatus ?? null,
          parsed.gitDiffStat ?? null,
          parsed.gitDiff ?? null,
          parsed.branchName ?? null,
          nowIso(),
          parsed.jobId
        );
        db.prepare("UPDATE agents SET current_job_id = NULL WHERE id = ?").run(agent.id);
        broadcast({ type: "job.updated", jobId: parsed.jobId, status: parsed.status });
        dispatchQueue(agent.id);
      }
    });

    socket.on("close", () => {
      agents.delete(agent.id);
      markAgentStatus(agent.id, "offline");
      db.prepare("UPDATE agents SET current_job_id = NULL WHERE id = ?").run(agent.id);
      db.prepare("UPDATE jobs SET status='agent_disconnected', finished_at=? WHERE agent_id=? AND status IN ('assigned','running')")
        .run(nowIso(), agent.id);
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
