import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LocalCodexActivity } from "@cmc/protocol";
import type { AgentConfig, RepoConfig } from "./config.js";

const BUSY_WINDOW_MS = 8000;
const BUSY_IDLE_GRACE_MS = 3 * 60 * 1000;

let busyKey = "";
let busySinceMs = 0;
let lastBusySeenMs = 0;
let lastBusyCandidate: Candidate | undefined;

type Candidate = {
  key: string;
  repoId?: string;
  source: string;
  title?: string;
  updatedAt: number;
};

export function detectLocalCodexActivity(config: AgentConfig, currentJobId?: string): LocalCodexActivity {
  const detectedAt = new Date().toISOString();
  if (currentJobId) {
    markBusy(`web:${currentJobId}`, Date.now(), {
      key: `web:${currentJobId}`,
      source: "codex.rodion.pro",
      updatedAt: Date.now()
    });
    return {
      status: "busy",
      summary: "Codex is running a web task from codex.rodion.pro.",
      source: "codex.rodion.pro",
      detectedAt,
      busySinceAt: new Date(busySinceMs).toISOString()
    };
  }

  const candidate = [...recentCodexThreads(config), ...recentVsCodeSessions(config)]
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (candidate && Date.now() - candidate.updatedAt <= BUSY_WINDOW_MS) {
    markBusy(candidate.key, candidate.updatedAt, candidate);
    return {
      status: "busy",
      summary: `${candidate.source} is updating a local Codex chat.`,
      source: candidate.source,
      detectedAt,
      busySinceAt: new Date(busySinceMs).toISOString(),
      repoId: candidate.repoId,
      chatTitle: candidate.title?.slice(0, 160),
      updatedAt: new Date(candidate.updatedAt).toISOString()
    };
  }

  if (busySinceMs && Date.now() - lastBusySeenMs <= BUSY_IDLE_GRACE_MS && lastBusyCandidate) {
    return {
      status: "busy",
      summary: `${lastBusyCandidate.source} is working on a local Codex chat.`,
      source: lastBusyCandidate.source,
      detectedAt,
      busySinceAt: new Date(busySinceMs).toISOString(),
      repoId: lastBusyCandidate.repoId,
      chatTitle: lastBusyCandidate.title?.slice(0, 160),
      updatedAt: new Date(lastBusySeenMs).toISOString()
    };
  }

  busyKey = "";
  busySinceMs = 0;
  lastBusySeenMs = 0;
  lastBusyCandidate = undefined;
  return {
    status: "idle",
    summary: "No recent local Codex activity.",
    source: "agent heartbeat",
    detectedAt
  };
}

function markBusy(key: string, seenAt: number, candidate: Candidate): void {
  if (busyKey !== key || !busySinceMs || Date.now() - lastBusySeenMs > BUSY_IDLE_GRACE_MS) {
    busyKey = key;
    busySinceMs = Date.now();
  }
  lastBusySeenMs = Math.max(lastBusySeenMs, seenAt);
  lastBusyCandidate = candidate;
}

function recentCodexThreads(config: AgentConfig): Candidate[] {
  const home = process.env.USERPROFILE;
  if (!home) return [];
  const statePath = join(home, ".codex", "state_5.sqlite");
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT title,cwd,updated_at
      FROM threads
      WHERE archived = 0
      ORDER BY updated_at DESC
      LIMIT 20
    `).all() as Array<{ title: string; cwd: string; updated_at: number }>;
    return rows.flatMap((row) => {
      const repo = matchRepo(config.repos, row.cwd);
      if (!repo) return [];
      return [{
        key: `local-codex:${repo.id}:${row.title}`,
        repoId: repo.id,
        source: "local Codex",
        title: row.title,
        updatedAt: timeMsFromNumber(row.updated_at)
      }];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function recentVsCodeSessions(config: AgentConfig): Candidate[] {
  const appdata = process.env.APPDATA;
  if (!appdata) return [];
  const root = join(appdata, "Code", "User", "workspaceStorage");
  if (!existsSync(root)) return [];
  return collectFiles(root, (path) => /[\\/]chatSessions[\\/].+\.(json|jsonl)$/i.test(path))
    .flatMap((path) => {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        return [];
      }
      if (Date.now() - stat.mtimeMs > BUSY_WINDOW_MS) return [];
      const parsed = readVsCodeSession(path);
      const repo = matchRepo(config.repos, parsed.cwd ?? "");
      if (!repo) return [];
      return [{
        key: `vscode:${path}`,
        repoId: repo.id,
        source: "VS Code Codex",
        title: parsed.title,
        updatedAt: stat.mtimeMs
      }];
    });
}

function readVsCodeSession(path: string): { title?: string; cwd?: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const last = raw.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const root = path.endsWith(".jsonl") && last ? JSON.parse(last).v : JSON.parse(raw);
    const requests = Array.isArray(root.requests) ? root.requests : [];
    const recent = requests.at(-1) ?? requests[0];
    return {
      title: typeof recent?.message?.text === "string" ? recent.message.text : undefined,
      cwd: findPathInObject(recent ?? root)
    };
  } catch {
    return {};
  }
}

function matchRepo(repos: RepoConfig[], cwd: string): RepoConfig | undefined {
  const normalizedCwd = cleanPath(cwd).toLowerCase();
  return repos
    .filter((repo) => normalizedCwd.startsWith(cleanPath(repo.path).toLowerCase()))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function findPathInObject(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack = [value];
  while (stack.length) {
    const item: any = stack.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.fsPath === "string") return cleanPath(item.fsPath);
    if (typeof item.path === "string" && /^[A-Za-z]:/.test(item.path.replace(/^\//, ""))) return cleanPath(item.path.replace(/^\//, ""));
    for (const child of Object.values(item)) stack.push(child);
  }
  return undefined;
}

function collectFiles(root: string, predicate: (path: string) => boolean): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (predicate(path)) files.push(path);
    }
  }
  return files;
}

function cleanPath(value: string): string {
  return normalize(value.replace(/^\\\\\?\\/, ""));
}

function timeMsFromNumber(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  const number = Number(value);
  if (number > 10_000_000_000_000) return Math.round(number / 1000);
  if (number > 10_000_000_000) return number;
  return number * 1000;
}
