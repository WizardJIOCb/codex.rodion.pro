import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentJobDone, AgentJobLog } from "./types.js";
import type { AgentConfig, RepoConfig } from "./config.js";
import { minimalEnv, runCapture } from "./process-utils.js";

type RunContext = {
  config: AgentConfig;
  job: {
    id: string;
    repoId: string;
    prompt: string;
    sandbox: "read-only" | "workspace-write";
    branchMode: "current" | "create-per-job";
    kind: "codex" | "test";
    testCommandId?: string;
  };
  sendLog: (log: AgentJobLog) => void;
};

export class Runner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelled = false;

  cancel() {
    this.cancelled = true;
    if (this.child) this.child.kill();
  }

  async run(context: RunContext): Promise<AgentJobDone> {
    const repo = context.config.repos.find((item) => item.id === context.job.repoId);
    if (!repo) throw new Error(`Repo not allowed: ${context.job.repoId}`);
    if (!repo.allowedSandboxes.includes(context.job.sandbox)) throw new Error(`Sandbox not allowed: ${context.job.sandbox}`);
    if (context.config.fakeRunner || process.env.CMC_FAKE_RUNNER === "1") return this.runFake(context, repo);
    if (context.job.kind === "test") return this.runTest(context, repo);
    return this.runCodex(context, repo);
  }

  private async runFake(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const lines = [
      `Connected to ${repo.name}.`,
      `Sandbox: ${context.job.sandbox}.`,
      "Reading prompt and preparing a safe Codex task.",
      "Streaming fake output for mobile/WebSocket verification.",
      "Done. Switch fakeRunner off to run real codex exec."
    ];
    for (const line of lines) {
      if (this.cancelled) break;
      context.sendLog(log(context.job.id, "stdout", line));
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const gitStatus = await runCapture("git", ["-C", repo.path, "status", "--short"]);
    const gitDiffStat = await runCapture("git", ["-C", repo.path, "diff", "--stat"]);
    const gitDiff = await runCapture("git", ["-C", repo.path, "diff", "--", "."], undefined, 30000);
    return {
      type: "job.done",
      jobId: context.job.id,
      status: this.cancelled ? "cancelled" : "completed",
      exitCode: this.cancelled ? null : 0,
      finalMessage: this.cancelled ? "Job cancelled." : "Fake runner completed successfully.",
      gitStatus: gitStatus.stdout,
      gitDiffStat: gitDiffStat.stdout,
      gitDiff: truncate(gitDiff.stdout, 120000)
    };
  }

  private async runTest(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const command = repo.testCommands.find((item) => item.id === context.job.testCommandId);
    if (!command) throw new Error(`Test command not allowed: ${context.job.testCommandId}`);
    return this.spawnAndCollect(context, repo, command.command, command.args, command.timeoutMs);
  }

  private async runCodex(context: RunContext, repo: RepoConfig): Promise<AgentJobDone> {
    const args = [
      "exec",
      "-C",
      repo.path,
      "--sandbox",
      context.job.sandbox,
      "--json",
      "-c",
      "approval_policy=\"never\"",
      context.job.prompt
    ];
    return this.spawnAndCollect(context, repo, "codex", args, context.config.maxJobDurationMs);
  }

  private spawnAndCollect(context: RunContext, repo: RepoConfig, command: string, args: string[], timeoutMs: number): Promise<AgentJobDone> {
    return new Promise((resolve) => {
      context.sendLog(log(context.job.id, "system", `Starting ${command} ${args.slice(0, 4).join(" ")} ...`));
      this.child = spawn(command, args, {
        cwd: repo.path,
        shell: false,
        windowsHide: true,
        env: minimalEnv()
      });
      this.child.stdin.end();
      let finalMessage = "";
      const timer = setTimeout(() => {
        this.cancelled = true;
        this.child?.kill();
      }, timeoutMs);
      const emit = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString();
        finalMessage = text.slice(-4000);
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          context.sendLog(log(context.job.id, stream, line));
        }
      };
      this.child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
      this.child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));
      this.child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          type: "job.done",
          jobId: context.job.id,
          status: "failed",
          exitCode: 127,
          finalMessage: error.message
        });
      });
      this.child.on("close", async (exitCode) => {
        clearTimeout(timer);
        const gitStatus = await runCapture("git", ["-C", repo.path, "status", "--short"]);
        const gitDiffStat = await runCapture("git", ["-C", repo.path, "diff", "--stat"]);
        const gitDiff = await runCapture("git", ["-C", repo.path, "diff", "--", "."], undefined, 30000);
        resolve({
          type: "job.done",
          jobId: context.job.id,
          status: this.cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
          exitCode,
          finalMessage: finalMessage || (exitCode === 0 ? "Completed." : "Process failed."),
          gitStatus: gitStatus.stdout,
          gitDiffStat: gitDiffStat.stdout,
          gitDiff: truncate(gitDiff.stdout, 120000)
        });
      });
    });
  }
}

function log(jobId: string, stream: "stdout" | "stderr" | "system", message: string): AgentJobLog {
  return { type: "job.log", jobId, stream, message, at: new Date().toISOString() };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[diff truncated]`;
}
