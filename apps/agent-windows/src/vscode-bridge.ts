import net from "node:net";
import os from "node:os";
import type { ServerToAgent } from "@cmc/protocol";

type VscodeCommand = Extract<ServerToAgent, { type: "vscode.command" }>;

const DEFAULT_TIMEOUT_MS = 8000;

function pipePath(): string {
  const configured = process.env.CMC_VSCODE_BRIDGE_PIPE?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-rodion-vscode-bridge";
  return `${os.tmpdir()}/codex-rodion-vscode-bridge.sock`;
}

export function sendVscodeBridgeCommand(command: VscodeCommand): Promise<{ ok: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipePath());
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "vscode_bridge_timeout" });
    }, DEFAULT_TIMEOUT_MS);
    let buffer = "";
    let settled = false;

    const finish = (result: { ok: boolean; output?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(result);
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        command: command.command,
        text: command.text,
        filePath: command.filePath
      }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const parsed = JSON.parse(line) as { ok?: unknown; output?: unknown; error?: unknown };
        finish({
          ok: parsed.ok === true,
          output: typeof parsed.output === "string" ? parsed.output : undefined,
          error: typeof parsed.error === "string" ? parsed.error : undefined
        });
      } catch {
        finish({ ok: false, error: "invalid_vscode_bridge_response" });
      }
    });
    socket.on("error", (error) => {
      finish({ ok: false, error: error.message.includes("ENOENT") ? "vscode_bridge_unavailable" : error.message });
    });
    socket.on("close", () => {
      finish({ ok: false, error: "vscode_bridge_closed" });
    });
  });
}
