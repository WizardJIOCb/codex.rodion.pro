import os from "node:os";
import { mkdirSync } from "node:fs";
import WebSocket from "ws";
import { ServerToAgentSchema, type AgentToServer, type CodexUsage, type ServerToAgent } from "@cmc/protocol";
import { loadAgentConfig, saveAgentConfig } from "./config.js";
import { Runner } from "./codex-runner.js";
import { detectLocalCodexActivity } from "./local-activity.js";
import { syncLocalChats } from "./local-chat-sync.js";
import { runCapture } from "./process-utils.js";
import { makeRedactor } from "./redact.js";
import { scanRepos } from "./repo-scanner.js";

const LOCAL_CHAT_SYNC_INTERVAL_MS = 15000;
const LOCAL_ACTIVITY_INTERVAL_MS = 10000;
const config = loadAgentConfig();
const redact = makeRedactor(config.redactPatterns);
const token = process.env[config.tokenEnv];
if (!token) throw new Error(`Missing agent token env var: ${config.tokenEnv}`);

let currentRunner: Runner | null = null;
let currentJobId: string | undefined;
let cachedCodexUsage: CodexUsage | undefined;
let cachedCodexUsageAt = 0;

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

async function sendDeployResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "deploy.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    repos: await scanRepos(config)
  });
}

async function sendNginxResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "nginx.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
    repos: ok ? await scanRepos(config) : undefined
  });
}

async function sendSslResult(
  send: (message: AgentToServer) => void,
  requestId: string,
  ok: boolean,
  output: string,
  error?: string
) {
  send({
    type: "ssl.result",
    requestId,
    ok,
    output: redact(output),
    error: error ? redact(error) : undefined,
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

async function deployProject(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.serverPath) throw new Error("Project server folder is not configured.");
  if (!repo.deploy) throw new Error("Project deploy settings are not configured.");
  if (!repo.serverPath.replace(/\\/g, "/").startsWith("/var/www/")) {
    throw new Error("Refusing to deploy outside /var/www.");
  }

  const output: string[] = [];
  const runStep = async (label: string, command: string, args: string[], cwd = repo.path, timeoutMs = 120000) => {
    output.push(`$ ${label}`);
    const result = await runCapture(command, args, cwd, timeoutMs);
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (text) output.push(text);
    if (result.exitCode !== 0) throw new Error([...output, `${label} failed with exit code ${result.exitCode}`].join("\n"));
    return result;
  };

  const build = repo.deploy.buildCommand;
  if (build) await runStep([build.command, ...build.args].join(" "), build.command, build.args, repo.path, build.timeoutMs);

  const sourceDir = resolveProjectPath(repo.path, repo.deploy.sourceDir);
  const sourceForScp = `${sourceDir.replace(/\\/g, "/")}/.`;
  const remotePath = repo.serverPath.replace(/\/+$/g, "");
  const remoteSubdir = normalizeRemoteSubdir(repo.deploy.remoteSubdir);
  const deployPath = remoteSubdir ? `${remotePath}/${remoteSubdir}` : remotePath;
  const quotedDeployPath = shellQuote(deployPath);
  const cleanCommand = repo.deploy.cleanRemote
    ? `mkdir -p ${quotedDeployPath} && find ${quotedDeployPath} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`
    : `mkdir -p ${quotedDeployPath}`;

  await runStep(`ssh ${repo.deploy.sshTarget} prepare ${deployPath}`, "ssh", [repo.deploy.sshTarget, cleanCommand], repo.path, 60000);
  await runStep(`scp ${sourceForScp} ${repo.deploy.sshTarget}:${deployPath}/`, "scp", ["-r", sourceForScp, `${repo.deploy.sshTarget}:${deployPath}/`], repo.path, 180000);
  await runStep(`ssh ${repo.deploy.sshTarget} permissions ${deployPath}`, "ssh", [repo.deploy.sshTarget, `chown -R www-data:www-data ${quotedDeployPath} 2>/dev/null || true`], repo.path, 60000);
  return [...output, `Deploy completed: ${repo.domain ? `https://${repo.domain}` : deployPath}`].join("\n");
}

async function configureNginx(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.serverPath) throw new Error("Project server folder is not configured.");
  if (!repo.domain) throw new Error("Project domain is not configured.");
  if (!repo.deploy?.sshTarget) throw new Error("Project deploy SSH target is not configured.");
  if (!isSafeDomain(repo.domain)) throw new Error("Project domain is not safe for nginx config.");
  if (!repo.serverPath.replace(/\\/g, "/").startsWith("/var/www/")) {
    throw new Error("Refusing to configure nginx outside /var/www.");
  }

  const remotePath = repo.serverPath.replace(/\/+$/g, "");
  const availablePath = `/etc/nginx/sites-available/${repo.domain}`;
  const enabledPath = `/etc/nginx/sites-enabled/${repo.domain}`;
  const certificatePath = `/etc/letsencrypt/live/${repo.domain}/fullchain.pem`;
  const certificateKeyPath = `/etc/letsencrypt/live/${repo.domain}/privkey.pem`;
  const staticLocations = [
    "    location / {",
    "        try_files $uri $uri/ /index.html;",
    "    }",
    "",
    "    location ~* \\.(?:css|js|mjs|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$ {",
    "        expires 7d;",
    "        access_log off;",
    "        try_files $uri =404;",
    "    }"
  ];
  const httpConfig = [
    "# Generated by codex.rodion.pro",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${repo.domain};`,
    `    root ${remotePath};`,
    "    index index.html;",
    "",
    ...staticLocations,
    "}",
    ""
  ].join("\n");
  const sslConfig = [
    "# Generated by codex.rodion.pro",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${repo.domain};`,
    "    return 301 https://$host$request_uri;",
    "}",
    "",
    "server {",
    "    listen 443 ssl;",
    "    listen [::]:443 ssl;",
    `    server_name ${repo.domain};`,
    `    root ${remotePath};`,
    "    index index.html;",
    `    ssl_certificate ${certificatePath};`,
    `    ssl_certificate_key ${certificateKeyPath};`,
    "    include /etc/letsencrypt/options-ssl-nginx.conf;",
    "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;",
    "",
    ...staticLocations,
    "}",
    ""
  ].join("\n");
  const encodedHttpConfig = Buffer.from(httpConfig, "utf8").toString("base64");
  const encodedSslConfig = Buffer.from(sslConfig, "utf8").toString("base64");
  const remoteCommand = [
    `sudo mkdir -p ${shellQuote(remotePath)}`,
    `if [ -f ${shellQuote(certificatePath)} ] && [ -f ${shellQuote(certificateKeyPath)} ]; then printf %s ${shellQuote(encodedSslConfig)} | base64 -d | sudo tee ${shellQuote(availablePath)} >/dev/null; else printf %s ${shellQuote(encodedHttpConfig)} | base64 -d | sudo tee ${shellQuote(availablePath)} >/dev/null; fi`,
    `sudo ln -sfn ${shellQuote(availablePath)} ${shellQuote(enabledPath)}`,
    "sudo nginx -t",
    "sudo systemctl reload nginx"
  ].join(" && ");
  const result = await runCapture("ssh", [repo.deploy.sshTarget, remoteCommand], repo.path, 120000);
  const output = [`$ ssh ${repo.deploy.sshTarget} configure nginx ${repo.domain}`];
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (text) output.push(text);
  if (result.exitCode !== 0) throw new Error([...output, `Nginx configure failed with exit code ${result.exitCode}`].join("\n"));
  return [...output, `Nginx configured: ${repo.domain}`].join("\n");
}

async function configureSsl(repoId: string): Promise<string> {
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error("Project not found in agent config.");
  if (!repo.domain) throw new Error("Project domain is not configured.");
  if (!repo.deploy?.sshTarget) throw new Error("Project deploy SSH target is not configured.");
  if (!isSafeDomain(repo.domain)) throw new Error("Project domain is not safe for certbot config.");

  const output: string[] = [];
  output.push(await configureNginx(repoId));
  const certbotCommand = [
    "sudo certbot --nginx",
    `-d ${shellQuote(repo.domain)}`,
    "--non-interactive",
    "--agree-tos",
    "--redirect",
    "--keep-until-expiring",
    "--register-unsafely-without-email",
    "&& sudo nginx -t",
    "&& sudo systemctl reload nginx"
  ].join(" ");
  const result = await runCapture("ssh", [repo.deploy.sshTarget, certbotCommand], repo.path, 300000);
  output.push(`$ ssh ${repo.deploy.sshTarget} certbot ${repo.domain}`);
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (text) output.push(text);
  if (result.exitCode !== 0) throw new Error([...output, `SSL configure failed with exit code ${result.exitCode}`].join("\n"));
  return [...output, `SSL configured: https://${repo.domain}`].join("\n");
}

function isSafeDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i.test(value);
}

function resolveProjectPath(projectPath: string, childPath: string): string {
  if (/^[a-z]:[\\/]/i.test(childPath) || childPath.startsWith("\\\\")) return childPath;
  return `${projectPath.replace(/[\\/]+$/g, "")}\\${childPath.replace(/^[\\/]+/g, "")}`;
}

function normalizeRemoteSubdir(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return undefined;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Deploy remote subdir is not safe.");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error("Deploy remote subdir is not safe.");
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function toolVersion(command: string, args = ["--version"]): Promise<string | undefined> {
  const executable = command === "codex" ? codexExecutable() : { command, args: [] };
  const result = await runCapture(executable.command, [...executable.args, ...args], undefined, 15000);
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

async function probeCodexUsage(force = false): Promise<CodexUsage> {
  const cacheTtlMs = 10 * 60 * 1000;
  if (!force && cachedCodexUsage && Date.now() - cachedCodexUsageAt < cacheTtlMs) return cachedCodexUsage;

  const checkedAt = new Date().toISOString();
  try {
    const executable = codexExecutable();
    const result = await runCapture(executable.command, [...executable.args, "login", "status"], undefined, 15000);
    const rawStatus = (result.stdout || result.stderr).trim();
    const signedIn = result.exitCode === 0 && /logged in/i.test(rawStatus);
    cachedCodexUsage = {
      status: signedIn ? "signed-in" : "signed-out",
      summary: signedIn
        ? "Signed in. Exact remaining Codex limit is not exposed by the local CLI yet."
        : rawStatus || "Codex account is not signed in.",
      source: "codex login status",
      checkedAt
    };
  } catch (error) {
    cachedCodexUsage = {
      status: "unavailable",
      summary: error instanceof Error ? error.message : "Could not read Codex account status.",
      source: "codex login status",
      checkedAt
    };
  }
  cachedCodexUsageAt = Date.now();
  return cachedCodexUsage;
}

function codexExecutable(): { command: string; args: string[] } {
  if (process.env.CMC_CODEX_NODE && process.env.CMC_CODEX_JS) {
    return { command: process.env.CMC_CODEX_NODE, args: [process.env.CMC_CODEX_JS] };
  }
  return { command: process.env.CMC_CODEX_BIN || "codex", args: [] };
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function hello(): Promise<AgentToServer> {
  const [repos, codexVersion, gitVersion, codexUsage] = await Promise.all([
    scanRepos(config),
    toolVersion("codex"),
    toolVersion("git", ["--version"]),
    probeCodexUsage(true)
  ]);
  return {
    type: "agent.hello",
    agentId: config.agentId,
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    agentVersion: "0.1.0",
    codexVersion,
    gitVersion,
    codexUsage,
    localActivity: detectLocalCodexActivity(config, currentJobId),
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
        localActivity: detectLocalCodexActivity(config, currentJobId),
        codexUsage: await probeCodexUsage(),
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
          deploy: message.project.deploy ?? undefined,
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
        if ("deploy" in message.patch) repo.deploy = message.patch.deploy ?? undefined;
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

    if (message.type === "project.delete") {
      try {
        const index = config.repos.findIndex((item) => item.id === message.repoId);
        if (index === -1) throw new Error("Project not found in agent config.");
        config.repos.splice(index, 1);
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

    if (message.type === "project.deploy") {
      try {
        const output = await deployProject(message.repoId);
        await sendDeployResult(send, message.requestId, true, output);
      } catch (error) {
        await sendDeployResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (message.type === "project.nginx") {
      try {
        const output = await configureNginx(message.repoId);
        await sendNginxResult(send, message.requestId, true, output);
      } catch (error) {
        await sendNginxResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (message.type === "project.ssl") {
      try {
        const output = await configureSsl(message.repoId);
        await sendSslResult(send, message.requestId, true, output);
      } catch (error) {
        await sendSslResult(send, message.requestId, false, "", error instanceof Error ? error.message : String(error));
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
    send({
      type: "agent.heartbeat",
      currentJobId,
      localActivity: detectLocalCodexActivity(config, currentJobId),
      codexUsage: await probeCodexUsage(),
      repos: await scanRepos(config)
    });
  }, config.heartbeatIntervalMs);
  const chatSync = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    await syncLocalChats(config, send).catch((error) => console.error(`Local chat sync failed: ${error.message}`));
  }, Math.max(Math.min(config.heartbeatIntervalMs, LOCAL_CHAT_SYNC_INTERVAL_MS), 5000));
  const activitySync = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    send({
      type: "agent.heartbeat",
      currentJobId,
      localActivity: detectLocalCodexActivity(config, currentJobId)
    });
  }, LOCAL_ACTIVITY_INTERVAL_MS);

  ws.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(chatSync);
    clearInterval(activitySync);
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
