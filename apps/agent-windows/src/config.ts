import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const TestCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(900000)
});

const DeployConfigSchema = z.object({
  sshTarget: z.string().min(1),
  sourceDir: z.string().min(1).default("dist"),
  cleanRemote: z.boolean().default(true),
  buildCommand: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(900000)
  }).optional()
});

const RepoConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  githubUrl: z.string().max(300).optional(),
  serverPath: z.string().max(260).optional(),
  domain: z.string().max(253).optional(),
  deploy: DeployConfigSchema.optional(),
  defaultSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  allowedSandboxes: z.array(z.enum(["read-only", "workspace-write", "danger-full-access"])).min(1),
  testCommands: z.array(TestCommandSchema).default([])
});

const AgentConfigSchema = z.object({
  agentId: z.string().min(1),
  serverUrl: z.string().url(),
  tokenEnv: z.string().min(1).default("CMC_AGENT_TOKEN"),
  heartbeatIntervalMs: z.number().int().positive().default(20000),
  maxJobDurationMs: z.number().int().positive().default(3600000),
  cancelGraceMs: z.number().int().positive().default(5000),
  maxLogBytesPerJob: z.number().int().positive().default(10485760),
  fakeRunner: z.boolean().optional(),
  repos: z.array(RepoConfigSchema).min(1),
  redactPatterns: z.array(z.string()).default([])
});

export type AgentConfig = z.infer<typeof AgentConfigSchema> & { configPath: string };
export type RepoConfig = AgentConfig["repos"][number];
export type TestCommand = RepoConfig["testCommands"][number];

export function loadAgentConfig(): AgentConfig {
  const argIndex = process.argv.findIndex((arg) => arg === "--config");
  const fromArg = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
  const configPath = resolve(process.cwd(), process.env.CMC_AGENT_CONFIG ?? fromArg ?? "apps/agent-windows/agent.config.json");
  if (!existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);
  const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = AgentConfigSchema.parse(JSON.parse(raw));
  for (const repo of parsed.repos) {
    if (!existsSync(repo.path)) throw new Error(`Repo path does not exist: ${repo.path}`);
  }
  return { ...parsed, configPath };
}

export function saveAgentConfig(config: AgentConfig): void {
  const { configPath, ...persisted } = config;
  writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}
