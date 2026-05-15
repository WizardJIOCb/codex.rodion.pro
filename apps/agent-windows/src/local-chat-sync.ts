import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentToServer, ChatMessage } from "@cmc/protocol";
import type { AgentConfig, RepoConfig } from "./config.js";

type Send = (message: AgentToServer) => void;

type LocalChat = {
  repoId: string;
  source: "codex" | "vscode";
  externalId: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export async function syncLocalChats(config: AgentConfig, send: Send): Promise<void> {
  const chats = [
    ...readCodexChats(config),
    ...readVsCodeChats(config)
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 160);
  for (const chat of chats) {
    send({
      type: "chat.sync",
      repoId: chat.repoId,
      source: chat.source,
      externalId: chat.externalId,
      title: chat.title.slice(0, 300),
      cwd: chat.cwd,
      updatedAt: chat.updatedAt,
      messages: chat.messages.slice(-120)
    });
  }
}

function readCodexChats(config: AgentConfig): LocalChat[] {
  const home = process.env.USERPROFILE;
  if (!home) return [];
  const statePath = join(home, ".codex", "state_5.sqlite");
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id,title,cwd,rollout_path,updated_at,created_at,first_user_message
      FROM threads
      WHERE archived = 0
      ORDER BY updated_at DESC
      LIMIT 120
    `).all() as Array<{
      id: string;
      title: string;
      cwd: string;
      rollout_path: string;
      updated_at: number;
      created_at: number;
      first_user_message: string;
    }>;
    return rows.flatMap((row) => {
      const repo = matchRepo(config.repos, row.cwd);
      if (!repo) return [];
      const messages = readCodexRollout(row.rollout_path);
      if (!messages.length && row.first_user_message) {
        messages.push({
          role: "user",
          content: row.first_user_message,
          source: "codex",
          externalId: `${row.id}:first`,
          createdAt: timeFromNumber(row.created_at)
        });
      }
      return [{
        repoId: repo.id,
        source: "codex" as const,
        externalId: row.id,
        title: row.title || row.first_user_message || "Codex chat",
        cwd: cleanPath(row.cwd),
        updatedAt: timeFromNumber(row.updated_at),
        messages
      }];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function readCodexRollout(path: string): ChatMessage[] {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const messages: ChatMessage[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const createdAt = typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString();
    if (row.type === "response_item" && row.payload?.type === "message") {
      const role = normalizeRole(row.payload.role);
      const content = textFromContent(row.payload.content);
      if (role && content && !isCodexContextMessage(content)) {
        messages.push({
          role,
          content,
          source: "codex",
          externalId: `${basename(path)}:${index}`,
          createdAt,
          metadata: { localPath: path }
        });
      }
    }
  }
  return compactMessages(messages);
}

function isCodexContextMessage(content: string): boolean {
  return /^<(environment_context|permissions instructions|collaboration_mode|apps_instructions|skills_instructions|plugins_instructions)>/i.test(content.trim());
}

function readVsCodeChats(config: AgentConfig): LocalChat[] {
  const appdata = process.env.APPDATA;
  if (!appdata) return [];
  const root = join(appdata, "Code", "User", "workspaceStorage");
  if (!existsSync(root)) return [];
  const files = collectFiles(root, (path) => /[\\/]chatSessions[\\/].+\.(json|jsonl)$/i.test(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, 160);
  return files.flatMap((file) => {
    const parsed = readVsCodeFile(file);
    if (!parsed) return [];
    const repo = matchRepo(config.repos, parsed.cwd ?? "");
    if (!repo) return [];
    return [{
      repoId: repo.id,
      source: "vscode" as const,
      externalId: parsed.id,
      title: parsed.title,
      cwd: parsed.cwd,
      updatedAt: parsed.updatedAt,
      messages: parsed.messages
    }];
  });
}

function readVsCodeFile(path: string): { id: string; title: string; cwd?: string; updatedAt: string; messages: ChatMessage[] } | null {
  const raw = readFileSync(path, "utf8");
  const last = raw.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!last) return null;
  let root: any;
  try {
    root = path.endsWith(".jsonl") ? JSON.parse(last).v : JSON.parse(raw);
  } catch {
    return null;
  }
  const sessionId = root.sessionId ?? basename(path).replace(/\.(json|jsonl)$/i, "");
  const requests = Array.isArray(root.requests) ? root.requests : [];
  const messages: ChatMessage[] = [];
  let cwd: string | undefined;
  for (const request of requests.slice(-80)) {
    cwd ??= findPathInObject(request);
    const at = timeFromNumber(request.timestamp ?? root.lastMessageDate ?? root.creationDate);
    const text = request.message?.text;
    if (text) {
      messages.push({
        role: "user",
        content: String(text),
        source: "vscode",
        externalId: `${request.requestId}:user`,
        createdAt: at
      });
    }
    const response = textFromVsCodeResponse(request.response);
    if (response) {
      messages.push({
        role: "assistant",
        content: response,
        source: "vscode",
        externalId: `${request.requestId}:assistant`,
        createdAt: at,
        metadata: { modelId: request.modelId }
      });
    }
  }
  if (!messages.length) return null;
  return {
    id: sessionId,
    title: messages[0]?.content.slice(0, 120) || "VS Code chat",
    cwd,
    updatedAt: timeFromNumber(root.lastMessageDate ?? root.creationDate ?? statSync(path).mtimeMs),
    messages: compactMessages(messages)
  };
}

function matchRepo(repos: RepoConfig[], cwd: string): RepoConfig | undefined {
  const normalizedCwd = cleanPath(cwd).toLowerCase();
  return repos
    .filter((repo) => normalizedCwd.startsWith(cleanPath(repo.path).toLowerCase()))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function cleanPath(value: string): string {
  return normalize(value.replace(/^\\\\\?\\/, ""));
}

function timeFromNumber(value: number | undefined): string {
  if (!Number.isFinite(value)) return new Date().toISOString();
  const number = Number(value);
  if (number > 10_000_000_000_000) return new Date(Math.round(number / 1000)).toISOString();
  if (number > 10_000_000_000) return new Date(number).toISOString();
  return new Date(number * 1000).toISOString();
}

function normalizeRole(value: unknown): ChatMessage["role"] | undefined {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") return value;
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function textFromVsCodeResponse(response: unknown): string {
  if (!Array.isArray(response)) return "";
  return response
    .map((item: any) => typeof item?.value === "string" ? item.value : "")
    .filter(Boolean)
    .join("\n")
    .trim();
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

function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.role}:${message.externalId ?? ""}:${message.content.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
