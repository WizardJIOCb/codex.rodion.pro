import { z } from "zod";

export const SandboxSchema = z.enum(["read-only", "workspace-write"]);
export type Sandbox = z.infer<typeof SandboxSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "completed",
  "failed",
  "cancelled",
  "agent_disconnected"
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const RepoInfoSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  pathMasked: z.string().min(1).max(260),
  githubUrl: z.string().max(300).optional(),
  serverPath: z.string().max(260).optional(),
  domain: z.string().max(253).optional(),
  currentBranch: z.string().optional(),
  dirty: z.boolean(),
  defaultSandbox: SandboxSchema,
  allowedSandboxes: z.array(SandboxSchema).min(1),
  testCommands: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120)
  }))
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const AgentHelloSchema = z.object({
  type: z.literal("agent.hello"),
  agentId: z.string().min(1),
  hostname: z.string().min(1),
  os: z.string().min(1),
  agentVersion: z.string().min(1),
  codexVersion: z.string().optional(),
  gitVersion: z.string().optional(),
  repos: z.array(RepoInfoSchema)
});

export const AgentHeartbeatSchema = z.object({
  type: z.literal("agent.heartbeat"),
  currentJobId: z.string().optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const AgentJobLogSchema = z.object({
  type: z.literal("job.log"),
  jobId: z.string().min(1),
  stream: z.enum(["stdout", "stderr", "system"]),
  message: z.string(),
  at: z.string().datetime()
});

export const AgentJobProgressSchema = z.object({
  type: z.literal("job.progress"),
  jobId: z.string().min(1),
  phase: z.string().min(1).max(80),
  message: z.string().min(1).max(2000),
  filesChanged: z.number().int().nonnegative().optional(),
  added: z.number().int().nonnegative().optional(),
  deleted: z.number().int().nonnegative().optional(),
  at: z.string().datetime()
});

export const AgentJobDoneSchema = z.object({
  type: z.literal("job.done"),
  jobId: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int().nullable(),
  finalMessage: z.string().optional(),
  gitStatus: z.string().optional(),
  gitDiffStat: z.string().optional(),
  gitDiff: z.string().optional(),
  branchName: z.string().optional(),
  codexThreadId: z.string().optional()
});

export const AgentProjectResultSchema = z.object({
  type: z.literal("project.result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const AgentGitResultSchema = z.object({
  type: z.literal("git.result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  output: z.string().optional(),
  status: z.string().optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const ChatMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1).max(200000),
  source: z.string().min(1).max(40).default("web"),
  externalId: z.string().max(300).optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AgentChatSyncSchema = z.object({
  type: z.literal("chat.sync"),
  repoId: z.string().min(1),
  source: z.enum(["codex", "vscode"]),
  externalId: z.string().min(1).max(300),
  title: z.string().min(1).max(300),
  cwd: z.string().max(260).optional(),
  updatedAt: z.string().datetime(),
  messages: z.array(ChatMessageSchema).max(200)
});

export const AgentToServerSchema = z.discriminatedUnion("type", [
  AgentHelloSchema,
  AgentHeartbeatSchema,
  AgentJobLogSchema,
  AgentJobProgressSchema,
  AgentJobDoneSchema,
  AgentProjectResultSchema,
  AgentGitResultSchema,
  AgentChatSyncSchema
]);
export type AgentToServer = z.infer<typeof AgentToServerSchema>;

export const ServerJobRunSchema = z.object({
  type: z.literal("job.run"),
  job: z.object({
    id: z.string().min(1),
    repoId: z.string().min(1),
    chatId: z.string().optional(),
    prompt: z.string().min(1),
    sandbox: SandboxSchema,
    branchMode: z.enum(["current", "create-per-job"]).default("current"),
    kind: z.enum(["codex", "test"]).default("codex"),
    testCommandId: z.string().optional()
  })
});

export const ServerJobCancelSchema = z.object({
  type: z.literal("job.cancel"),
  jobId: z.string().min(1)
});

export const ServerProjectCreateSchema = z.object({
  type: z.literal("project.create"),
  requestId: z.string().min(1),
  project: z.object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    path: z.string().min(3).max(260),
    githubUrl: z.string().max(300).optional(),
    serverPath: z.string().max(260).optional(),
    domain: z.string().max(253).optional(),
    defaultSandbox: SandboxSchema.default("workspace-write"),
    allowedSandboxes: z.array(SandboxSchema).min(1).default(["read-only", "workspace-write"])
  })
});

export const ServerProjectUpdateSchema = z.object({
  type: z.literal("project.update"),
  requestId: z.string().min(1),
  repoId: z.string().min(1),
  patch: z.object({
    name: z.string().min(1).max(120).optional(),
    path: z.string().min(3).max(260).optional(),
    githubUrl: z.string().max(300).optional(),
    serverPath: z.string().max(260).optional(),
    domain: z.string().max(253).optional(),
    defaultSandbox: SandboxSchema.optional(),
    allowedSandboxes: z.array(SandboxSchema).min(1).optional()
  })
});

export const ServerGitSyncSchema = z.object({
  type: z.literal("git.sync"),
  requestId: z.string().min(1),
  repoId: z.string().min(1),
  message: z.string().min(1).max(200),
  remoteUrl: z.string().max(300).optional()
});

export const ServerToAgentSchema = z.discriminatedUnion("type", [
  ServerJobRunSchema,
  ServerJobCancelSchema,
  ServerProjectCreateSchema,
  ServerProjectUpdateSchema,
  ServerGitSyncSchema,
  z.object({ type: z.literal("repo.scan") })
]);
export type ServerToAgent = z.infer<typeof ServerToAgentSchema>;

export const CreateJobSchema = z.object({
  repoId: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().optional(),
  prompt: z.string().min(3).max(16000),
  sandbox: SandboxSchema,
  branchMode: z.enum(["current", "create-per-job"]).default("current")
});
export type CreateJob = z.infer<typeof CreateJobSchema>;

export const CreateChatSchema = z.object({
  agentId: z.string().min(1),
  repoId: z.string().min(1),
  title: z.string().min(1).max(160)
});
export type CreateChat = z.infer<typeof CreateChatSchema>;

export const CreateProjectSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(120),
  path: z.string().min(3).max(260),
  githubUrl: z.string().max(300).optional(),
  serverPath: z.string().max(260).optional(),
  domain: z.string().max(253).optional(),
  defaultSandbox: SandboxSchema.default("workspace-write")
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  path: z.string().min(3).max(260).optional(),
  githubUrl: z.string().max(300).optional(),
  serverPath: z.string().max(260).optional(),
  domain: z.string().max(253).optional(),
  defaultSandbox: SandboxSchema.optional(),
  allowedSandboxes: z.array(SandboxSchema).min(1).optional()
});
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

export const GitSyncSchema = z.object({
  message: z.string().min(1).max(200),
  remoteUrl: z.string().max(300).optional()
});
export type GitSync = z.infer<typeof GitSyncSchema>;

export const UiEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.status"), agentId: z.string(), status: z.enum(["online", "offline"]) }),
  z.object({ type: z.literal("repos.updated"), agentId: z.string(), repos: z.array(RepoInfoSchema) }),
  z.object({ type: z.literal("chats.updated"), agentId: z.string(), repoId: z.string() }),
  z.object({ type: z.literal("job.created"), jobId: z.string() }),
  z.object({ type: z.literal("job.updated"), jobId: z.string(), status: JobStatusSchema }),
  AgentJobProgressSchema,
  AgentJobLogSchema
]);
export type UiEvent = z.infer<typeof UiEventSchema>;
