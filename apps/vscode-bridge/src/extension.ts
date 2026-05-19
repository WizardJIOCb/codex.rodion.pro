import net from "node:net";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import * as vscode from "vscode";

type BridgeCommand = "ping" | "openSidebar" | "newChat" | "newCodexPanel" | "addToThread" | "addFileToThread" | "openThread" | "reopenThread";

type BridgeRequest = {
  command?: unknown;
  text?: unknown;
  filePath?: unknown;
  threadId?: unknown;
};

type BridgeResponse = {
  ok: boolean;
  output?: string;
  error?: string;
};

const ALLOWED_COMMANDS = new Set<BridgeCommand>([
  "ping",
  "openSidebar",
  "newChat",
  "newCodexPanel",
  "addToThread",
  "addFileToThread",
  "openThread",
  "reopenThread"
]);

let server: net.Server | undefined;
let chatsProvider: CodexRodionChatsProvider | undefined;

type CodexThread = {
  id: string;
  title: string;
  updatedAt: string;
};

function pipePath(): string {
  const configured = process.env.CMC_VSCODE_BRIDGE_PIPE?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-rodion-vscode-bridge";
  return `${os.tmpdir()}/codex-rodion-vscode-bridge.sock`;
}

function validateRequest(value: unknown): { ok: true; request: Required<Pick<BridgeRequest, "command">> & BridgeRequest } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "invalid_request" };
  const request = value as BridgeRequest;
  if (typeof request.command !== "string" || !ALLOWED_COMMANDS.has(request.command as BridgeCommand)) {
    return { ok: false, error: "unsupported_command" };
  }
  if (request.text !== undefined && typeof request.text !== "string") return { ok: false, error: "invalid_text" };
  if (request.filePath !== undefined && typeof request.filePath !== "string") return { ok: false, error: "invalid_file_path" };
  if (request.threadId !== undefined && typeof request.threadId !== "string") return { ok: false, error: "invalid_thread_id" };
  if (typeof request.text === "string" && request.text.length > 16000) return { ok: false, error: "text_too_large" };
  if (typeof request.filePath === "string" && request.filePath.length > 500) return { ok: false, error: "file_path_too_large" };
  if (typeof request.threadId === "string" && (request.threadId.length < 1 || request.threadId.length > 300)) return { ok: false, error: "thread_id_too_large" };
  return { ok: true, request: request as Required<Pick<BridgeRequest, "command">> & BridgeRequest };
}

function codexThreadUri(threadId: string): vscode.Uri {
  return vscode.Uri.file(`/local/${threadId}`).with({ scheme: "openai-codex", authority: "route" });
}

function isCodexThreadTab(tab: vscode.Tab, threadId: string): boolean {
  const input = tab.input;
  if (!(input instanceof vscode.TabInputCustom)) return false;
  return input.viewType === "chatgpt.conversationEditor"
    && input.uri.scheme === "openai-codex"
    && (input.uri.authority === "route" || input.uri.authority === "extension")
    && input.uri.path === `/local/${threadId}`;
}

async function closeCodexThreadTabs(threadId: string): Promise<number> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => isCodexThreadTab(tab, threadId));
  if (!tabs.length) return 0;
  await vscode.window.tabGroups.close(tabs, true);
  return tabs.length;
}

async function openCodexThread(threadId: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", codexThreadUri(threadId), "chatgpt.conversationEditor", {
    preserveFocus: false,
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
}

function codexHome(): string {
  return join(os.homedir(), ".codex");
}

function threadIdFromRolloutPath(path: string): string | undefined {
  return basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
}

function readSessionTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  const path = join(codexHome(), "session_index.jsonl");
  if (!existsSync(path)) return titles;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof row.id === "string" && typeof row.thread_name === "string" && row.thread_name.trim()) {
        titles.set(row.id, row.thread_name.trim());
      }
    } catch {
      // Ignore corrupt local index rows.
    }
  }
  return titles;
}

function collectRolloutFiles(root: string): string[] {
  if (!existsSync(root)) return [];
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
      else if (/^rollout-.+\.jsonl$/i.test(entry) && threadIdFromRolloutPath(path)) files.push(path);
    }
  }
  return files;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    for (const key of ["text", "input_text", "output_text"]) {
      if (typeof row[key] === "string") return [row[key] as string];
    }
    return [];
  }).join("\n").trim();
}

function readRolloutTitle(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type !== "response_item" || row.payload?.type !== "message" || row.payload?.role !== "user") continue;
      const content = textFromContent(row.payload.content).replace(/\s+/g, " ").trim();
      if (content) return content.slice(0, 120);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readLocalCodexThreads(): CodexThread[] {
  const titles = readSessionTitles();
  return collectRolloutFiles(join(codexHome(), "sessions"))
    .map((rolloutPath) => {
      const id = threadIdFromRolloutPath(rolloutPath)!;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(rolloutPath).mtimeMs;
      } catch {
        // Keep the item with an old timestamp if the file disappears mid-refresh.
      }
      return {
        id,
        title: titles.get(id) || readRolloutTitle(rolloutPath) || "Codex chat",
        updatedAt: new Date(mtimeMs || 0).toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 80);
}

function webviewHtml(): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size) var(--vscode-font-family); }
    .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 4px 8px; border-radius: 3px; cursor: pointer; }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .status { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .item { border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); background: var(--vscode-editor-background); border-radius: 4px; padding: 8px; }
    .title { font-weight: 600; line-height: 1.35; margin-bottom: 4px; word-break: break-word; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 8px; }
    .actions { display: flex; gap: 6px; }
    .empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="refresh">Refresh</button>
    <button class="secondary" id="codex">Codex</button>
    <span class="status" id="status">Loading...</span>
  </div>
  <div class="list" id="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');
    const status = document.getElementById('status');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('codex').addEventListener('click', () => vscode.postMessage({ type: 'openSidebar' }));
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'threads') return;
      const threads = Array.isArray(message.threads) ? message.threads : [];
      status.textContent = String(threads.length) + ' chats';
      list.innerHTML = threads.length ? '' : '<div class="empty">No local Codex chats found.</div>';
      for (const thread of threads) {
        if (!thread || typeof thread.id !== 'string') continue;
        const item = document.createElement('article');
        item.className = 'item';
        item.innerHTML = '<div class="title"></div><div class="meta"></div><div class="actions"><button data-action="open">Open</button><button class="secondary" data-action="reopen">Reopen</button></div>';
        item.querySelector('.title').textContent = String(thread.title || 'Codex chat');
        item.querySelector('.meta').textContent = new Date(thread.updatedAt).toLocaleString();
        item.querySelector('[data-action="open"]').addEventListener('click', () => vscode.postMessage({ type: 'openThread', threadId: thread.id }));
        item.querySelector('[data-action="reopen"]').addEventListener('click', () => vscode.postMessage({ type: 'reopenThread', threadId: thread.id }));
        list.appendChild(item);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

class CodexRodionChatsProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml();
    view.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.view?.webview.postMessage({ type: "threads", threads: readLocalCodexThreads() });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; threadId?: unknown };
    if (request.type === "ready" || request.type === "refresh") {
      await this.refresh();
      return;
    }
    if (request.type === "openSidebar") {
      await vscode.commands.executeCommand("chatgpt.openSidebar");
      return;
    }
    if ((request.type === "openThread" || request.type === "reopenThread") && typeof request.threadId === "string") {
      if (request.type === "reopenThread") await closeCodexThreadTabs(request.threadId);
      await openCodexThread(request.threadId);
    }
  }
}

async function executeBridgeCommand(request: Required<Pick<BridgeRequest, "command">> & BridgeRequest): Promise<BridgeResponse> {
  switch (request.command) {
    case "ping":
      return { ok: true, output: "pong" };
    case "openSidebar":
      await vscode.commands.executeCommand("chatgpt.openSidebar");
      return { ok: true, output: "Codex sidebar opened." };
    case "newChat":
      await vscode.commands.executeCommand("chatgpt.newChat");
      return { ok: true, output: "New Codex chat requested." };
    case "newCodexPanel":
      await vscode.commands.executeCommand("chatgpt.newCodexPanel");
      return { ok: true, output: "New Codex panel requested." };
    case "addToThread":
      await vscode.commands.executeCommand("chatgpt.addToThread");
      return { ok: true, output: "Add to current Codex thread requested." };
    case "addFileToThread": {
      if (typeof request.filePath !== "string" || !request.filePath) return { ok: false, error: "file_path_required" };
      await vscode.commands.executeCommand("chatgpt.addFileToThread", vscode.Uri.file(request.filePath));
      return { ok: true, output: "File add to Codex thread requested." };
    }
    case "openThread": {
      if (typeof request.threadId !== "string" || !request.threadId.trim()) return { ok: false, error: "thread_id_required" };
      await openCodexThread(request.threadId.trim());
      return { ok: true, output: "Codex thread opened in VS Code." };
    }
    case "reopenThread": {
      if (typeof request.threadId !== "string" || !request.threadId.trim()) return { ok: false, error: "thread_id_required" };
      const threadId = request.threadId.trim();
      const closed = await closeCodexThreadTabs(threadId);
      await openCodexThread(threadId);
      return { ok: true, output: closed ? "Codex thread reopened in VS Code." : "Codex thread opened in VS Code." };
    }
    default:
      return { ok: false, error: "unsupported_command" };
  }
}

function writeResponse(socket: net.Socket, response: BridgeResponse): void {
  socket.write(JSON.stringify(response) + "\n", () => socket.end());
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    writeResponse(socket, { ok: false, error: "invalid_json" });
    return;
  }
  const validated = validateRequest(parsed);
  if (!validated.ok) {
    writeResponse(socket, { ok: false, error: validated.error });
    return;
  }
  try {
    writeResponse(socket, await executeBridgeCommand(validated.request));
  } catch (error) {
    writeResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function startServer(): Promise<void> {
  await stopServer();
  const path = pipePath();
  if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.removeAllListeners("data");
      handleLine(socket, line).catch((error) => {
        writeResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(path, () => {
      server?.off("error", reject);
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  const current = server;
  server = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

export function activate(context: vscode.ExtensionContext): void {
  chatsProvider = new CodexRodionChatsProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("codexRodionChats", chatsProvider));
  context.subscriptions.push(vscode.commands.registerCommand("codexRodionBridge.refreshChats", () => chatsProvider?.refresh()));
  startServer()
    .then(() => vscode.window.showInformationMessage("codex.rodion.pro VS Code bridge is ready."))
    .catch((error) => vscode.window.showWarningMessage(`codex.rodion.pro bridge failed: ${error instanceof Error ? error.message : String(error)}`));
  context.subscriptions.push(vscode.commands.registerCommand("codexRodionBridge.restart", () => {
    startServer()
      .then(() => vscode.window.showInformationMessage("codex.rodion.pro VS Code bridge restarted."))
      .catch((error) => vscode.window.showWarningMessage(`codex.rodion.pro bridge failed: ${error instanceof Error ? error.message : String(error)}`));
  }));
  context.subscriptions.push({ dispose: () => { void stopServer(); } });
}

export function deactivate(): PromiseLike<void> {
  return stopServer();
}
