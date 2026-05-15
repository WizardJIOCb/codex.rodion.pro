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

export const AgentJobDoneSchema = z.object({
  type: z.literal("job.done"),
  jobId: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int().nullable(),
  finalMessage: z.string().optional(),
  gitStatus: z.string().optional(),
  gitDiffStat: z.string().optional(),
  gitDiff: z.string().optional(),
  branchName: z.string().optional()
});

export const AgentToServerSchema = z.discriminatedUnion("type", [
  AgentHelloSchema,
  AgentHeartbeatSchema,
  AgentJobLogSchema,
  AgentJobDoneSchema
]);
export type AgentToServer = z.infer<typeof AgentToServerSchema>;

export const ServerJobRunSchema = z.object({
  type: z.literal("job.run"),
  job: z.object({
    id: z.string().min(1),
    repoId: z.string().min(1),
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

export const ServerToAgentSchema = z.discriminatedUnion("type", [
  ServerJobRunSchema,
  ServerJobCancelSchema,
  z.object({ type: z.literal("repo.scan") })
]);
export type ServerToAgent = z.infer<typeof ServerToAgentSchema>;

export const CreateJobSchema = z.object({
  repoId: z.string().min(1),
  agentId: z.string().min(1),
  prompt: z.string().min(3).max(16000),
  sandbox: SandboxSchema,
  branchMode: z.enum(["current", "create-per-job"]).default("current")
});
export type CreateJob = z.infer<typeof CreateJobSchema>;

export const UiEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.status"), agentId: z.string(), status: z.enum(["online", "offline"]) }),
  z.object({ type: z.literal("repos.updated"), agentId: z.string(), repos: z.array(RepoInfoSchema) }),
  z.object({ type: z.literal("job.created"), jobId: z.string() }),
  z.object({ type: z.literal("job.updated"), jobId: z.string(), status: JobStatusSchema }),
  AgentJobLogSchema
]);
export type UiEvent = z.infer<typeof UiEventSchema>;
