import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentToServer, ChatMessage } from "@cmc/protocol";
import type { AgentConfig, RepoConfig } from "./config.js";

type Send = (message: AgentToServer) => void;
type LocalAttachment = NonNullable<ChatMessage["attachments"]>[number];

const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"]
]);

type LocalChat = {
  repoId: string;
  source: "codex" | "vscode";
  externalId: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  messages: ChatMessage[];
};

type SyncedCodexAction = {
  id: string;
  command: string;
  status: string;
  output: string;
  at: string;
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
      SELECT *
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
      updated_at_ms?: number | null;
      created_at_ms?: number | null;
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
          createdAt: timeFromNumber(row.created_at_ms ?? row.created_at)
        });
      }
      return [{
        repoId: repo.id,
        source: "codex" as const,
        externalId: row.id,
        title: chatTitle([row.title, firstUserMessage(messages), row.first_user_message], "Codex chat"),
        cwd: cleanPath(row.cwd),
        updatedAt: lastMessageAt(messages) ?? timeFromNumber(row.updated_at_ms ?? row.updated_at),
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
  let lastChangeStat = "";
  let lastChangeDiff = "";
  const actionsById = new Map<string, SyncedCodexAction>();
  let pendingActions: SyncedCodexAction[] = [];
  let currentRunStartedAt = "";
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
    if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
      currentRunStartedAt = createdAt;
    }
    if (
      (row.type === "response_item" && row.payload?.type === "function_call")
      || row.type === "custom_tool_call"
    ) {
      const action = actionFromFunctionCall(row.payload, createdAt, index);
      if (action) {
        actionsById.set(action.id, action);
        pendingActions.push(action);
      }
    }
    if (
      (row.type === "response_item" && row.payload?.type === "function_call_output")
      || row.type === "custom_tool_call_output"
    ) {
      const actionId = typeof row.payload.call_id === "string" ? row.payload.call_id : "";
      const action = actionId ? actionsById.get(actionId) : undefined;
      if (action) {
        action.output = cleanActionOutput(row.payload.output);
        action.status = action.output.match(/^Exit code:\s*0\b/im) || /Success\./i.test(action.output) ? "completed" : "failed";
        action.at = createdAt;
      }
      const changeStat = extractChangeStat(row.payload.output);
      if (changeStat) lastChangeStat = changeStat;
      const changeDiff = extractChangeDiff(row.payload.output);
      if (changeDiff) lastChangeDiff = changeDiff;
    }
    if (row.type === "response_item" && row.payload?.type === "message") {
      const role = normalizeRole(row.payload.role);
      const attachments = collectImageAttachments(row.payload.content);
      const rawContent = textFromContent(row.payload.content);
      const content = cleanSyncedContent(rawContent, attachments);
      if (role && content && !isCodexContextMessage(content)) {
        const metadata: Record<string, unknown> = { localPath: path };
        if (role === "assistant" && pendingActions.length) {
          metadata.codexActions = pendingActions.map((action) => ({ ...action }));
          pendingActions = [];
        }
        if (role === "assistant" && currentRunStartedAt) {
          metadata.startedAt = currentRunStartedAt;
          const durationSeconds = Math.max(0, Math.round((Date.parse(createdAt) - Date.parse(currentRunStartedAt)) / 1000));
          if (Number.isFinite(durationSeconds)) metadata.durationSeconds = durationSeconds;
        }
        messages.push({
          role,
          content,
          source: "codex",
          externalId: `${basename(path)}:${index}`,
          createdAt,
          attachments,
          metadata
        });
      }
    }
  }
  const compacted = compactMessages(messages);
  const lastAssistant = [...compacted].reverse().find((message) => message.role === "assistant");
  if (lastAssistant && lastChangeStat && typeof lastAssistant.metadata?.gitDiffStat !== "string") {
    lastAssistant.metadata = { ...lastAssistant.metadata, gitDiffStat: lastChangeStat };
  }
  if (lastAssistant && lastChangeDiff && typeof lastAssistant.metadata?.gitDiff !== "string") {
    lastAssistant.metadata = { ...lastAssistant.metadata, gitDiff: lastChangeDiff };
  }
  return compacted;
}

function actionFromFunctionCall(payload: any, at: string, fallbackIndex: number): SyncedCodexAction | null {
  const name = typeof payload.name === "string" ? payload.name : "tool";
  if (!["shell_command", "apply_patch"].includes(name)) return null;
  const id = typeof payload.call_id === "string" ? payload.call_id : `${name}:${fallbackIndex}`;
  const command = name === "shell_command"
    ? commandFromFunctionArguments(payload.arguments)
    : "apply_patch";
  return {
    id,
    command: command.slice(0, 500),
    status: "running",
    output: "",
    at
  };
}

function commandFromFunctionArguments(value: unknown): string {
  if (typeof value !== "string") return "command";
  try {
    const parsed = JSON.parse(value) as { command?: unknown };
    if (typeof parsed.command === "string" && parsed.command.trim()) return parsed.command.trim();
  } catch {
    // Fall through to a short raw representation.
  }
  return value.replace(/\s+/g, " ").trim() || "command";
}

function cleanActionOutput(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, 20000);
}

function extractChangeStat(output: unknown): string {
  if (typeof output !== "string" || !/diff --git|\|\s+\d+|files? changed/i.test(output)) return "";
  const normalized = output.replace(/\r\n/g, "\n");
  if (/^diff --git /m.test(normalized)) {
    const diffRows = diffStatFromPatch(normalized);
    if (diffRows.length) return diffRows.join("\n").slice(0, 12000);
  }
  const statLines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^\s*\S.*\s+\|\s+\d+/.test(line) || /^\s*\d+\s+files?\s+changed\b/i.test(line));
  if (statLines.length) return statLines.join("\n").slice(0, 12000);
  return "";
}

function extractChangeDiff(output: unknown): string {
  if (typeof output !== "string" || !/^diff --git /m.test(output)) return "";
  const normalized = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const start = normalized.search(/^diff --git /m);
  if (start < 0) return "";
  return normalized.slice(start).slice(0, 100000);
}

function diffStatFromPatch(output: string): string[] {
  const stats = new Map<string, { added: number; deleted: number }>();
  let currentFile = "";
  for (const line of output.split("\n")) {
    const diff = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diff) {
      currentFile = diff[2] || diff[1] || "";
      if (currentFile && !stats.has(currentFile)) stats.set(currentFile, { added: 0, deleted: 0 });
      continue;
    }
    if (!currentFile) continue;
    const current = stats.get(currentFile);
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added += 1;
    if (line.startsWith("-")) current.deleted += 1;
  }
  return [...stats.entries()]
    .filter(([, stat]) => stat.added || stat.deleted)
    .map(([file, stat]) => {
      const changed = stat.added + stat.deleted;
      const bars = `${"+".repeat(stat.added)}${"-".repeat(stat.deleted)}`;
      return ` ${file} | ${changed} ${bars}`;
    });
}

function isCodexContextMessage(content: string): boolean {
  const normalized = content.trim();
  return /^<(environment_context|permissions instructions|collaboration_mode|apps_instructions|skills_instructions|plugins_instructions)>/i.test(normalized)
    || /^#?\s*AGENTS\.md instructions for\b/i.test(normalized)
    || /^AGENTS\.md\s+Project rules\b/i.test(normalized)
    || normalized.includes("<INSTRUCTIONS>");
}

function firstUserMessage(messages: ChatMessage[]): string | undefined {
  return messages.find((message) => message.role === "user")?.content;
}

function lastMessageAt(messages: ChatMessage[]): string | undefined {
  return [...messages].reverse().find((message) => message.createdAt)?.createdAt;
}

function chatTitle(candidates: Array<string | undefined | null>, fallback: string): string {
  for (const candidate of candidates) {
    const title = titleFromContent(candidate);
    if (title) return title.slice(0, 300);
  }
  return fallback;
}

function titleFromContent(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  let content = cleanSyncedContent(value, []);
  const requestMatch = content.match(/My request for Codex:\s*([\s\S]+)/i);
  if (requestMatch?.[1]) content = requestMatch[1];
  content = content
    .replace(/<image>[\s\S]*?<\/image>/gi, "")
    .replace(/<image\s*\/>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!content || isCodexContextMessage(content) || /^# Context from my IDE setup:/i.test(content)) return undefined;
  return content.slice(0, 120);
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
    const cwd = parsed.cwd ?? readVsCodeWorkspaceCwd(file);
    const repo = matchRepo(config.repos, cwd ?? "");
    if (!repo) return [];
    return [{
      repoId: repo.id,
      source: "vscode" as const,
      externalId: parsed.id,
      title: parsed.title,
      cwd,
      updatedAt: parsed.updatedAt,
      messages: parsed.messages
    }];
  });
}

function readVsCodeWorkspaceCwd(chatFile: string): string | undefined {
  const workspacePath = join(dirname(dirname(chatFile)), "workspace.json");
  if (!existsSync(workspacePath)) return undefined;
  try {
    const workspace = JSON.parse(readFileSync(workspacePath, "utf8")) as { folder?: unknown; workspace?: unknown };
    if (typeof workspace.folder === "string") return fileUriToPath(workspace.folder) ?? cleanPath(workspace.folder);
    if (typeof workspace.workspace === "string") return fileUriToPath(workspace.workspace) ?? cleanPath(workspace.workspace);
    return findPathInObject(workspace);
  } catch {
    return undefined;
  }
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
    const userAttachments = collectImageAttachments(request.message ?? request);
    const userContent = cleanSyncedContent(text ? String(text) : "", userAttachments);
    if (userContent || userAttachments.length) {
      messages.push({
        role: "user",
        content: userContent || "Image attachment",
        source: "vscode",
        externalId: `${request.requestId}:user`,
        createdAt: at,
        attachments: userAttachments
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
    title: vscodeSessionTitle(root, messages),
    cwd,
    updatedAt: timeFromNumber(root.lastMessageDate ?? root.creationDate ?? statSync(path).mtimeMs),
    messages: compactMessages(messages)
  };
}

function vscodeSessionTitle(root: any, messages: ChatMessage[]): string {
  const generatedTitle = findGeneratedTitle(root);
  if (generatedTitle) return generatedTitle.slice(0, 300);
  for (const key of ["title", "name", "label"]) {
    const value = root?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  }
  return messages[0]?.content.slice(0, 120) || "VS Code chat";
}

function findGeneratedTitle(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack = [value];
  while (stack.length) {
    const item: any = stack.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.generatedTitle === "string" && item.generatedTitle.trim()) return item.generatedTitle.trim();
    if (typeof item.title === "string" && item.title.trim() && item.kind === "title") return item.title.trim();
    for (const child of Object.values(item)) stack.push(child);
  }
  return undefined;
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

function cleanSyncedContent(content: string, attachments: LocalAttachment[]): string {
  const cleaned = content
    .replace(/<image>\s*<\/image>/gi, "")
    .replace(/<image\s*\/>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || (attachments.length ? "Image attachment" : "");
}

function collectImageAttachments(value: unknown): LocalAttachment[] {
  const attachments: LocalAttachment[] = [];
  const seen = new Set<string>();
  const stack = [value];
  const seenObjects = new Set<unknown>();

  while (stack.length && attachments.length < MAX_ATTACHMENTS_PER_MESSAGE) {
    const item: any = stack.pop();
    if (!item) continue;
    if (typeof item === "string") {
      const fromDataUrl = attachmentFromDataUrl(item, seen);
      if (fromDataUrl) attachments.push(fromDataUrl);
      const fromPath = attachmentFromPath(item, seen);
      if (fromPath) attachments.push(fromPath);
      continue;
    }
    if (typeof item !== "object" || seenObjects.has(item)) continue;
    seenObjects.add(item);

    const directPath = typeof item.fsPath === "string" ? item.fsPath
      : typeof item.path === "string" ? item.path
        : typeof item.filePath === "string" ? item.filePath
          : typeof item.uri?.fsPath === "string" ? item.uri.fsPath
            : typeof item.uri?.path === "string" ? item.uri.path
              : "";
    const direct = directPath ? attachmentFromPath(directPath, seen) : undefined;
    if (direct) attachments.push(direct);

    const data = typeof item.data === "string" ? item.data
      : typeof item.base64 === "string" ? item.base64
        : typeof item.imageData === "string" ? item.imageData
          : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType
      : typeof item.mime === "string" ? item.mime
        : typeof item.mediaType === "string" ? item.mediaType
          : "";
    if (data && isSupportedImageMime(mimeType)) {
      const fromBase64 = attachmentFromBase64(data, mimeType, typeof item.name === "string" ? item.name : undefined, seen);
      if (fromBase64) attachments.push(fromBase64);
    }

    for (const child of Object.values(item)) stack.push(child);
  }

  return attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
}

function attachmentFromDataUrl(value: string, seen: Set<string>): LocalAttachment | undefined {
  const match = value.match(/^data:(image\/(?:png|jpeg|gif|webp|avif|bmp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match?.[1] || !match[2]) return undefined;
  return attachmentFromBase64(match[2], match[1].toLowerCase(), undefined, seen);
}

function attachmentFromBase64(value: string, mimeType: string, name: string | undefined, seen: Set<string>): LocalAttachment | undefined {
  const dataBase64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) return undefined;
  const size = Buffer.byteLength(dataBase64, "base64");
  if (size <= 0 || size > MAX_ATTACHMENT_SIZE) return undefined;
  const key = `${mimeType}:${size}:${dataBase64.slice(0, 80)}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  return {
    name: safeAttachmentName(name || `vscode-image-${Date.now()}.${extensionForMime(mimeType)}`),
    mimeType,
    size,
    dataBase64
  };
}

function attachmentFromPath(value: string, seen: Set<string>): LocalAttachment | undefined {
  const path = localImagePath(value);
  if (!path) return undefined;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_SIZE) return undefined;
  const mimeType = IMAGE_MIME_BY_EXT.get(extname(path).toLowerCase());
  if (!mimeType) return undefined;
  const key = `file:${path.toLowerCase()}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  return {
    name: safeAttachmentName(basename(path)),
    mimeType,
    size: stat.size,
    dataBase64: readFileSync(path).toString("base64")
  };
}

function localImagePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^file:\/\//i, "");
  const decoded = safeDecodeURIComponent(trimmed).replace(/\//g, "\\");
  const path = decoded.replace(/^\\([A-Za-z]:\\)/, "$1");
  const mimeType = IMAGE_MIME_BY_EXT.get(extname(path).toLowerCase());
  if (!mimeType || !/^[A-Za-z]:\\|^\\\\/.test(path)) return undefined;
  return cleanPath(path);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSupportedImageMime(value: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(value.toLowerCase());
}

function extensionForMime(value: string): string {
  if (value === "image/jpeg") return "jpg";
  return value.replace(/^image\//, "") || "png";
}

function safeAttachmentName(value: string): string {
  return basename(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 160) || "image.png";
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
    if (typeof item === "string") {
      const path = fileUriToPath(item);
      if (path) return path;
      continue;
    }
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.fsPath === "string") return cleanPath(item.fsPath);
    if (typeof item.path === "string" && /^[A-Za-z]:/.test(item.path.replace(/^\//, ""))) return cleanPath(item.path.replace(/^\//, ""));
    for (const child of Object.values(item)) stack.push(child);
  }
  return undefined;
}

function fileUriToPath(value: string): string | undefined {
  if (!value.toLowerCase().startsWith("file://")) return undefined;
  const withoutScheme = value.replace(/^file:\/\//i, "");
  const decoded = safeDecodeURIComponent(withoutScheme).replace(/\//g, "\\");
  const path = decoded.replace(/^\\([A-Za-z]:\\)/, "$1");
  if (!/^[A-Za-z]:\\|^\\\\/.test(path)) return undefined;
  return cleanPath(path);
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
