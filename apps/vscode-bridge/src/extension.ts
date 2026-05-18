import net from "node:net";
import os from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";

type BridgeCommand = "ping" | "openSidebar" | "newChat" | "newCodexPanel" | "addToThread" | "addFileToThread";

type BridgeRequest = {
  command?: unknown;
  text?: unknown;
  filePath?: unknown;
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
  "addFileToThread"
]);

let server: net.Server | undefined;

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
  if (typeof request.text === "string" && request.text.length > 16000) return { ok: false, error: "text_too_large" };
  if (typeof request.filePath === "string" && request.filePath.length > 500) return { ok: false, error: "file_path_too_large" };
  return { ok: true, request: request as Required<Pick<BridgeRequest, "command">> & BridgeRequest };
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
