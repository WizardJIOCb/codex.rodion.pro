import type { RepoInfo } from "@cmc/protocol";
import type { AgentConfig, RepoConfig } from "./config.js";
import { runCapture } from "./process-utils.js";

function maskPath(path: string): string {
  return path.replace(/^([A-Z]:\\Users\\)[^\\]+/i, "$1...");
}

export async function scanRepo(repo: RepoConfig): Promise<RepoInfo> {
  const branch = await runCapture("git", ["-C", repo.path, "branch", "--show-current"], undefined, 15000);
  const status = await runCapture("git", ["-C", repo.path, "status", "--short"], undefined, 15000);
  return {
    id: repo.id,
    name: repo.name,
    pathMasked: maskPath(repo.path),
    githubUrl: repo.githubUrl,
    serverPath: repo.serverPath,
    domain: repo.domain,
    deploy: repo.deploy,
    currentBranch: branch.stdout.trim() || undefined,
    dirty: status.stdout.trim().length > 0,
    defaultSandbox: repo.defaultSandbox,
    allowedSandboxes: repo.allowedSandboxes,
    testCommands: repo.testCommands.map((command) => ({ id: command.id, label: command.label }))
  };
}

export async function scanRepos(config: AgentConfig): Promise<RepoInfo[]> {
  return Promise.all(config.repos.map(scanRepo));
}
