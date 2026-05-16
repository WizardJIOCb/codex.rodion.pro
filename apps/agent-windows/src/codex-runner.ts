import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentJobDone, AgentJobLog, AgentJobProgress } from "./types.js";
import type { AgentConfig, RepoConfig } from "./config.js";
import { minimalEnv, needsShell, runCapture } from "./process-utils.js";

type RunContext = {
  config: AgentConfig;
  job: {
    id: string;
    repoId: string;
    prompt: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    branchMode: "current" | "create-per-job";
    kind: "codex" | "test";
    testCommandId?: string;
  };
  sendLog: (log: AgentJobLog) => void;
  sendProgress: (progress: AgentJobProgress) => void;
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
      context.sendProgress(progress(context.job.id, "fake", line, { filesChanged: 0, added: 0, deleted: 0 }));
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
    const codexCommand = codexExecutable();
    const args = [
      ...codexCommand.prefixArgs,
      "exec",
      "-C",
      repo.path,
      "--sandbox",
      context.job.sandbox,
      "--json",
      "-c",
      "approval_policy=\"never\"",
      "-"
    ];
    return this.spawnAndCollect(context, repo, codexCommand.command, args, context.config.maxJobDurationMs, context.job.prompt);
  }

  private spawnAndCollect(context: RunContext, repo: RepoConfig, command: string, args: string[], timeoutMs: number, stdinInput?: string): Promise<AgentJobDone> {
    return new Promise((resolve) => {
      context.sendLog(log(context.job.id, "system", `Starting ${command} ${args.slice(0, 4).join(" ")} ...`));
      context.sendProgress(progress(context.job.id, "starting", `Starting ${command}.`));
      this.child = spawn(command, args, {
        cwd: repo.path,
        shell: needsShell(command),
        windowsHide: true,
        env: minimalEnv()
      });
      this.child.stdin.end(stdinInput);
      let finalMessage = "";
      let rawOutputTail = "";
      let codexThreadId: string | undefined;
      let progressBusy = false;
      const timer = setTimeout(() => {
        this.cancelled = true;
        this.child?.kill();
      }, timeoutMs);
      const progressTimer = setInterval(async () => {
        if (progressBusy) return;
        progressBusy = true;
        try {
          const stats = await diffProgress(repo.path);
          context.sendProgress(progress(context.job.id, "working", "Checking current git diff.", stats));
        } finally {
          progressBusy = false;
        }
      }, 4000);
      const emit = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          if (stream === "stdout") {
            const handled = handleCodexJsonLine(context, line);
            if (handled.handled) {
              if (handled.threadId) codexThreadId = handled.threadId;
              if (handled.messageText) finalMessage = handled.messageText.slice(-4000);
              continue;
            }
          }
          if (stream === "stderr" && isIgnorableCodexWarning(line)) continue;
          rawOutputTail = `${rawOutputTail}\n${line}`.slice(-4000);
          context.sendLog(log(context.job.id, stream, line));
          if (stream === "stderr") context.sendProgress(progress(context.job.id, "message", line.slice(0, 500)));
        }
      };
      this.child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
      this.child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));
      this.child.on("error", (error) => {
        clearTimeout(timer);
        clearInterval(progressTimer);
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
        clearInterval(progressTimer);
        const gitStatus = await runCapture("git", ["-C", repo.path, "status", "--short"]);
        const gitDiffStat = await runCapture("git", ["-C", repo.path, "diff", "--stat"]);
        const gitDiff = await runCapture("git", ["-C", repo.path, "diff", "--", "."], undefined, 30000);
        context.sendProgress(progress(
          context.job.id,
          this.cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
          this.cancelled ? "Job cancelled." : exitCode === 0 ? "Codex finished." : "Codex process failed.",
          await diffProgress(repo.path)
        ));
        resolve({
          type: "job.done",
          jobId: context.job.id,
          status: this.cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
          exitCode,
          finalMessage: finalMessage || rawOutputTail.trim() || (exitCode === 0 ? "Completed." : "Process failed."),
          gitStatus: gitStatus.stdout,
          gitDiffStat: gitDiffStat.stdout,
          gitDiff: truncate(gitDiff.stdout, 120000),
          codexThreadId
        });
      });
    });
  }
}

function codexExecutable(): { command: string; prefixArgs: string[] } {
  if (process.env.CMC_CODEX_NODE && process.env.CMC_CODEX_JS) {
    return { command: process.env.CMC_CODEX_NODE, prefixArgs: [process.env.CMC_CODEX_JS] };
  }
  return { command: process.env.CMC_CODEX_BIN || "codex", prefixArgs: [] };
}

function isIgnorableCodexWarning(line: string): boolean {
  return /ERROR\s+codex_core::session:\s+failed to record rollout items:\s+thread .* not found/i.test(line);
}

function log(jobId: string, stream: "stdout" | "stderr" | "system", message: string): AgentJobLog {
  return { type: "job.log", jobId, stream, message, at: new Date().toISOString() };
}

function progress(
  jobId: string,
  phase: string,
  message: string,
  stats?: { filesChanged: number; added: number; deleted: number }
): AgentJobProgress {
  return { type: "job.progress", jobId, phase, message, at: new Date().toISOString(), ...stats };
}

async function diffProgress(repoPath: string): Promise<{ filesChanged: number; added: number; deleted: number }> {
  const result = await runCapture("git", ["-C", repoPath, "diff", "--numstat"], undefined, 15000);
  let filesChanged = 0;
  let added = 0;
  let deleted = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [add, del] = line.split(/\s+/);
    filesChanged += 1;
    const addedNumber = Number(add);
    const deletedNumber = Number(del);
    if (Number.isFinite(addedNumber)) added += addedNumber;
    if (Number.isFinite(deletedNumber)) deleted += deletedNumber;
  }
  return { filesChanged, added, deleted };
}

function handleCodexJsonLine(context: RunContext, line: string): { handled: boolean; threadId?: string; messageText?: string } {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { handled: false };
  }
  if (!event || typeof event !== "object") return { handled: false };
  const item = "item" in event && event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
  const type = "type" in event ? String(event.type) : "";

  if (type === "thread.started") {
    context.sendProgress(progress(context.job.id, "started", "Codex thread started."));
    const threadId = "thread_id" in event && typeof event.thread_id === "string" ? event.thread_id : undefined;
    return { handled: true, threadId };
  }
  if (type === "turn.started") {
    context.sendProgress(progress(context.job.id, "thinking", "Codex is thinking."));
    return { handled: true };
  }
  if (type === "item.started" && item?.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "command";
    const summary = summarizeCommand(command);
    context.sendProgress(progress(context.job.id, "command", `Running: ${summary}`));
    context.sendLog(log(context.job.id, "system", `Running: ${summary}`));
    return { handled: true };
  }
  if (type === "item.completed" && item?.type === "agent_message") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text) {
      context.sendProgress(progress(context.job.id, "message", text.slice(0, 500)));
      context.sendLog(log(context.job.id, "stdout", text));
    }
    return { handled: true, messageText: text };
  }
  if (type === "item.completed" && item?.type === "command_execution") {
    const status = typeof item.status === "string" ? item.status : "completed";
    const command = typeof item.command === "string" ? summarizeCommand(item.command) : "command";
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";
    context.sendProgress(progress(context.job.id, "command", `${command}: ${status}.`));
    context.sendLog(log(context.job.id, status === "failed" ? "stderr" : "system", `${command}: ${status}.`));
    if (output) context.sendLog(log(context.job.id, status === "failed" ? "stderr" : "stdout", output.slice(0, 4000)));
    return { handled: true };
  }

  return { handled: true };
}

function summarizeCommand(command: string): string {
  return command
    .replace(/"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"\s+-Command\s+/i, "")
    .replace(/^powershell(?:\.exe)?\s+-Command\s+/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[diff truncated]`;
}
