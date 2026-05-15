import os from "node:os";
import { mkdirSync } from "node:fs";
import WebSocket from "ws";
import { ServerToAgentSchema, type AgentToServer, type ServerToAgent } from "@cmc/protocol";
import { loadAgentConfig, saveAgentConfig } from "./config.js";
import { Runner } from "./codex-runner.js";
import { runCapture } from "./process-utils.js";
import { makeRedactor } from "./redact.js";
import { scanRepos } from "./repo-scanner.js";

const config = loadAgentConfig();
const redact = makeRedactor(config.redactPatterns);
const token = process.env[config.tokenEnv];
if (!token) throw new Error(`Missing agent token env var: ${config.tokenEnv}`);

let currentRunner: Runner | null = null;
let currentJobId: string | undefined;

async function ensureGitRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  const probe = await runCapture("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], undefined, 15000);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    const init = await runCapture("git", ["-C", path, "init"], undefined, 30000);
    if (init.exitCode !== 0) throw new Error(init.stderr || "git init failed");
  }
}

async function sendProjectResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  error?: string
) {
  send({
    type: "project.result",
    requestId,
    ok,
    error,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function toolVersion(command: string, args = ["--version"]): Promise<string | undefined> {
  const result = await runCapture(command, args, undefined, 15000);
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

async function hello(): Promise<AgentToServer> {
  const [repos, codexVersion, gitVersion] = await Promise.all([
    scanRepos(config),
    toolVersion("codex"),
    toolVersion("git", ["--version"])
  ]);
  return {
    type: "agent.hello",
    agentId: config.agentId,
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    agentVersion: "0.1.0",
    codexVersion,
    gitVersion,
    repos
  };
}

function connect() {
  const ws = new WebSocket(config.serverUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const send = (message: AgentToServer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  ws.on("open", async () => {
    console.log(`Connected to ${config.serverUrl}`);
    for (const delay of [250, 1000, 3000]) {
      setTimeout(async () => send(await hello()), delay);
    }
  });

  ws.on("message", async (raw) => {
    let message: ServerToAgent;
    try {
      message = ServerToAgentSchema.parse(JSON.parse(raw.toString()));
    } catch (error) {
      console.error("Invalid server message", error);
      return;
    }

    if (message.type === "repo.scan") {
      send({
        type: "agent.heartbeat",
        currentJobId,
        repos: await scanRepos(config)
      });
      return;
    }

    if (message.type === "job.cancel") {
      if (message.jobId === currentJobId) currentRunner?.cancel();
      return;
    }

    if (message.type === "project.create") {
      try {
        if (config.repos.some((repo) => repo.id === message.project.id)) throw new Error("Project id already exists.");
        await ensureGitRepo(message.project.path);
        config.repos.push({
          id: message.project.id,
          name: message.project.name,
          path: message.project.path,
          defaultSandbox: message.project.defaultSandbox,
          allowedSandboxes: message.project.allowedSandboxes,
          testCommands: []
        });
        saveAgentConfig(config);
        await sendProjectResult(send, message.requestId, true);
      } catch (error) {
        await sendProjectResult(send, message.requestId, false, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (message.type === "project.update") {
      try {
        const repo = config.repos.find((item) => item.id === message.repoId);
        if (!repo) throw new Error("Project not found in agent config.");
        if (message.patch.path) {
          await ensureGitRepo(message.patch.path);
          repo.path = message.patch.path;
        }
        if (message.patch.name) repo.name = message.patch.name;
        if (message.patch.defaultSandbox) repo.defaultSandbox = message.patch.defaultSandbox;
        if (message.patch.allowedSandboxes) repo.allowedSandboxes = message.patch.allowedSandboxes;
        if (!repo.allowedSandboxes.includes(repo.defaultSandbox)) repo.defaultSandbox = repo.allowedSandboxes[0] ?? "read-only";
        saveAgentConfig(config);
        await sendProjectResult(send, message.requestId, true);
      } catch (error) {
        await sendProjectResult(send, message.requestId, false, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (message.type === "job.run") {
      if (currentRunner) {
        send({
          type: "job.done",
          jobId: message.job.id,
          status: "failed",
          exitCode: 1,
          finalMessage: "Agent is already running another job."
        });
        return;
      }
      currentJobId = message.job.id;
      currentRunner = new Runner();
      try {
        const result = await currentRunner.run({
          config,
          job: message.job,
          sendLog: (log) => send({ ...log, message: redact(log.message) })
        });
        send({
          ...result,
          finalMessage: result.finalMessage ? redact(result.finalMessage) : undefined,
          gitStatus: result.gitStatus ? redact(result.gitStatus) : undefined,
          gitDiffStat: result.gitDiffStat ? redact(result.gitDiffStat) : undefined,
          gitDiff: result.gitDiff ? redact(result.gitDiff) : undefined
        });
      } catch (error) {
        send({
          type: "job.done",
          jobId: message.job.id,
          status: "failed",
          exitCode: 1,
          finalMessage: redact(error instanceof Error ? error.message : String(error))
        });
      } finally {
        currentRunner = null;
        currentJobId = undefined;
      }
    }
  });

  const heartbeat = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    send({ type: "agent.heartbeat", currentJobId, repos: await scanRepos(config) });
  }, config.heartbeatIntervalMs);

  ws.on("close", () => {
    clearInterval(heartbeat);
    console.log("Disconnected. Reconnecting soon...");
    setTimeout(connect, 3000);
  });

  ws.on("error", (error) => {
    console.error(error.message);
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "doctor") {
    console.log(await hello());
    return;
  }
  if (command === "scan-repos") {
    console.log(JSON.stringify(await scanRepos(config), null, 2));
    return;
  }
  connect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
