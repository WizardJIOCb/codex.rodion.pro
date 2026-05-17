import { z } from "zod";

export const SandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
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

export const DeployConfigSchema = z.object({
  sshTarget: z.string().min(1).max(120),
  sourceDir: z.string().min(1).max(260).default("dist"),
  remoteSubdir: z.string().max(120).optional(),
  cleanRemote: z.boolean().default(true),
  buildCommand: z.object({
    command: z.string().min(1).max(120),
    args: z.array(z.string().max(200)).default([]),
    timeoutMs: z.number().int().positive().max(3600000).default(900000)
  }).optional()
});
export type DeployConfig = z.infer<typeof DeployConfigSchema>;

export const RepoInfoSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  pathMasked: z.string().min(1).max(260),
  githubUrl: z.string().max(300).optional(),
  serverPath: z.string().max(260).optional(),
  domain: z.string().max(253).optional(),
  deploy: DeployConfigSchema.optional(),
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

export const CodexUsageSchema = z.object({
  status: z.enum(["signed-in", "signed-out", "unavailable"]),
  summary: z.string().min(1).max(300),
  source: z.string().min(1).max(80),
  checkedAt: z.string().datetime(),
  resetAt: z.string().datetime().optional(),
  limit: z.number().int().nonnegative().optional(),
  remaining: z.number().int().nonnegative().optional(),
  usedPercent: z.number().min(0).max(100).optional()
});
export type CodexUsage = z.infer<typeof CodexUsageSchema>;

export const LocalCodexActivitySchema = z.object({
  status: z.enum(["idle", "busy"]),
  summary: z.string().min(1).max(300),
  source: z.string().min(1).max(80),
  detectedAt: z.string().datetime(),
  busySinceAt: z.string().datetime().optional(),
  repoId: z.string().min(1).max(80).optional(),
  chatTitle: z.string().max(160).optional(),
  updatedAt: z.string().datetime().optional()
});
export type LocalCodexActivity = z.infer<typeof LocalCodexActivitySchema>;

export const JobAttachmentSchema = z.object({
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  size: z.number().int().positive().max(5 * 1024 * 1024),
  dataBase64: z.string().min(1).max(7 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/)
});
export type JobAttachment = z.infer<typeof JobAttachmentSchema>;

export const AgentHelloSchema = z.object({
  type: z.literal("agent.hello"),
  agentId: z.string().min(1),
  hostname: z.string().min(1),
  os: z.string().min(1),
  agentVersion: z.string().min(1),
  codexVersion: z.string().optional(),
  gitVersion: z.string().optional(),
  codexUsage: CodexUsageSchema.optional(),
  localActivity: LocalCodexActivitySchema.optional(),
  repos: z.array(RepoInfoSchema)
});

export const AgentHeartbeatSchema = z.object({
  type: z.literal("agent.heartbeat"),
  currentJobId: z.string().optional(),
  codexUsage: CodexUsageSchema.optional(),
  localActivity: LocalCodexActivitySchema.optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const AgentJobLogSchema = z.object({
  type: z.literal("job.log"),
  jobId: z.string().min(1),
  stream: z.enum(["stdout", "stderr", "system"]),
  message: z.string(),
  at: z.string().datetime()
});

export const JobProgressFileSchema = z.object({
  path: z.string().min(1).max(500),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative()
});

export const AgentJobProgressSchema = z.object({
  type: z.literal("job.progress"),
  jobId: z.string().min(1),
  phase: z.string().min(1).max(80),
  message: z.string().min(1).max(2000),
  filesChanged: z.number().int().nonnegative().optional(),
  added: z.number().int().nonnegative().optional(),
  deleted: z.number().int().nonnegative().optional(),
  files: z.array(JobProgressFileSchema).max(50).optional(),
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

export const AgentDeployResultSchema = z.object({
  type: z.literal("deploy.result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  output: z.string().optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const AgentNginxResultSchema = z.object({
  type: z.literal("nginx.result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  output: z.string().optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const AgentSslResultSchema = z.object({
  type: z.literal("ssl.result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  output: z.string().optional(),
  repos: z.array(RepoInfoSchema).optional()
});

export const ChatMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1).max(200000),
  source: z.string().min(1).max(40).default("web"),
  externalId: z.string().max(300).optional(),
  createdAt: z.string().datetime(),
  attachments: z.array(JobAttachmentSchema).max(8).default([]).optional(),
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
  AgentDeployResultSchema,
  AgentNginxResultSchema,
  AgentSslResultSchema,
  AgentChatSyncSchema
]);
export type AgentToServer = z.infer<typeof AgentToServerSchema>;

export const CodexModelSchema = z.string().min(1).max(80);
export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export const CodexSpeedSchema = z.enum(["standard", "fast"]);

export const ServerJobRunSchema = z.object({
  type: z.literal("job.run"),
  job: z.object({
    id: z.string().min(1),
    repoId: z.string().min(1),
    chatId: z.string().optional(),
    codexThreadId: z.string().optional(),
    prompt: z.string().min(1),
    sandbox: SandboxSchema,
    branchMode: z.enum(["current", "create-per-job"]).default("current"),
    kind: z.enum(["codex", "test"]).default("codex"),
    testCommandId: z.string().optional(),
    model: CodexModelSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    speed: CodexSpeedSchema.optional(),
    attachments: z.array(JobAttachmentSchema).max(8).default([])
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
    deploy: DeployConfigSchema.nullish(),
    defaultSandbox: SandboxSchema.default("danger-full-access"),
    allowedSandboxes: z.array(SandboxSchema).min(1).default(["read-only", "workspace-write", "danger-full-access"])
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
    deploy: DeployConfigSchema.nullish(),
    defaultSandbox: SandboxSchema.optional(),
    allowedSandboxes: z.array(SandboxSchema).min(1).optional()
  })
});

export const ServerProjectDeleteSchema = z.object({
  type: z.literal("project.delete"),
  requestId: z.string().min(1),
  repoId: z.string().min(1)
});

export const ServerGitSyncSchema = z.object({
  type: z.literal("git.sync"),
  requestId: z.string().min(1),
  repoId: z.string().min(1),
  message: z.string().min(1).max(200),
  remoteUrl: z.string().max(300).optional()
});

export const ServerDeploySchema = z.object({
  type: z.literal("project.deploy"),
  requestId: z.string().min(1),
  repoId: z.string().min(1)
});

export const ServerNginxSchema = z.object({
  type: z.literal("project.nginx"),
  requestId: z.string().min(1),
  repoId: z.string().min(1)
});

export const ServerSslSchema = z.object({
  type: z.literal("project.ssl"),
  requestId: z.string().min(1),
  repoId: z.string().min(1)
});

export const ServerToAgentSchema = z.discriminatedUnion("type", [
  ServerJobRunSchema,
  ServerJobCancelSchema,
  ServerProjectCreateSchema,
  ServerProjectUpdateSchema,
  ServerProjectDeleteSchema,
  ServerGitSyncSchema,
  ServerDeploySchema,
  ServerNginxSchema,
  ServerSslSchema,
  z.object({ type: z.literal("repo.scan") })
]);
export type ServerToAgent = z.infer<typeof ServerToAgentSchema>;

export const CreateJobSchema = z.object({
  repoId: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().optional(),
  prompt: z.string().min(3).max(16000),
  sandbox: SandboxSchema,
  branchMode: z.enum(["current", "create-per-job"]).default("current"),
  model: CodexModelSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  speed: CodexSpeedSchema.optional(),
  attachments: z.array(JobAttachmentSchema).max(8).default([])
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
  deploy: DeployConfigSchema.nullish(),
  defaultSandbox: SandboxSchema.default("danger-full-access")
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  path: z.string().min(3).max(260).optional(),
  githubUrl: z.string().max(300).optional(),
  serverPath: z.string().max(260).optional(),
  domain: z.string().max(253).optional(),
  deploy: DeployConfigSchema.nullish(),
  defaultSandbox: SandboxSchema.optional(),
  allowedSandboxes: z.array(SandboxSchema).min(1).optional()
});
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

export const GitSyncSchema = z.object({
  message: z.string().min(1).max(200),
  remoteUrl: z.string().max(300).optional()
});
export type GitSync = z.infer<typeof GitSyncSchema>;

export const DeploySchema = z.object({});
export type Deploy = z.infer<typeof DeploySchema>;

export const NginxSchema = z.object({});
export type Nginx = z.infer<typeof NginxSchema>;

export const SslSchema = z.object({});
export type Ssl = z.infer<typeof SslSchema>;

export const CreateUserSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "user"]).default("user")
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const RegisterSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  nickname: z.string().trim().min(3).max(32).regex(/^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/i).optional().or(z.literal(""))
});
export type Register = z.infer<typeof RegisterSchema>;

export const ProfileUpdateSchema = z.object({
  nickname: z.string().trim().min(3).max(32).regex(/^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/i).optional().or(z.literal("")),
  bio: z.string().max(1000).optional(),
  avatarDataUrl: z.string().max(1500000).regex(/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/).optional().or(z.literal(""))
});
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

export const PasswordUpdateSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200)
});
export type PasswordUpdate = z.infer<typeof PasswordUpdateSchema>;

export const CreateAgentSchema = z.object({
  id: z.string().min(3).max(80).regex(/^[a-z0-9_-]+$/i).optional(),
  name: z.string().min(1).max(120),
  userId: z.string().min(1).optional()
});
export type CreateAgent = z.infer<typeof CreateAgentSchema>;

export const UiEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.status"), agentId: z.string(), status: z.enum(["online", "offline"]) }),
  z.object({ type: z.literal("agent.activity"), agentId: z.string(), localActivity: LocalCodexActivitySchema }),
  z.object({ type: z.literal("repos.updated"), agentId: z.string(), repos: z.array(RepoInfoSchema) }),
  z.object({ type: z.literal("chats.updated"), agentId: z.string(), repoId: z.string() }),
  z.object({ type: z.literal("job.created"), jobId: z.string() }),
  z.object({ type: z.literal("job.updated"), jobId: z.string(), status: JobStatusSchema }),
  AgentJobProgressSchema,
  AgentJobLogSchema
]);
export type UiEvent = z.infer<typeof UiEventSchema>;
