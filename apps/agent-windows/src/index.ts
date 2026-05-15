import os from "node:os";
import { mkdirSync } from "node:fs";
import WebSocket from "ws";
import { ServerToAgentSchema, type AgentToServer, type ServerToAgent } from "@cmc/protocol";
import { loadAgentConfig, saveAgentConfig } from "./config.js";
import { Runner } from "./codex-runner.js";
import { syncLocalChats } from "./local-chat-sync.js";
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

async function sendGitResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "git.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    status: ok ? await gitStatusLineFromOutput(output) : undefined,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function gitStatusLineFromOutput(output: string): Promise<string> {
  const lastLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return lastLine ?? "Git sync completed.";
}

async function gitSync(repoId: string, message: string, remoteUrl?: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  await ensureGitRepo(repo.path);

  const output: string[] = [];
  const runGit = async (args: string[], timeoutMs = 60000, allowExitCodes = [0]) => {
    const result = await runCapture("git", ["-C", repo.path, ...args], undefined, timeoutMs);
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    output.push(`$ git ${args.join(" ")}`);
    if (text) output.push(text);
    if (!allowExitCodes.includes(result.exitCode ?? -1)) {
      throw new Error(text || `git ${args.join(" ")} failed with exit code ${result.exitCode}`);
    }
    return result;
  };

  if (remoteUrl) {
    const currentRemote = await runGit(["remote", "get-url", "origin"], 15000, [0, 2, 128]);
    if (currentRemote.exitCode === 0) await runGit(["remote", "set-url", "origin", remoteUrl], 15000);
    else await runGit(["remote", "add", "origin", remoteUrl], 15000);
  } else {
    await runGit(["remote", "get-url", "origin"], 15000);
  }

  await runGit(["add", "-A"], 60000);
  const staged = await runGit(["diff", "--cached", "--quiet"], 30000, [0, 1]);
  if (staged.exitCode === 1) {
    await runGit(["commit", "-m", message], 120000);
  } else {
    output.push("No staged changes to commit.");
  }

  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 15000, [0, 128]);
  let branch = (await runGit(["branch", "--show-current"], 15000)).stdout.trim();
  if (!branch) branch = "main";
  if (upstream.exitCode !== 0 && branch === "master") {
    await runGit(["branch", "-M", "main"], 30000);
    branch = "main";
  }
  await runGit(["push", "-u", "origin", branch], 120000);
  const status = await runGit(["status", "--short", "--branch"], 15000);
  return [...output, status.stdout.trim() || "Git sync completed."].filter(Boolean).join("\n");
}

async function toolVersion(command: string, args = ["--version"]): Promise<string | undefined> {
  const result = await runCapture(command, args, undefined, 15000);
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    setTimeout(() => syncLocalChats(config, send).catch((error) => console.error(`Local chat sync failed: ${error.message}`)), 5000);
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
          githubUrl: optionalText(message.project.githubUrl),
          serverPath: optionalText(message.project.serverPath),
          domain: optionalText(message.project.domain),
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
        if ("githubUrl" in message.patch) repo.githubUrl = optionalText(message.patch.githubUrl);
        if ("serverPath" in message.patch) repo.serverPath = optionalText(message.patch.serverPath);
        if ("domain" in message.patch) repo.domain = optionalText(message.patch.domain);
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

    if (message.type === "git.sync") {
      try {
        const output = await gitSync(message.repoId, message.message, message.remoteUrl);
        await sendGitResult(send, message.requestId, true, output);
      } catch (error) {
        await sendGitResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
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
          sendLog: (log) => send({ ...log, message: redact(log.message) }),
          sendProgress: (progress) => send({ ...progress, message: redact(progress.message) })
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
  const chatSync = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    await syncLocalChats(config, send).catch((error) => console.error(`Local chat sync failed: ${error.message}`));
  }, Math.max(config.heartbeatIntervalMs * 3, 60000));

  ws.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(chatSync);
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
