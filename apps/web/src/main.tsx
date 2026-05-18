import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ArrowDown,
  ArrowUp,
  Clock3,
  FolderGit2,
  Github,
  GitBranch,
  KeyRound,
  Link2,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  MessageSquare,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  UploadCloud,
  UserCircle,
  Wrench,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import "./styles.css";

type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type CodexSpeed = "standard" | "fast";

const SANDBOXES: Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const SANDBOX_LABELS: Record<Sandbox, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "danger-full-access": "full-access"
};
const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" }
];
const CODEX_MODEL_OPTIONS = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" }
];
const SPEED_OPTIONS: Array<{ value: CodexSpeed; label: string; note: string }> = [
  { value: "standard", label: "Standard", note: "Default speed, normal usage" },
  { value: "fast", label: "Fast", note: "Saved with run metadata" }
];

type Agent = {
  id: string;
  user_id?: string | null;
  name: string;
  hostname?: string;
  status: "online" | "offline";
  current_job_id?: string | null;
  codex_version?: string;
  git_version?: string;
  localActivity?: {
    status: "idle" | "busy";
    summary: string;
    source: string;
    detectedAt: string;
    busySinceAt?: string;
    repoId?: string;
    chatTitle?: string;
    updatedAt?: string;
  };
  codexUsage?: {
    status: "signed-in" | "signed-out" | "unavailable";
    summary: string;
    source: string;
    checkedAt: string;
    resetAt?: string;
    limit?: number;
    remaining?: number;
    usedPercent?: number;
  };
};

type User = {
  id: string;
  email: string;
  role: "admin" | "user";
  nickname?: string | null;
  bio?: string | null;
  avatarDataUrl?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
};

type ProfileStats = {
  chats: number;
  jobs: number;
  completedJobs: number;
  failedJobs: number;
  projects: number;
  generationSeconds: number;
};

type OAuthProvider = {
  provider: "google" | "github" | "vk" | "mailru";
  connected: boolean;
  displayName?: string | null;
  connectedAt?: string | null;
  configured: boolean;
};

type AgentSetup = {
  agentId: string;
  serverUrl: string;
  token: string;
  configJson: string;
  setupPowerShell: string;
};

type DeployConfig = {
  sshTarget: string;
  sourceDir: string;
  remoteSubdir?: string;
  cleanRemote: boolean;
  buildCommand?: {
    command: string;
    args: string[];
    timeoutMs: number;
  };
};

type Repo = {
  id: string;
  agentId: string;
  name: string;
  pathMasked: string;
  githubUrl?: string;
  serverPath?: string;
  domain?: string;
  deploy?: DeployConfig;
  currentBranch?: string;
  dirty: boolean;
  defaultSandbox: Sandbox;
  allowedSandboxes: Sandbox[];
  testCommands: Array<{ id: string; label: string }>;
};

type Chat = {
  id: string;
  agentId: string;
  repoId: string;
  title: string;
  source?: string;
  externalId?: string | null;
  cwd?: string | null;
  hiddenAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChatMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  source: string;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  attachments?: MessageAttachment[];
};

type MessageAttachment = {
  id?: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  dataBase64?: string;
};

type ChatPayload = {
  chat: Chat;
  jobs: Job[];
  messages: ChatMessage[];
};

type ImagePreview = {
  src: string;
  name: string;
  mimeType: string;
  size: number;
};

type PendingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  previewUrl?: string;
};

type ChatLoadingProgress = {
  phase: "request" | "download" | "parse" | "details";
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
  startedAt: number;
};

type Job = {
  id: string;
  chatId?: string | null;
  agentId: string;
  repoId: string;
  prompt: string;
  sandbox: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speed?: CodexSpeed | null;
  status: string;
  exitCode: number | null;
  finalMessage: string | null;
  gitStatus: string | null;
  gitDiffStat: string | null;
  gitDiff: string | null;
  gitDiffOmitted?: boolean;
  progress?: JobProgress | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type Log = {
  id?: string;
  job_id?: string;
  jobId?: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
  at: string;
};

type JobProgress = {
  jobId: string;
  phase: string;
  message: string;
  filesChanged?: number;
  added?: number;
  deleted?: number;
  files?: Array<{
    path: string;
    added: number;
    deleted: number;
  }>;
  at: string;
};

type DiffRow = {
  file: string;
  changed: number;
  bars: string;
  added: number;
  deleted: number;
};

type DiffLine = {
  type: "context" | "added" | "deleted";
  oldLine?: number;
  newLine?: number;
  text: string;
};

type FileDiff = {
  file: string;
  lines: DiffLine[];
};

type CodexAction = {
  id: string;
  command: string;
  status: string;
  output: string;
  at: string;
};

type CollapsedRunSummary = {
  job?: Job;
  messages: ChatMessage[];
  commandCount: number;
  durationSeconds: number;
};

type ChatTimelineItem = {
  message: ChatMessage;
  collapsedRun?: CollapsedRunSummary;
};

function api(path: string, options: RequestInit = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  }).catch((error) => {
    if (isAbortError(error)) throw error;
    return new Response(JSON.stringify({ error: "network_error" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function progressPercent(progress: ChatLoadingProgress | null) {
  if (!progress) return 0;
  if (typeof progress.percent === "number") return Math.max(0, Math.min(100, Math.round(progress.percent)));
  return 0;
}

function chatLoadingPhaseLabel(phase: ChatLoadingProgress["phase"]) {
  if (phase === "request") return "Соединяюсь с сервером";
  if (phase === "download") return "Загружаю историю";
  if (phase === "parse") return "Собираю сообщения";
  return "Подтягиваю детали запуска";
}

function defaultProjectPath(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё.]+/gi, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "");
  return `C:\\Projects\\${slug || "new-project"}`;
}

function splitCommandLine(value: string) {
  return Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)).map((match) => match[1] ?? match[2] ?? match[0]);
}

function formatBuildCommand(deploy?: DeployConfig) {
  if (!deploy?.buildCommand) return "";
  return [deploy.buildCommand.command, ...deploy.buildCommand.args].join(" ");
}

function buildDeployConfig(sshTarget: string, sourceDir: string, remoteSubdir: string, cleanRemote: boolean, buildCommand: string): DeployConfig | undefined {
  const target = sshTarget.trim();
  if (!target) return undefined;
  const parts = splitCommandLine(buildCommand.trim());
  return {
    sshTarget: target,
    sourceDir: sourceDir.trim() || "dist",
    remoteSubdir: remoteSubdir.trim() || undefined,
    cleanRemote,
    buildCommand: parts[0] ? {
      command: parts[0],
      args: parts.slice(1),
      timeoutMs: 900000
    } : undefined
  };
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function isPreviewableImage(mimeType: string) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(mimeType.toLowerCase());
}

function readFileAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || `pasted-image-${Date.now()}.png`,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        dataBase64,
        previewUrl: isPreviewableImage(file.type) ? result : undefined
      });
    };
    reader.readAsDataURL(file);
  });
}

function progressDiffRows(files: JobProgress["files"] | undefined): DiffRow[] {
  return (files ?? []).map((file) => ({
    file: file.path,
    changed: file.added + file.deleted,
    bars: "",
    added: file.added,
    deleted: file.deleted
  }));
}

function parseUnifiedDiff(diff: string | null | undefined): FileDiff[] {
  if (!diff) return [];
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of normalizeDisplayText(diff).split("\n")) {
    const fileHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileHeader) {
      current = { file: fileHeader[2] || fileHeader[1] || "", lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ type: "context", oldLine: undefined, newLine: undefined, text: line });
      continue;
    }

    if (!line || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "added", newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ type: "deleted", oldLine, text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      current.lines.push({ type: "context", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files.filter((file) => file.lines.some((line) => line.type !== "context"));
}

function findFileDiffInList(fileDiffs: FileDiff[], file: string) {
  const normalized = file.replace(/\\/g, "/");
  return fileDiffs.find((item) => item.file.replace(/\\/g, "/") === normalized);
}

function diffRowsFromFileDiffs(fileDiffs: FileDiff[]): DiffRow[] {
  return fileDiffs.map((fileDiff) => {
    const added = fileDiff.lines.filter((line) => line.type === "added").length;
    const deleted = fileDiff.lines.filter((line) => line.type === "deleted").length;
    return {
      file: fileDiff.file,
      changed: added + deleted,
      bars: "",
      added,
      deleted
    };
  }).filter((row) => row.changed > 0);
}

function diffSummaryFromRows(rows: DiffRow[]) {
  return rows.reduce((total, row) => ({
    files: total.files + 1,
    added: total.added + row.added,
    deleted: total.deleted + row.deleted
  }), { files: 0, added: 0, deleted: 0 });
}

function diffRows(stat: string | null, fallbackFiles?: JobProgress["files"], limit = 8): DiffRow[] {
  const fallbackRows = progressDiffRows(fallbackFiles);
  if (!stat) return fallbackRows;
  const rows = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+\s+files?\s+changed\b/i.test(line))
    .flatMap((line) => {
      const match = line.match(/^(.*?)\s+\|\s+(\d+)\s+([+\-]+)?/);
      if (!match) return [];
      const bars = match?.[3] ?? "";
      return [{
        file: match?.[1]?.trim() || line,
        changed: Number(match?.[2] ?? 0),
        bars,
        added: [...bars].filter((char) => char === "+").length,
        deleted: [...bars].filter((char) => char === "-").length
      }];
    });
  const allRows = rows.length ? rows : fallbackRows;
  return limit === Number.POSITIVE_INFINITY ? allRows : allRows.slice(0, limit);
}

function diffSummary(stat: string | null, fallback?: { filesChanged?: number; added?: number; deleted?: number; files?: JobProgress["files"] } | null) {
  const rows = diffRows(stat, fallback?.files, Number.POSITIVE_INFINITY);
  const statSummary = stat?.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/i);
  const fromRows = diffSummaryFromRows(rows);
  return {
    files: Math.max(Number(statSummary?.[1] ?? 0), fromRows.files, fallback?.filesChanged || 0),
    added: Math.max(Number(statSummary?.[2] ?? 0), fromRows.added, fallback?.added || 0),
    deleted: Math.max(Number(statSummary?.[3] ?? 0), fromRows.deleted, fallback?.deleted || 0)
  };
}

function jobDurationSeconds(job: Job) {
  const start = Date.parse(job.startedAt || job.createdAt);
  const finish = Date.parse(job.finishedAt || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, Math.floor((finish - start) / 1000));
}

function renderDiffRowMeta(row: DiffRow) {
  if (row.added || row.deleted) {
    return (
      <>
        <span className="diff-added">+{row.added}</span>
        <span className="diff-deleted">-{row.deleted}</span>
      </>
    );
  }
  return <span className="diff-neutral">{row.changed}{row.bars ? ` ${row.bars}` : ""}</span>;
}

function messageDurationSeconds(message: ChatMessage) {
  if (typeof message.metadata?.durationSeconds === "number") return Math.max(0, Math.floor(message.metadata.durationSeconds));
  const startedAt = typeof message.metadata?.startedAt === "string" ? Date.parse(message.metadata.startedAt) : NaN;
  const finishedAt = Date.parse(message.createdAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
  return Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
}

function messageRunDetails(message: ChatMessage, job: Job | undefined, collapsedRun?: CollapsedRunSummary) {
  const runJob = job ?? collapsedRun?.job;
  const metadataModel = typeof message.metadata?.model === "string" ? message.metadata.model : "";
  const metadataReasoning = typeof message.metadata?.reasoningEffort === "string" ? message.metadata.reasoningEffort : "";
  const metadataSpeed = typeof message.metadata?.speed === "string" ? message.metadata.speed : "";
  const model = runJob?.model || metadataModel;
  const reasoning = runJob?.reasoningEffort || metadataReasoning;
  const speed = runJob?.speed || metadataSpeed;
  const durationSeconds = collapsedRun?.durationSeconds ?? (runJob?.finishedAt ? jobDurationSeconds(runJob) : messageDurationSeconds(message));
  const settings = [
    model ? CODEX_MODEL_OPTIONS.find((option) => option.value === model)?.label ?? model : "",
    reasoning ? `Intelligence ${REASONING_OPTIONS.find((option) => option.value === reasoning)?.label ?? reasoning}` : "",
    speed ? `Speed ${SPEED_OPTIONS.find((option) => option.value === speed)?.label ?? speed}` : ""
  ].filter(Boolean);
  const timing = [
    new Date(message.createdAt).toLocaleString(),
    durationSeconds > 0 ? `Работал ${formatDuration(durationSeconds)}` : ""
  ].filter(Boolean);
  return { settings, timing };
}

function parseCommandOutput(output: string) {
  const normalized = normalizeDisplayText(output).trim();
  const exitCode = normalized.match(/^Exit code:\s*([^\n]+)$/im)?.[1]?.trim();
  const wallTime = normalized.match(/^Wall time:\s*([^\n]+)$/im)?.[1]?.trim();
  const body = normalized
    .replace(/^Exit code:\s*[^\n]+\n?/im, "")
    .replace(/^Wall time:\s*[^\n]+\n?/im, "")
    .replace(/^Output:\s*\n?/im, "")
    .trim();
  return { exitCode, wallTime, body };
}

function normalizeDisplayText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "  ");
}

function renderInlineMarkdown(text: string) {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      nodes.push(<code key={nodes.length}>{link ? `${link[1]} ${link[2]}` : token}</code>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderRichText(value: string, className = "rich-text") {
  const lines = normalizeDisplayText(value).trim().split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="rich-code" key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading?.[2]) {
      blocks.push(<h3 key={blocks.length}>{renderInlineMarkdown(heading[2])}</h3>);
      index += 1;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const itemLine = lines[index] ?? "";
        const item = ordered ? itemLine.match(/^\s*\d+[.)]\s+(.+)$/) : itemLine.match(/^\s*[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      const children = items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{children}</ol> : <ul key={blocks.length}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^```\s*[\w-]*\s*$/.test(lines[index] ?? "") &&
      !/^(#{1,3})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+[.)]\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(<p key={blocks.length}>{renderInlineMarkdown(paragraph.join(" "))}</p>);
  }

  return <div className={className}>{blocks.length ? blocks : <p>{value}</p>}</div>;
}

function attachmentDataUrl(attachment: MessageAttachment) {
  return attachment.dataBase64 && isPreviewableImage(attachment.mimeType) ? `data:${attachment.mimeType};base64,${attachment.dataBase64}` : undefined;
}

function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (!isPreviewableImage(attachment.mimeType)) return undefined;
  return attachmentDataUrl(attachment) ?? attachment.url;
}

function renderMessageAttachments(attachments: MessageAttachment[] | undefined, onPreview: (preview: ImagePreview) => void) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment, index) => {
        const previewUrl = attachmentPreviewUrl(attachment);
        const body = (
          <>
            {previewUrl ? <img alt="" loading="lazy" src={previewUrl} /> : <Paperclip size={16} />}
            <span>
              <strong>{attachment.name}</strong>
              <small>{attachment.mimeType} · {formatBytes(attachment.size)}</small>
            </span>
          </>
        );
        if (previewUrl) {
          return (
            <button
              className="message-attachment image"
              key={attachment.id ?? `${attachment.name}-${index}`}
              type="button"
              onClick={() => onPreview({ src: previewUrl, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size })}
            >
              {body}
            </button>
          );
        }
        if (attachment.url) {
          return (
            <a
              className="message-attachment"
              href={attachment.url}
              key={attachment.id ?? `${attachment.name}-${index}`}
              rel="noreferrer"
              target="_blank"
            >
              {body}
            </a>
          );
        }
        return (
          <div
            className="message-attachment"
            key={attachment.id ?? `${attachment.name}-${index}`}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}

function summarizeDisplayCommand(command: string) {
  return command
    .replace(/"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"\s+-Command\s+/i, "")
    .replace(/^powershell(?:\.exe)?\s+-Command\s+/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function messageJobId(message: ChatMessage) {
  const metadataJobId = typeof message.metadata?.jobId === "string" ? message.metadata.jobId : "";
  return metadataJobId || message.externalId?.match(/^job:([^:]+):/)?.[1] || "";
}

function isJobFinished(job: Job) {
  return Boolean(job.finishedAt && !["queued", "assigned", "running"].includes(job.status));
}

function isJobRunning(job: Job) {
  return ["queued", "assigned", "running"].includes(job.status);
}

function isTerminalJobStatus(status: string) {
  return !["queued", "assigned", "running"].includes(status);
}

function isJobPromptMessage(message: ChatMessage, jobId: string) {
  return message.externalId === `job:${jobId}:prompt` || (message.role === "user" && messageJobId(message) === jobId);
}

function isJobFinalMessage(message: ChatMessage, jobId: string) {
  return message.externalId === `job:${jobId}:final` || (
    message.role === "assistant"
    && messageJobId(message) === jobId
    && typeof message.metadata?.status === "string"
  );
}

function shouldCollapseRunMessage(message: ChatMessage, jobId: string) {
  if (isJobFinalMessage(message, jobId) || isJobPromptMessage(message, jobId)) return false;
  return message.role === "assistant" || message.role === "tool";
}

function shouldCollapseCompletedTurnMessage(message: ChatMessage) {
  return message.role === "assistant" || message.role === "tool";
}

const CHAT_TOP_THRESHOLD_PX = 120;
const CHAT_BOTTOM_THRESHOLD_PX = 16;

function displayLogMessage(log: Log) {
  const rawText = log.message.trim();
  if (!rawText) return null;
  if (/ERROR\s+codex_core::session:\s+failed to record rollout items:\s+thread .* not found/i.test(rawText)) return null;
  try {
    const event = JSON.parse(rawText) as Record<string, unknown>;
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "thread.started") return "Codex thread started.";
    if (type === "turn.started") return "Codex is thinking.";
    if (type === "item.started" && item?.type === "command_execution") {
      return `Running: ${summarizeDisplayCommand(String(item.command ?? "command"))}`;
    }
    if (type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      return normalizeDisplayText(item.text).trim();
    }
    if (type === "item.completed" && item?.type === "command_execution") {
      const command = summarizeDisplayCommand(String(item.command ?? "command"));
      const status = String(item.status ?? "completed");
      const output = typeof item.aggregated_output === "string" ? normalizeDisplayText(item.aggregated_output).trim() : "";
      return [output ? `${command}: ${status}.` : `${command}: ${status}.`, output].filter(Boolean).join("\n\n");
    }
    return type ? `Codex event: ${type}` : null;
  } catch {
    return normalizeDisplayText(rawText).trim();
  }
}

function codexActionEntries(logs: Log[]): CodexAction[] {
  const byId = new Map<string, CodexAction>();
  logs.forEach((log, index) => {
    const rawText = log.message.trim();
    if (!rawText.startsWith("{")) return;
    try {
      const event = JSON.parse(rawText) as Record<string, unknown>;
      const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
      if (item?.type !== "command_execution") return;
      const id = typeof item.id === "string" ? item.id : `${log.at}:${index}`;
      const current = byId.get(id);
      const command = summarizeDisplayCommand(String(item.command ?? current?.command ?? "command"));
      const output = typeof item.aggregated_output === "string" ? normalizeDisplayText(item.aggregated_output).trim() : current?.output ?? "";
      byId.set(id, {
        id,
        command,
        output,
        status: String(item.status ?? current?.status ?? (event.type === "item.started" ? "running" : "completed")),
        at: log.at
      });
    } catch {
      // Non-JSON lines are rendered in the raw log panel instead.
    }
  });
  return [...byId.values()];
}

function metadataCodexActions(message: ChatMessage): CodexAction[] {
  const raw = message.metadata?.codexActions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const command = typeof value.command === "string" ? value.command.trim() : "";
    if (!command) return [];
    return [{
      id: typeof value.id === "string" ? value.id : `${message.id}:action:${index}`,
      command: summarizeDisplayCommand(command),
      status: typeof value.status === "string" ? value.status : "completed",
      output: typeof value.output === "string" ? normalizeDisplayText(value.output).trim() : "",
      at: typeof value.at === "string" ? value.at : message.createdAt
    }];
  });
}

function buildChatTimeline(messages: ChatMessage[], jobs: Job[], keepLatestTurnExpanded = false): ChatTimelineItem[] {
  const hiddenMessageIds = new Set<string>();
  const collapsedByFinalId = new Map<string, CollapsedRunSummary>();
  const collapseMessages = (finalMessage: ChatMessage, collapsedMessages: ChatMessage[], job?: Job) => {
    const nextMessages = collapsedMessages.filter((message) => !hiddenMessageIds.has(message.id));
    if (!nextMessages.length) return;
    nextMessages.forEach((message) => hiddenMessageIds.add(message.id));
    const existing = collapsedByFinalId.get(finalMessage.id);
    const mergedMessages = existing ? [...existing.messages, ...nextMessages] : nextMessages;
    const uniqueMessages = [...new Map(mergedMessages.map((message) => [message.id, message])).values()]
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const firstStepAt = Date.parse(uniqueMessages[0]?.createdAt ?? finalMessage.createdAt);
    const finalAt = Date.parse(finalMessage.createdAt);
    collapsedByFinalId.set(finalMessage.id, {
      job: job ?? existing?.job,
      messages: uniqueMessages,
      commandCount: uniqueMessages.reduce((total, message) => total + metadataCodexActions(message).length, 0),
      durationSeconds: job
        ? jobDurationSeconds(job)
        : Number.isFinite(firstStepAt) && Number.isFinite(finalAt)
          ? Math.max(0, Math.floor((finalAt - firstStepAt) / 1000))
          : existing?.durationSeconds ?? 0
    });
  };
  const completedJobs = jobs
    .filter(isJobFinished)
    .slice()
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  for (const job of completedJobs) {
    const promptIndex = messages.findIndex((message) => isJobPromptMessage(message, job.id));
    const finalIndex = messages.findIndex((message) => isJobFinalMessage(message, job.id));
    if (finalIndex < 0) continue;
    const startIndex = promptIndex >= 0 ? promptIndex : messages.findIndex((message) => Date.parse(message.createdAt) >= Date.parse(job.createdAt));
    const from = startIndex >= 0 ? startIndex + 1 : 0;
    const collapsedMessages = messages
      .slice(from, finalIndex)
      .filter((message) => shouldCollapseRunMessage(message, job.id))
      .filter((message) => !hiddenMessageIds.has(message.id));
    collapseMessages(messages[finalIndex]!, collapsedMessages, job);
  }

  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user") continue;
    const nextUserIndex = messages.findIndex((message, nextIndex) => nextIndex > index && message.role === "user");
    const segmentEnd = nextUserIndex >= 0 ? nextUserIndex : messages.length;
    if (keepLatestTurnExpanded && segmentEnd === messages.length) continue;
    const segment = messages.slice(index + 1, segmentEnd).filter((message) => !hiddenMessageIds.has(message.id));
    const finalMessage = segment.slice().reverse().find((message) => message.role === "assistant");
    if (!finalMessage || collapsedByFinalId.has(finalMessage.id)) continue;
    const finalIndex = messages.findIndex((message) => message.id === finalMessage.id);
    const collapsedMessages = messages
      .slice(index + 1, finalIndex)
      .filter((message) => !hiddenMessageIds.has(message.id))
      .filter(shouldCollapseCompletedTurnMessage);
    collapseMessages(finalMessage, collapsedMessages);
  }

  return messages
    .filter((message) => !hiddenMessageIds.has(message.id))
    .map((message) => ({
      message,
      collapsedRun: collapsedByFinalId.get(message.id)
    }));
}

function mergeJobs(current: Job[], incoming: Job[]) {
  const byId = new Map(current.map((job) => [job.id, job]));
  incoming.forEach((job) => {
    const existing = byId.get(job.id);
    if (existing && job.gitDiffOmitted && existing.gitDiff && !job.gitDiff) {
      byId.set(job.id, {
        ...existing,
        ...job,
        gitDiff: existing.gitDiff,
        gitDiffStat: job.gitDiffStat ?? existing.gitDiffStat,
        gitDiffOmitted: false
      });
      return;
    }
    byId.set(job.id, job);
  });
  return [...byId.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  return incoming.map((message) => {
    const existing = byId.get(message.id);
    if (!existing?.metadata) return message;
    const incomingMetadata = message.metadata ?? {};
    if (!incomingMetadata.metadataOmitted && !incomingMetadata.gitDiffOmitted) return message;
    const metadata = { ...existing.metadata, ...incomingMetadata };
    if (incomingMetadata.gitDiffOmitted && typeof existing.metadata.gitDiff === "string" && typeof incomingMetadata.gitDiff !== "string") {
      metadata.gitDiff = existing.metadata.gitDiff;
      metadata.gitDiffStat = incomingMetadata.gitDiffStat ?? existing.metadata.gitDiffStat;
      metadata.gitDiffOmitted = false;
    }
    if (incomingMetadata.metadataOmitted && Array.isArray(existing.metadata.codexActions) && !Array.isArray(incomingMetadata.codexActions)) {
      metadata.codexActions = existing.metadata.codexActions;
      metadata.metadataOmitted = false;
    }
    return { ...message, metadata };
  });
}

function progressMapFromJobs(jobs: Job[]) {
  const entries = jobs
    .map((job) => job.progress ? [job.id, job.progress] as const : null)
    .filter((entry): entry is readonly [string, JobProgress] => Boolean(entry));
  return Object.fromEntries(entries);
}

function messageUpdateSignature(message: ChatMessage) {
  const actionCount = Array.isArray(message.metadata?.codexActions) ? message.metadata.codexActions.length : 0;
  const changeStat = typeof message.metadata?.gitDiffStat === "string" ? message.metadata.gitDiffStat.length : 0;
  const changeDiff = typeof message.metadata?.gitDiff === "string" ? message.metadata.gitDiff.length : 0;
  return [
    message.id,
    message.createdAt,
    message.content.length,
    message.attachments?.length ?? 0,
    actionCount,
    changeStat,
    changeDiff
  ].join(":");
}

function renderLogs(logs: Log[]) {
  const visibleLogs = logs
    .map((line) => ({ ...line, display: displayLogMessage(line) }))
    .filter((line): line is Log & { display: string } => Boolean(line.display));

  if (!visibleLogs.length) return <div className="empty small-empty">Waiting for logs...</div>;
  return (
    <div className="logs-rich">
      {visibleLogs.map((line, index) => (
        <article className={`log-entry ${line.stream}`} key={line.id ?? `${line.at}:${index}`}>
          <div className="log-meta">
            <span>{line.stream}</span>
            <small>{new Date(line.at).toLocaleTimeString()}</small>
          </div>
          {renderRichText(line.display, "rich-text compact")}
        </article>
      ))}
    </div>
  );
}

function App() {
  const [csrf, setCsrf] = useState<string>();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [registerNickname, setRegisterNickname] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authOauthProviders, setAuthOauthProviders] = useState<OAuthProvider[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [progressByJob, setProgressByJob] = useState<Record<string, JobProgress>>({});
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [repoKey, setRepoKey] = useState("");
  const [activeChatId, setActiveChatId] = useState("");
  const [chatLoadingId, setChatLoadingId] = useState("");
  const [chatLoadingProgress, setChatLoadingProgress] = useState<ChatLoadingProgress | null>(null);
  const [sandbox, setSandbox] = useState<Sandbox>("danger-full-access");
  const [busy, setBusy] = useState(false);
  const [projectPanel, setProjectPanel] = useState<"new" | "settings" | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectGithubUrl, setProjectGithubUrl] = useState("");
  const [projectServerPath, setProjectServerPath] = useState("");
  const [projectDomain, setProjectDomain] = useState("");
  const [projectDeploySshTarget, setProjectDeploySshTarget] = useState("");
  const [projectDeploySourceDir, setProjectDeploySourceDir] = useState("dist");
  const [projectDeployRemoteSubdir, setProjectDeployRemoteSubdir] = useState("");
  const [projectDeployBuildCommand, setProjectDeployBuildCommand] = useState("npm.cmd run build");
  const [projectDeployCleanRemote, setProjectDeployCleanRemote] = useState(true);
  const [sandboxMenuOpen, setSandboxMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [codexModel, setCodexModel] = useState("gpt-5.5");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [codexSpeed, setCodexSpeed] = useState<CodexSpeed>("standard");
  const [originalProjectPath, setOriginalProjectPath] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [chatMenuId, setChatMenuId] = useState("");
  const [chatProperties, setChatProperties] = useState<Chat | null>(null);
  const [chatSettingsTitle, setChatSettingsTitle] = useState("");
  const [linkedChatId, setLinkedChatId] = useState("");
  const [hiddenLocalChats, setHiddenLocalChats] = useState<Chat[]>([]);
  const [gitMessage, setGitMessage] = useState("Update project");
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitNotice, setGitNotice] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [deployNotice, setDeployNotice] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [nginxNotice, setNginxNotice] = useState("");
  const [nginxBusy, setNginxBusy] = useState(false);
  const [sslNotice, setSslNotice] = useState("");
  const [sslBusy, setSslBusy] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const [projectNotice, setProjectNotice] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [view, setView] = useState<"projects" | "settings" | "profile">("projects");
  const [users, setUsers] = useState<User[]>([]);
  const [profileStatsData, setProfileStatsData] = useState<ProfileStats | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [profileNickname, setProfileNickname] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [profileAvatarDataUrl, setProfileAvatarDataUrl] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<"admin" | "user">("user");
  const [newAgentName, setNewAgentName] = useState("My Windows Agent");
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentUserId, setNewAgentUserId] = useState("");
  const [agentSetup, setAgentSetup] = useState<AgentSetup | null>(null);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [localBusyHold, setLocalBusyHold] = useState<{ until: number; since?: string }>({ until: 0 });
  const [highlightedMessageIds, setHighlightedMessageIds] = useState<Set<string>>(() => new Set());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [showChatScrollTop, setShowChatScrollTop] = useState(false);
  const [showChatScrollBottom, setShowChatScrollBottom] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selectedRepo = useMemo(() => repos.find((repo) => `${repo.agentId}:${repo.id}` === repoKey), [repoKey, repos]);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [activeChatId, chats]);
  const chatIsLoading = Boolean(activeChatId && chatLoadingId === activeChatId);
  const chatLoadingPercent = progressPercent(chatLoadingProgress);
  const chatLoadingDeterminate = Boolean(chatLoadingProgress?.totalBytes);
  const chatLoadingLabel = chatLoadingProgress ? chatLoadingPhaseLabel(chatLoadingProgress.phase) : "Загружаю чат";
  const selectedAgent = agents.find((agent) => agent.status === "online") ?? agents[0];
  const online = agents.some((agent) => agent.status === "online");
  const localActivity = selectedAgent?.localActivity;
  const activeJobFinalMessageSeen = Boolean(activeJob && messages.some((message) => (
    message.role === "assistant"
    && messageJobId(message) === activeJob.id
    && (message.externalId === `job:${activeJob.id}:final` || typeof message.metadata?.status === "string")
  )));
  const activeRunBusy = Boolean(activeJob && ["queued", "assigned", "running"].includes(activeJob.status) && !activeJobFinalMessageSeen);
  const runningJobs = useMemo(() => mergeJobs(allJobs, activeJob && activeRunBusy ? [activeJob] : []).filter(isJobRunning), [allJobs, activeJob, activeRunBusy]);
  const webActivityRunning = Boolean(
    localActivity?.source === "codex.rodion.pro"
    && (
      activeRunBusy
      || (selectedAgent?.current_job_id && runningJobs.some((job) => job.id === selectedAgent.current_job_id))
    )
  );
  const localActivityUpdatedAt = Date.parse(localActivity?.updatedAt || "");
  const localActivityUpdatedFresh = Number.isFinite(localActivityUpdatedAt) && nowTick - localActivityUpdatedAt <= 15000;
  const localActivityDetectedAt = Date.parse(localActivity?.detectedAt || "");
  const localActivityHeartbeatFresh = Number.isFinite(localActivityDetectedAt) && nowTick - localActivityDetectedAt <= 30000;
  const externalLocalActivityBusy = Boolean(
    localActivity?.source !== "codex.rodion.pro"
    && localActivity?.status === "busy"
    && (localActivityUpdatedFresh || localActivityHeartbeatFresh)
  );
  const staleCurrentWebJob = Boolean(selectedAgent?.current_job_id && selectedAgent.current_job_id === activeJob?.id && !activeRunBusy);
  const staleLocalWebBusy = Boolean(localActivity?.source === "codex.rodion.pro" && !activeRunBusy && activeJob?.finishedAt);
  const latestLocalAssistantMessageAt = Math.max(0, ...messages
    .filter((message) => message.role === "assistant")
    .map((message) => Date.parse(message.createdAt))
    .filter(Number.isFinite));
  const localFinalMessageLikelySeen = Boolean(
    (!localActivity?.repoId || selectedRepo?.id === localActivity.repoId)
    &&
    latestLocalAssistantMessageAt
    && Number.isFinite(localActivityUpdatedAt)
    && latestLocalAssistantMessageAt >= localActivityUpdatedAt - 1000
    && nowTick - Math.max(latestLocalAssistantMessageAt, localActivityUpdatedAt) > 12000
  );
  const rawLocalCodexBusy = Boolean(
    (externalLocalActivityBusy || webActivityRunning)
    && !staleCurrentWebJob
    && !staleLocalWebBusy
    && !localFinalMessageLikelySeen
  );
  const localCodexBusy = rawLocalCodexBusy || localBusyHold.until > nowTick;
  const localBusySince = rawLocalCodexBusy
    ? localBusyHold.since || localActivity?.busySinceAt || localActivity?.updatedAt || localActivity?.detectedAt
    : localBusyHold.since;
  const thinkingSince = activeRunBusy
    ? activeJob?.startedAt || activeJob?.createdAt
    : localCodexBusy
      ? localBusySince
      : undefined;
  const thinkingSeconds = thinkingSince ? Math.max(0, Math.floor((nowTick - Date.parse(thinkingSince)) / 1000)) : 0;
  const busyChatIds = useMemo(() => new Set(runningJobs.map((job) => job.chatId).filter((chatId): chatId is string => Boolean(chatId))), [runningJobs]);
  const activeBusyChatIds = useMemo(() => {
    const ids = new Set(busyChatIds);
    if (!selectedRepo) return ids;

    runningJobs
      .filter((job) => job.agentId === selectedRepo.agentId && job.repoId === selectedRepo.id)
      .forEach((job) => {
        const chatId = job.chatId || activeChatId;
        if (chatId) ids.add(chatId);
      });

    if (activeJob && activeRunBusy && activeJob.agentId === selectedRepo.agentId && activeJob.repoId === selectedRepo.id) {
      const chatId = activeJob?.chatId || activeChatId;
      if (chatId) ids.add(chatId);
    }
    return ids;
  }, [activeChatId, activeJob, activeRunBusy, busyChatIds, runningJobs, selectedRepo]);
  const localBusyRepoKey = localCodexBusy && localActivity?.repoId && selectedAgent?.id
    ? `${selectedAgent.id}:${localActivity.repoId}`
    : "";
  const localBusyChatTitle = localCodexBusy ? localActivity?.chatTitle : undefined;
  const localBusyFallbackChatId = localCodexBusy
    && localBusyRepoKey === `${selectedRepo?.agentId ?? ""}:${selectedRepo?.id ?? ""}`
    ? activeJob?.chatId ?? activeChatId
    : "";
  const busyCountByRepo = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    const addBusy = (repoKeyValue: string, busyKey: string) => {
      const current = counts.get(repoKeyValue) ?? new Set<string>();
      current.add(busyKey);
      counts.set(repoKeyValue, current);
    };
    runningJobs.forEach((job) => addBusy(`${job.agentId}:${job.repoId}`, job.chatId ? `chat:${job.chatId}` : `job:${job.id}`));
    if (localBusyRepoKey) addBusy(localBusyRepoKey, `local:${localActivity?.chatTitle ?? localBusyFallbackChatId ?? "codex"}`);
    return new Map([...counts.entries()].map(([key, value]) => [key, value.size]));
  }, [localBusyFallbackChatId, localBusyRepoKey, localActivity?.chatTitle, runningJobs]);
  const activeChatIdRef = useRef(activeChatId);
  const activeJobIdRef = useRef(activeJob?.id ?? "");
  const selectedRepoRef = useRef<Repo | undefined>(selectedRepo);
  const loadChatsTimerRef = useRef<number | undefined>(undefined);
  const loadChatTimerRef = useRef<number | undefined>(undefined);
  const loadJobTimerRef = useRef<number | undefined>(undefined);
  const loadAllJobsTimerRef = useRef<number | undefined>(undefined);
  const loadChatsAbortRef = useRef<AbortController | null>(null);
  const loadChatAbortRef = useRef<AbortController | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const chatThreadRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const firstMessageRef = useRef<HTMLElement | null>(null);
  const lastMessageRef = useRef<HTMLElement | null>(null);
  const currentScrollChatRef = useRef("");
  const chatCacheRef = useRef<Map<string, { etag: string; data: ChatPayload }>>(new Map());
  const previousMessageIdsRef = useRef<Set<string>>(new Set());
  const previousMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const chatAtBottomRef = useRef(true);
  activeChatIdRef.current = activeChatId;
  activeJobIdRef.current = activeJob?.id ?? "";
  selectedRepoRef.current = selectedRepo;
  const activeProgress = activeJob ? progressByJob[activeJob.id] ?? activeJob.progress ?? {
    jobId: activeJob.id,
    phase: activeJob.status,
    message: activeJob.status === "running" ? "Codex is running." : `Job is ${activeJob.status}.`,
    filesChanged: 0,
    added: 0,
    deleted: 0,
    files: [],
    at: new Date().toISOString()
  } : null;
  const firstActiveProgressFile = activeProgress?.files?.[0];
  const timelineItems = useMemo(() => buildChatTimeline(messages, jobs, localCodexBusy || activeRunBusy), [messages, jobs, localCodexBusy, activeRunBusy]);

  function isScrollableElement(element: HTMLElement | null | undefined): element is HTMLElement {
    if (!element || element.scrollHeight <= element.clientHeight + 1) return false;
    const overflowY = getComputedStyle(element).overflowY;
    return overflowY !== "visible" && overflowY !== "clip";
  }

  function getChatScroller(): HTMLElement {
    const shell = shellRef.current;
    if (isScrollableElement(shell)) return shell;

    const root = document.getElementById("root");
    if (isScrollableElement(root)) return root;

    const scrollingElement = document.scrollingElement as HTMLElement | null;
    if (isScrollableElement(scrollingElement)) return scrollingElement;

    if (isScrollableElement(document.body)) return document.body;

    return (document.scrollingElement || document.documentElement) as HTMLElement;
  }

  function updateChatBottomState() {
    const scroller = getChatScroller();
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const atBottom = distanceToBottom <= CHAT_BOTTOM_THRESHOLD_PX;
    const atTop = scroller.scrollTop <= CHAT_TOP_THRESHOLD_PX;
    chatAtBottomRef.current = atBottom;
    setShowChatScrollTop(!atTop);
    setShowChatScrollBottom(!atBottom);
    if (atBottom) setShowJumpToLatest(false);
  }

  function scrollChatToLatest(behavior: ScrollBehavior = "smooth") {
    const scroller = getChatScroller();
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    chatAtBottomRef.current = true;
    setShowJumpToLatest(false);
    setShowChatScrollBottom(false);
    window.setTimeout(updateChatBottomState, behavior === "smooth" ? 260 : 0);
  }

  function scrollChatToTop(behavior: ScrollBehavior = "smooth") {
    const target = firstMessageRef.current ?? chatThreadRef.current ?? shellRef.current;
    target?.scrollIntoView({ behavior, block: "start" });
    chatAtBottomRef.current = false;
    setShowChatScrollBottom(true);
    window.setTimeout(updateChatBottomState, behavior === "smooth" ? 260 : 0);
  }

  function updateComposerPlacement() {
    const composer = composerRef.current;
    if (!composer) return;
    const height = Math.ceil(composer.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--composer-space", `${height + 12}px`);
  }

  async function refresh() {
    const [agentResponse, repoResponse, jobsResponse] = await Promise.all([api("/api/agents"), api("/api/repos"), api("/api/jobs")]);
    if (agentResponse.ok) setAgents((await agentResponse.json()).agents);
    if (jobsResponse.ok) setAllJobs((await jobsResponse.json()).jobs);
    if (repoResponse.ok) {
      const nextRepos = (await repoResponse.json()).repos;
      setRepos(nextRepos);
      if (repoKey && !nextRepos.some((repo: Repo) => `${repo.agentId}:${repo.id}` === repoKey)) {
        clearProjectSelection();
      }
    }
  }

  async function loadAllJobs() {
    const response = await api("/api/jobs");
    if (!response.ok) return;
    setAllJobs((await response.json()).jobs);
  }

  async function loadUsers() {
    if (currentUser?.role !== "admin") return;
    const response = await api("/api/users");
    if (response.ok) setUsers((await response.json()).users);
  }

  async function loadProfile() {
    const response = await api("/api/profile");
    if (!response.ok) return;
    const data = await response.json();
    setCurrentUser(data.user);
    setProfileStatsData(data.stats);
    setOauthProviders(data.oauth);
    setProfileNickname(data.user.nickname ?? "");
    setProfileBio(data.user.bio ?? "");
    setProfileAvatarDataUrl(data.user.avatarDataUrl ?? "");
  }

  async function loadAuthOAuthProviders() {
    const response = await api("/api/oauth/providers");
    if (response.ok) setAuthOauthProviders((await response.json()).providers);
  }

  async function loadChats(repo: Repo, selectFirst = false) {
    loadChatsAbortRef.current?.abort();
    const controller = new AbortController();
    loadChatsAbortRef.current = controller;
    try {
      const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}`, { signal: controller.signal });
      if (loadChatsAbortRef.current !== controller) return;
      if (!response.ok) {
        loadChatsAbortRef.current = null;
        return;
      }
      const nextChats = (await response.json()).chats;
      if (loadChatsAbortRef.current !== controller) return;
      loadChatsAbortRef.current = null;
      setChats(nextChats);
      if (selectFirst && nextChats[0]) {
        await loadChat(nextChats[0].id, undefined, true);
        return;
      }
      if (activeChatId && !nextChats.some((chat: Chat) => chat.id === activeChatId)) {
        setActiveChatId("");
        setChatLoadingId("");
        setChatLoadingProgress(null);
        setJobs([]);
        setMessages([]);
        setActiveJob(null);
        setLogs([]);
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
  }

  async function loadHiddenLocalChats(repo: Repo) {
    const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}&includeHidden=1&localOnly=1`);
    if (!response.ok) return;
    const nextChats = ((await response.json()).chats as Chat[]).filter((chat) => chat.hiddenAt);
    setHiddenLocalChats(nextChats);
  }

  async function loadChat(chatId: string, preferredJobId?: string, showLoader = false) {
    loadChatAbortRef.current?.abort();
    const controller = new AbortController();
    loadChatAbortRef.current = controller;
    const loadingStartedAt = Date.now();
    if (showLoader) {
      setActiveChatId(chatId);
      setChatLoadingId(chatId);
      setChatLoadingProgress({ phase: "request", loadedBytes: 0, percent: 4, startedAt: loadingStartedAt });
      setChatNotice("");
    }
    try {
      const cached = chatCacheRef.current.get(chatId);
      const response = await fetch(`/api/chats/${chatId}`, {
        signal: controller.signal,
        headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined
      });
      if (loadChatAbortRef.current !== controller) return;
      let data: ChatPayload;
      let loadedBytes = 0;
      let totalBytes: number | undefined;
      if (response.status === 304 && cached) {
        data = cached.data;
        if (showLoader) setChatLoadingProgress({ phase: "parse", loadedBytes: 0, percent: 92, startedAt: loadingStartedAt });
      } else {
      if (!response.ok) {
        loadChatAbortRef.current = null;
        setChatLoadingId((current) => current === chatId ? "" : current);
        setChatLoadingProgress((current) => current?.startedAt === loadingStartedAt ? null : current);
        return;
      }
      const totalHeader = Number(response.headers.get("content-length") ?? 0);
      totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
      let responseText = "";
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (loadChatAbortRef.current !== controller) return;
          loadedBytes += value.byteLength;
          responseText += decoder.decode(value, { stream: true });
          if (showLoader) {
            const downloadPercent = totalBytes ? 8 + Math.min(82, (loadedBytes / totalBytes) * 82) : undefined;
            setChatLoadingProgress({
              phase: "download",
              loadedBytes,
              totalBytes,
              percent: downloadPercent,
              startedAt: loadingStartedAt
            });
          }
        }
        responseText += decoder.decode();
      } else {
        responseText = await response.text();
        loadedBytes = new Blob([responseText]).size;
        if (showLoader) {
          setChatLoadingProgress({ phase: "download", loadedBytes, totalBytes, percent: totalBytes ? 90 : undefined, startedAt: loadingStartedAt });
        }
      }
      if (loadChatAbortRef.current !== controller) return;
      if (showLoader) setChatLoadingProgress({ phase: "parse", loadedBytes, totalBytes, percent: 92, startedAt: loadingStartedAt });
      data = JSON.parse(responseText) as ChatPayload;
      const etag = response.headers.get("etag");
      if (etag) chatCacheRef.current.set(chatId, { etag, data });
      }
      if (loadChatAbortRef.current !== controller) return;
      loadChatAbortRef.current = null;
      setChats((current) => {
        const withoutLoaded = current.filter((chat) => chat.id !== data.chat.id);
        return [data.chat, ...withoutLoaded].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      });
      setActiveChatId(chatId);
      setJobs((current) => mergeJobs(current.filter((job) => job.chatId === chatId), data.jobs));
      setAllJobs((current) => mergeJobs(current, data.jobs));
      setProgressByJob((current) => ({ ...current, ...progressMapFromJobs(data.jobs) }));
      setMessages((current) => mergeChatMessages(current.filter((message) => message.chatId === chatId), data.messages ?? []));
      const targetJobId = preferredJobId ?? data.jobs[0]?.id;
      if (targetJobId) {
        if (showLoader) setChatLoadingProgress({ phase: "details", loadedBytes, totalBytes, percent: 96, startedAt: loadingStartedAt });
        await loadJob(targetJobId);
      }
      else {
        setActiveJob(null);
        setLogs([]);
      }
      setChatLoadingId((current) => current === chatId ? "" : current);
      setChatLoadingProgress((current) => current?.startedAt === loadingStartedAt ? null : current);
    } catch (error) {
      if (loadChatAbortRef.current === controller) {
        loadChatAbortRef.current = null;
        setChatLoadingId((current) => current === chatId ? "" : current);
        setChatLoadingProgress((current) => current?.startedAt === loadingStartedAt ? null : current);
      }
      if (!isAbortError(error)) throw error;
    }
  }

  async function loadJob(jobId: string) {
    const response = await api(`/api/jobs/${jobId}`);
    if (!response.ok) return;
    const data = await response.json();
    setActiveJob(data.job);
    setAllJobs((current) => mergeJobs(current, [data.job]));
    if (data.job?.progress) setProgressByJob((current) => ({ ...current, [data.job.id]: data.job.progress }));
    setLogs(data.logs);
  }

  async function loadJobDetails(jobId: string) {
    const response = await api(`/api/jobs/${jobId}`);
    if (!response.ok) return;
    const data = await response.json();
    setAllJobs((current) => mergeJobs(current, [data.job]));
    setJobs((current) => mergeJobs(current, [data.job]));
    setActiveJob((current) => current?.id === jobId ? data.job : current);
    if (data.job?.progress) setProgressByJob((current) => ({ ...current, [data.job.id]: data.job.progress }));
  }

  async function loadMessageDetails(messageId: string) {
    const response = await api(`/api/chat-messages/${messageId}/details`);
    if (!response.ok) return;
    const data = await response.json();
    setMessages((current) => current.map((message) => message.id === messageId ? data.message : message));
  }

  function scheduleLoadChats(repo: Repo) {
    if (loadChatsTimerRef.current) window.clearTimeout(loadChatsTimerRef.current);
    loadChatsTimerRef.current = window.setTimeout(() => {
      loadChats(repo).catch(() => undefined);
    }, 250);
  }

  function scheduleLoadChat(chatId: string) {
    if (loadChatTimerRef.current) window.clearTimeout(loadChatTimerRef.current);
    loadChatTimerRef.current = window.setTimeout(() => {
      loadChat(chatId).catch(() => undefined);
    }, 250);
  }

  function scheduleLoadJob(jobId: string) {
    if (loadJobTimerRef.current) window.clearTimeout(loadJobTimerRef.current);
    loadJobTimerRef.current = window.setTimeout(() => {
      loadJob(jobId).catch(() => undefined);
    }, 250);
  }

  function scheduleLoadAllJobs() {
    if (loadAllJobsTimerRef.current) window.clearTimeout(loadAllJobsTimerRef.current);
    loadAllJobsTimerRef.current = window.setTimeout(() => {
      loadAllJobs().catch(() => undefined);
    }, 250);
  }

  function applyJobStatusUpdate(jobId: string, status: string) {
    const finishedAt = isTerminalJobStatus(status) ? new Date().toISOString() : undefined;
    const patchJob = (job: Job): Job => (
      job.id === jobId
        ? { ...job, status, finishedAt: finishedAt ?? job.finishedAt }
        : job
    );
    setAllJobs((current) => current.map(patchJob));
    setJobs((current) => current.map(patchJob));
    setActiveJob((current) => current?.id === jobId ? patchJob(current) : current);
    if (finishedAt) {
      setAgents((current) => current.map((agent) => (
        agent.current_job_id === jobId ? { ...agent, current_job_id: null } : agent
      )));
      setLocalBusyHold({ until: 0 });
    }
  }

  async function openJob(job: Job) {
    if (job.chatId) await loadChat(job.chatId, job.id);
    else await loadJob(job.id);
  }

  function selectProject(repo: Repo) {
    setMobileMenuOpen(false);
    setRepoKey(`${repo.agentId}:${repo.id}`);
    setSandbox(repo.defaultSandbox);
    setGitMessage(`Update ${repo.name}`);
    setGitRemoteUrl(repo.githubUrl ?? "");
    setGitNotice("");
    setDeployNotice("");
    setNginxNotice("");
    setSslNotice("");
    setActiveChatId("");
    setChatLoadingId("");
    setChatLoadingProgress(null);
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    loadChats(repo, true);
  }

  function clearProjectSelection() {
    setMobileMenuOpen(false);
    setView("projects");
    setRepoKey("");
    setChats([]);
    setActiveChatId("");
    setChatLoadingId("");
    setChatLoadingProgress(null);
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    setProjectPanel(null);
    setChatProperties(null);
    setChatMenuId("");
    setGitNotice("");
    setDeployNotice("");
    setNginxNotice("");
    setSslNotice("");
  }

  function openSettingsView() {
    setMobileMenuOpen(false);
    setView("settings");
    setProjectPanel(null);
    setRepoKey("");
    setActiveChatId("");
    setChatLoadingId("");
    setChatLoadingProgress(null);
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    loadUsers();
  }

  function openProfileView() {
    setMobileMenuOpen(false);
    setView("profile");
    setProjectPanel(null);
    setRepoKey("");
    setActiveChatId("");
    setChatLoadingId("");
    setChatLoadingProgress(null);
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    setProfileNotice("");
    loadProfile();
  }

  function openNewProject() {
    setProjectName("New Project");
    setProjectPath(defaultProjectPath("New Project"));
    setProjectGithubUrl("");
    setProjectServerPath("");
    setProjectDomain("");
    setProjectDeploySshTarget("myserver");
    setProjectDeploySourceDir("dist");
    setProjectDeployBuildCommand("npm.cmd run build");
    setProjectDeployCleanRemote(true);
    setOriginalProjectPath("");
    setProjectPanel("new");
  }

  function openProjectSettings(repo: Repo) {
    setProjectName(repo.name);
    setProjectPath(repo.pathMasked);
    setProjectGithubUrl(repo.githubUrl ?? "");
    setProjectServerPath(repo.serverPath ?? "");
    setProjectDomain(repo.domain ?? "");
    setProjectDeploySshTarget(repo.deploy?.sshTarget ?? "");
    setProjectDeploySourceDir(repo.deploy?.sourceDir ?? "dist");
    setProjectDeployRemoteSubdir(repo.deploy?.remoteSubdir ?? "");
    setProjectDeployBuildCommand(formatBuildCommand(repo.deploy));
    setProjectDeployCleanRemote(repo.deploy?.cleanRemote ?? true);
    setOriginalProjectPath(repo.pathMasked);
    setSandbox(repo.defaultSandbox);
    setProjectPanel("settings");
    setProjectNotice("");
  }

  function openChatProperties(chat: Chat) {
    setMobileMenuOpen(false);
    setChatProperties(chat);
    setChatSettingsTitle(chat.title);
    setLinkedChatId("");
    setChatMenuId("");
    if (selectedRepo) loadHiddenLocalChats(selectedRepo);
  }

  useEffect(() => {
    api("/api/me").then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      setCurrentUser(data.user);
      setCsrf(data.csrfToken);
      refresh();
    });
  }, []);

  useEffect(() => {
    if (!csrf) loadAuthOAuthProviders();
  }, [csrf]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cmc.codexRunSettings");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { model?: string; reasoningEffort?: ReasoningEffort; speed?: CodexSpeed };
      if (parsed.model && CODEX_MODEL_OPTIONS.some((option) => option.value === parsed.model)) setCodexModel(parsed.model);
      if (parsed.reasoningEffort && REASONING_OPTIONS.some((option) => option.value === parsed.reasoningEffort)) setReasoningEffort(parsed.reasoningEffort);
      if (parsed.speed && SPEED_OPTIONS.some((option) => option.value === parsed.speed)) setCodexSpeed(parsed.speed);
    } catch {
      try {
        localStorage.removeItem("cmc.codexRunSettings");
      } catch {
        // Ignore blocked storage.
      }
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("cmc.codexRunSettings", JSON.stringify({
        model: codexModel,
        reasoningEffort,
        speed: codexSpeed
      }));
    } catch {
      // The settings are just a UI convenience; a blocked storage write should not break chat.
    }
  }, [codexModel, reasoningEffort, codexSpeed]);

  useEffect(() => {
    if (!csrf) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(`${protocol}://${location.host}/api/ui/ws`);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "job.log") {
          setLogs((current) => (activeJobIdRef.current === message.jobId ? [...current, message] : current));
          return;
        }
        if (message.type === "job.progress") {
          setProgressByJob((current) => ({ ...current, [message.jobId]: message }));
          return;
        }
        if (message.type === "agent.activity") {
          setAgents((current) => current.map((agent) => (
            agent.id === message.agentId ? {
              ...agent,
              localActivity: message.localActivity,
              current_job_id: message.localActivity.status === "idle" ? null : agent.current_job_id
            } : agent
          )));
          return;
        }
        if (message.type === "agent.status") {
          setAgents((current) => current.map((agent) => (
            agent.id === message.agentId ? { ...agent, status: message.status } : agent
          )));
          return;
        }
        if (message.type === "repos.updated") {
          setRepos((current) => {
            const rest = current.filter((repo) => repo.agentId !== message.agentId);
            return [...rest, ...message.repos.map((repo: Omit<Repo, "agentId">) => ({ ...repo, agentId: message.agentId }))];
          });
          return;
        }
        if (message.type === "chats.updated") {
          const repo = selectedRepoRef.current;
          if (repo && message.agentId === repo.agentId && message.repoId === repo.id) scheduleLoadChats(repo);
          if (activeChatIdRef.current) scheduleLoadChat(activeChatIdRef.current);
          scheduleLoadAllJobs();
          return;
        }
        if (message.type === "job.created" || message.type === "job.updated") {
          if (typeof message.jobId === "string" && typeof message.status === "string") {
            applyJobStatusUpdate(message.jobId, message.status);
          }
          scheduleLoadAllJobs();
          if (message.jobId && activeJobIdRef.current === message.jobId) scheduleLoadJob(message.jobId);
          if (activeChatIdRef.current) scheduleLoadChat(activeChatIdRef.current);
        }
      };
      ws.onclose = () => {
        if (!closed) reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (loadChatsTimerRef.current) window.clearTimeout(loadChatsTimerRef.current);
      if (loadChatTimerRef.current) window.clearTimeout(loadChatTimerRef.current);
      if (loadJobTimerRef.current) window.clearTimeout(loadJobTimerRef.current);
      if (loadAllJobsTimerRef.current) window.clearTimeout(loadAllJobsTimerRef.current);
      ws?.close();
    };
  }, [csrf]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("mobile-menu-open", mobileMenuOpen);
    return () => document.body.classList.remove("mobile-menu-open");
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const update = () => updateChatBottomState();
    const scroller = getChatScroller();
    if (scroller !== document.documentElement && scroller !== document.body) {
      scroller.addEventListener("scroll", update, { passive: true });
    }
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.requestAnimationFrame(update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [activeChatId, messages.length, selectedRepo?.id, view]);

  useEffect(() => {
    if (!activeChat) {
      setShowChatScrollTop(false);
      setShowChatScrollBottom(false);
      document.documentElement.style.removeProperty("--composer-space");
      return;
    }

    const update = () => {
      updateComposerPlacement();
      updateChatBottomState();
    };
    const timers = [
      window.setTimeout(update, 80),
      window.setTimeout(update, 260)
    ];
    const raf = window.requestAnimationFrame(update);
    const observer = new ResizeObserver(() => update());
    const scroller = getChatScroller();
    [scroller, shellRef.current, chatThreadRef.current, composerRef.current]
      .filter((element, index, list): element is HTMLElement => Boolean(element) && list.indexOf(element) === index)
      .forEach((element) => observer.observe(element));
    window.addEventListener("resize", update);

    return () => {
      window.cancelAnimationFrame(raf);
      timers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeChat, activeChatId, chatIsLoading, timelineItems.length, messages.length, jobs.length, view]);

  useEffect(() => {
    const now = Date.now();
    if (rawLocalCodexBusy) {
      const detectedAt = localActivity?.busySinceAt || localActivity?.updatedAt || localActivity?.detectedAt || new Date(now).toISOString();
      setLocalBusyHold((current) => ({
        until: now + 7000,
        since: current.since ?? detectedAt
      }));
      return;
    }
    if ((localFinalMessageLikelySeen || staleCurrentWebJob || staleLocalWebBusy) && localBusyHold.since) {
      setLocalBusyHold({ until: 0 });
      return;
    }
    if (localBusyHold.until <= now && localBusyHold.since) setLocalBusyHold({ until: 0 });
  }, [
    rawLocalCodexBusy,
    localFinalMessageLikelySeen,
    staleCurrentWebJob,
    staleLocalWebBusy,
    localActivity?.busySinceAt,
    localActivity?.updatedAt,
    localActivity?.detectedAt,
    selectedAgent?.current_job_id,
    nowTick,
    localBusyHold.until,
    localBusyHold.since
  ]);

  useEffect(() => {
    if (!localCodexBusy && !activeRunBusy) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [localCodexBusy, activeRunBusy]);

  useEffect(() => {
    const messageIds = messages.map((message) => message.id);
    const nextIds = new Set(messageIds);
    const nextSignatures = new Map(messages.map((message) => [message.id, messageUpdateSignature(message)]));

    if (currentScrollChatRef.current !== activeChatId) {
      currentScrollChatRef.current = activeChatId;
      previousMessageIdsRef.current = nextIds;
      previousMessageSignaturesRef.current = nextSignatures;
      setHighlightedMessageIds(new Set());
      setShowJumpToLatest(false);
      window.requestAnimationFrame(() => scrollChatToLatest("auto"));
      return;
    }

    const newIds = messageIds.filter((id) => !previousMessageIdsRef.current.has(id));
    const updatedIds = messages
      .filter((message) => previousMessageIdsRef.current.has(message.id))
      .filter((message) => previousMessageSignaturesRef.current.get(message.id) !== nextSignatures.get(message.id))
      .map((message) => message.id);
    const changedIds = [...new Set([...newIds, ...updatedIds])];
    previousMessageIdsRef.current = nextIds;
    previousMessageSignaturesRef.current = nextSignatures;
    if (!changedIds.length) return;

    setHighlightedMessageIds((current) => new Set([...current, ...changedIds]));
    window.setTimeout(() => {
      setHighlightedMessageIds((current) => {
        const next = new Set(current);
        changedIds.forEach((id) => next.delete(id));
        return next;
      });
    }, 1400);

    const shouldStickToBottom = chatAtBottomRef.current;
    window.requestAnimationFrame(() => {
      if (shouldStickToBottom) {
        scrollChatToLatest("smooth");
        window.setTimeout(() => {
          if (chatAtBottomRef.current) scrollChatToLatest("smooth");
        }, 180);
      }
      else {
        setShowJumpToLatest(true);
        setShowChatScrollBottom(true);
      }
    });
  }, [activeChatId, messages]);

  useEffect(() => {
    if (!imagePreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImagePreview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imagePreview]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthNotice("");
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    setBusy(false);
    if (!response.ok) {
      setAuthNotice("Не получилось войти: проверь email и пароль.");
      return;
    }
    const data = await response.json();
    setCurrentUser(data.user);
    setCsrf(data.csrfToken);
    refresh();
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthNotice("");
    const response = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({ email, password, nickname: registerNickname.trim() })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAuthNotice(data.error === "user_exists" ? "Пользователь с таким email уже есть." : data.error === "nickname_taken" ? "Этот nickname уже занят." : "Регистрация не получилась.");
      return;
    }
    setCurrentUser(data.user);
    setCsrf(data.csrfToken);
    refresh();
  }

  async function saveProject(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !selectedAgent || !projectName.trim() || !projectPath.trim()) return;
    setBusy(true);
    const isNew = projectPanel === "new";
    const body: Record<string, unknown> = {
      agentId: selectedAgent.id,
      name: projectName.trim(),
      githubUrl: projectGithubUrl.trim(),
      serverPath: projectServerPath.trim(),
      domain: projectDomain.trim(),
      deploy: buildDeployConfig(projectDeploySshTarget, projectDeploySourceDir, projectDeployRemoteSubdir, projectDeployCleanRemote, projectDeployBuildCommand) ?? null,
      defaultSandbox: sandbox,
      allowedSandboxes: SANDBOXES
    };
    if (isNew || projectPath.trim() !== originalProjectPath) body.path = projectPath.trim();
    const response = await api(isNew ? "/api/projects" : `/api/projects/${selectedRepo?.agentId}/${selectedRepo?.id}`, {
      method: isNew ? "POST" : "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify(body)
    });
    setBusy(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setChatNotice(data.error === "agent_local_busy" ? "Локальный Codex сейчас занят в VS Code или другом локальном чате. Дождись завершения, потом можно запускать задачу из web." : data.error || "Job start failed.");
      return;
    }
    const data = await response.json();
    await refresh();
    setProjectPanel(null);
    if (isNew && data.repoId) {
      setRepoKey(`${selectedAgent.id}:${data.repoId}`);
      setSandbox("danger-full-access");
    }
  }

  async function deleteProject() {
    if (!csrf || !selectedRepo) return;
    const activeInProject = activeJob?.agentId === selectedRepo.agentId && activeJob.repoId === selectedRepo.id && ["queued", "assigned", "running"].includes(activeJob.status);
    if (activeInProject) {
      setProjectNotice("Stop the running job before removing this project from the service.");
      return;
    }
    setBusy(true);
    setProjectNotice("");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProjectNotice(data.error === "project_has_running_job" ? "Stop the running job before removing this project from the service." : data.error || "Project remove failed.");
      return;
    }
    clearProjectSelection();
    await refresh();
  }

  async function createChat(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedRepo || !csrf || !chatTitle.trim()) return;
    setBusy(true);
    const response = await api("/api/chats", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ agentId: selectedRepo.agentId, repoId: selectedRepo.id, title: chatTitle.trim() })
    });
    setBusy(false);
    if (!response.ok) return;
    const { chatId } = await response.json();
    setChatTitle("");
    setMobileMenuOpen(false);
    await loadChats(selectedRepo);
    await loadChat(chatId);
  }

  async function createJob(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedRepo || (!prompt.trim() && !attachments.length) || !csrf) return;
    if (localCodexBusy) {
      setChatNotice("Локальный Codex сейчас занят в VS Code или другом локальном чате. Дождись завершения, потом можно запускать задачу из web.");
      return;
    }
    let targetChatId = activeChatId;
    const promptText = prompt.trim() || "Посмотри вложенные файлы.";
    setBusy(true);
    if (!targetChatId) {
      const chatResponse = await api("/api/chats", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({
          agentId: selectedRepo.agentId,
          repoId: selectedRepo.id,
          title: promptText.slice(0, 120)
        })
      });
      if (!chatResponse.ok) {
        setBusy(false);
        return;
      }
      targetChatId = (await chatResponse.json()).chatId;
      setActiveChatId(targetChatId);
    }
    const response = await api("/api/jobs", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        agentId: selectedRepo.agentId,
        repoId: selectedRepo.id,
        chatId: targetChatId,
        prompt: promptText,
        sandbox,
        branchMode: "current",
        model: codexModel,
        reasoningEffort,
        speed: codexSpeed,
        attachments: attachments.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          dataBase64: attachment.dataBase64
        }))
      })
    });
    setBusy(false);
    if (!response.ok) return;
    const { jobId } = await response.json();
    setPrompt("");
    setAttachments([]);
    setAttachmentNotice("");
    await loadChat(targetChatId, jobId);
  }

  async function hideChat(chat: Chat) {
    if (!csrf || !selectedRepo) return;
    const activeInChat = activeJob?.chatId === chat.id && ["queued", "assigned", "running"].includes(activeJob.status);
    if (activeInChat) return;
    setBusy(true);
    setChatNotice("");
    const response = await api(`/api/chats/${chat.id}/hide`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setChatNotice(data.error === "chat_has_running_job" ? "Stop the running job before hiding this chat." : data.error || "Chat hide failed.");
      return;
    }
    setChatMenuId("");
    const nextChats = chats.filter((item) => item.id !== chat.id);
    setChats(nextChats);
    if (activeChatId === chat.id) {
      setActiveChatId("");
      setChatLoadingId("");
      setChatLoadingProgress(null);
      setJobs([]);
      setMessages([]);
      setActiveJob(null);
      setLogs([]);
      if (nextChats[0]) await loadChat(nextChats[0].id);
    }
    await loadChats(selectedRepo);
  }

  async function saveChatProperties(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !selectedRepo || !chatProperties) return;
    setBusy(true);
    setChatNotice("");
    const response = await api(`/api/chats/${chatProperties.id}`, {
      method: "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        title: chatSettingsTitle.trim(),
        linkedChatId: linkedChatId || undefined
      })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setChatNotice(data.error || "Chat properties save failed.");
      return;
    }
    setChatProperties(data.chat);
    await loadChats(selectedRepo);
    if (linkedChatId || activeChatId === data.chat.id) await loadChat(data.chat.id);
    setLinkedChatId("");
  }

  async function restoreHiddenChat(chat: Chat) {
    if (!csrf || !selectedRepo) return;
    setBusy(true);
    const response = await api(`/api/chats/${chat.id}/unhide`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    setBusy(false);
    if (!response.ok) return;
    await loadChats(selectedRepo);
    await loadHiddenLocalChats(selectedRepo);
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setAttachmentNotice("");
    const currentSize = attachments.reduce((sum, item) => sum + item.size, 0);
    const nextSize = list.reduce((sum, file) => sum + file.size, currentSize);
    if (attachments.length + list.length > 8) {
      setAttachmentNotice("Можно прикрепить до 8 файлов к одному сообщению.");
      return;
    }
    if (list.some((file) => file.size > 5 * 1024 * 1024) || nextSize > 12 * 1024 * 1024) {
      setAttachmentNotice("Файл до 5 MB, суммарно до 12 MB на сообщение.");
      return;
    }
    try {
      const parsed = await Promise.all(list.map(readFileAttachment));
      setAttachments((current) => [...current, ...parsed]);
    } catch {
      setAttachmentNotice("Не получилось прочитать один из файлов.");
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.size > 0);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  }

  async function cancelJob() {
    if (!activeJob || !csrf) return;
    await api(`/api/jobs/${activeJob.id}/cancel`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
  }

  async function runGitSync() {
    if (!selectedRepo || !csrf || !gitMessage.trim()) return;
    setGitBusy(true);
    setActionMenuOpen(false);
    setGitNotice("Git sync started...");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/git-sync`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        message: gitMessage.trim(),
        remoteUrl: gitRemoteUrl.trim() || selectedRepo.githubUrl || undefined
      })
    });
    const data = await response.json().catch(() => ({}));
    setGitBusy(false);
    if (!response.ok) {
      setGitNotice(data.output || data.error || "Git sync failed.");
      return;
    }
    setGitRemoteUrl("");
    setGitNotice(data.output || data.status || "Git sync completed.");
    await refresh();
  }

  async function syncGit(event: React.FormEvent) {
    event.preventDefault();
    await runGitSync();
  }

  async function deployProject() {
    if (!selectedRepo || !csrf) return;
    setDeployBusy(true);
    setDeployNotice("Deploy started...");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/deploy`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setDeployBusy(false);
    if (!response.ok) {
      setDeployNotice(data.output || data.error || "Deploy failed.");
      return;
    }
    setDeployNotice(data.output || "Deploy completed.");
    await refresh();
  }

  async function configureNginx() {
    if (!selectedRepo || !csrf) return;
    setNginxBusy(true);
    setNginxNotice("Nginx setup started...");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/nginx`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setNginxBusy(false);
    if (!response.ok) {
      setNginxNotice(data.output || data.error || "Nginx setup failed.");
      return;
    }
    setNginxNotice(data.output || "Nginx configured.");
    await refresh();
  }

  async function configureSsl() {
    if (!selectedRepo || !csrf) return;
    setSslBusy(true);
    setSslNotice("SSL setup started...");
    const response = await api(`/api/projects/${selectedRepo.agentId}/${selectedRepo.id}/ssl`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setSslBusy(false);
    if (!response.ok) {
      setSslNotice(data.output || data.error || "SSL setup failed.");
      return;
    }
    setSslNotice(data.output || "SSL configured.");
    await refresh();
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || currentUser?.role !== "admin" || !newUserEmail.trim() || !newUserPassword) return;
    setBusy(true);
    setSettingsNotice("");
    const response = await api("/api/users", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ email: newUserEmail.trim(), password: newUserPassword, role: newUserRole })
    });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSettingsNotice(data.error || "User create failed.");
      return;
    }
    setNewUserEmail("");
    setNewUserPassword("");
    setNewUserRole("user");
    setSettingsNotice("User created.");
    await loadUsers();
  }

  async function createAgent(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !newAgentName.trim()) return;
    setBusy(true);
    setSettingsNotice("");
    const response = await api("/api/agents", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        name: newAgentName.trim(),
        id: newAgentId.trim() || undefined,
        userId: currentUser?.role === "admin" ? newAgentUserId || undefined : undefined
      })
    });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSettingsNotice(data.error || "Agent create failed.");
      return;
    }
    setAgentSetup(data.setup);
    setNewAgentId("");
    setSettingsNotice("Agent created. Save the setup script now; the token is shown only once.");
    await refresh();
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf) return;
    setBusy(true);
    setProfileNotice("");
    const response = await api("/api/profile", {
      method: "PUT",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        nickname: profileNickname.trim(),
        bio: profileBio,
        avatarDataUrl: profileAvatarDataUrl
      })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProfileNotice(data.error === "nickname_taken" ? "Этот nickname уже занят." : data.error || "Profile update failed.");
      return;
    }
    setCurrentUser(data.user);
    setProfileStatsData(data.stats);
    setOauthProviders(data.oauth);
    setProfileNotice("Profile saved.");
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!csrf || !currentPassword || !newPassword) return;
    setBusy(true);
    setProfileNotice("");
    const response = await api("/api/profile/password", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setProfileNotice(data.error === "invalid_current_password" ? "Текущий пароль неверный." : data.error || "Password change failed.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setProfileNotice("Password changed.");
  }

  async function connectOAuth(provider: OAuthProvider["provider"]) {
    if (!csrf) return;
    const response = await api(`/api/profile/oauth/${provider}/start`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setProfileNotice(data.error === "oauth_provider_not_configured" ? "OAuth для этого провайдера пока не настроен на сервере." : data.error || "OAuth start failed.");
    }
  }

  async function startAuthOAuth(provider: OAuthProvider["provider"]) {
    setBusy(true);
    setAuthNotice("");
    const response = await api(`/api/oauth/${provider}/start`, {
      method: "POST",
      body: JSON.stringify({ returnTo: "/" })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setAuthNotice(data.error === "oauth_provider_not_configured" ? `${oauthLabel(provider)} OAuth ещё не настроен на сервере.` : data.error || "OAuth start failed.");
      return;
    }
    if (data.url) location.href = data.url;
  }

  function updateProfileAvatar(file?: File) {
    if (!file) return;
    if (!isPreviewableImage(file.type) || file.size > 1024 * 1024) {
      setProfileNotice("Аватарка: PNG/JPEG/WebP/GIF/AVIF/BMP до 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setProfileNotice("Не получилось прочитать аватарку.");
    reader.onload = () => {
      setProfileAvatarDataUrl(String(reader.result ?? ""));
      setProfileNotice("");
    };
    reader.readAsDataURL(file);
  }

  function oauthIcon(provider: OAuthProvider["provider"]) {
    if (provider === "github") return <Github size={17} />;
    if (provider === "mailru") return <Mail size={17} />;
    return <Link2 size={17} />;
  }

  function oauthLabel(provider: OAuthProvider["provider"]) {
    return provider === "mailru" ? "Mail.ru" : provider === "vk" ? "VK.com" : provider === "github" ? "GitHub" : "Google";
  }

  function renderProfile() {
    const stats = profileStatsData ?? { chats: 0, jobs: 0, completedJobs: 0, failedJobs: 0, projects: 0, generationSeconds: 0 };
    const displayName = currentUser?.nickname || currentUser?.email || "Profile";
    return (
      <section className="settings-work profile-work">
        <section className="profile-hero">
          <div className="profile-avatar">
            {profileAvatarDataUrl || currentUser?.avatarDataUrl ? <img alt="" src={profileAvatarDataUrl || currentUser?.avatarDataUrl || ""} /> : <UserCircle size={54} />}
          </div>
          <div>
            <h2>{displayName}</h2>
            <p>{currentUser?.email}</p>
            <small><CalendarDays size={14} /> Registered {currentUser?.createdAt ? new Date(currentUser.createdAt).toLocaleString() : "unknown"}</small>
          </div>
        </section>

        <section className="profile-grid">
          <div className="stat-card"><MessageSquare size={18} /><span>Chats</span><strong>{stats.chats}</strong></div>
          <div className="stat-card"><Activity size={18} /><span>Runs</span><strong>{stats.jobs}</strong></div>
          <div className="stat-card"><CheckCircle2 size={18} /><span>Completed</span><strong>{stats.completedJobs}</strong></div>
          <div className="stat-card"><FolderGit2 size={18} /><span>Projects</span><strong>{stats.projects}</strong></div>
          <div className="stat-card wide"><Clock3 size={18} /><span>Generation time</span><strong>{formatDuration(stats.generationSeconds)}</strong></div>
        </section>

        <form className="settings-card profile-card" onSubmit={saveProfile}>
          <h2><UserCircle size={18} /> Profile parameters</h2>
          <label>
            Unique nickname
            <input placeholder="rodion" value={profileNickname} onChange={(event) => setProfileNickname(event.target.value)} />
          </label>
          <label>
            Description
            <textarea placeholder="Коротко о себе и своём сетапе..." value={profileBio} onChange={(event) => setProfileBio(event.target.value)} />
          </label>
          <label className="avatar-upload">
            <Camera size={16} /> Update avatar
            <input accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" type="file" onChange={(event) => updateProfileAvatar(event.currentTarget.files?.[0])} />
          </label>
          <button disabled={busy} type="submit"><Save size={16} /> Save profile</button>
        </form>

        <form className="settings-card profile-card" onSubmit={changePassword}>
          <h2><KeyRound size={18} /> Password</h2>
          <input autoComplete="current-password" placeholder="current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          <input autoComplete="new-password" placeholder="new password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <button disabled={busy || !currentPassword || newPassword.length < 8} type="submit"><KeyRound size={16} /> Change password</button>
        </form>

        <section className="settings-card profile-card">
          <h2><Link2 size={18} /> OAuth connections</h2>
          <div className="oauth-list">
            {oauthProviders.map((provider) => (
              <div className="oauth-row" key={provider.provider}>
                <span>{oauthIcon(provider.provider)} {oauthLabel(provider.provider)}</span>
                <small>{provider.connected ? `Connected${provider.displayName ? ` as ${provider.displayName}` : ""}` : provider.configured ? "Ready to connect" : "Server config needed"}</small>
                <button disabled={busy} type="button" onClick={() => connectOAuth(provider.provider)}>
                  {provider.connected ? "Reconnect" : "Connect"}
                </button>
              </div>
            ))}
          </div>
          <p>Для реального OAuth нужно добавить client id/secret и callback URL на сервере; интерфейс уже показывает провайдеры и состояние подключения.</p>
        </section>

        {profileNotice && <div className="notice">{profileNotice}</div>}
      </section>
    );
  }

  function renderSettings() {
    return (
      <section className="settings-work">
        <section className="project-form wide">
          <div className="section-head">
            <h2><Settings size={18} /> Profile setup</h2>
          </div>
          <div className="notice">
            Пользователь запускает Windows-agent у себя на ПК, логинится в Codex локально через <code>codex login</code>, а сайт только отправляет задачи его агенту.
          </div>
          <form className="settings-card" onSubmit={createAgent}>
            <h2><Bot size={18} /> Create personal agent</h2>
            <label>
              Agent name
              <input value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} />
            </label>
            <label>
              Agent id, optional
              <input placeholder="my-windows-agent" value={newAgentId} onChange={(event) => setNewAgentId(event.target.value)} />
            </label>
            {currentUser?.role === "admin" && (
              <label>
                Owner
                <select value={newAgentUserId} onChange={(event) => setNewAgentUserId(event.target.value)}>
                  <option value="">Me</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
                </select>
              </label>
            )}
            <button disabled={busy || !newAgentName.trim()} type="submit"><Plus size={16} /> Create agent & setup</button>
          </form>
          {agentSetup && (
            <div className="settings-card">
              <h2>Windows setup</h2>
              <p>На ПК пользователя: установи Node.js LTS, Git, Codex CLI, выполни <code>codex login</code>, затем запусти этот PowerShell.</p>
              <textarea className="code-textarea" readOnly value={agentSetup.setupPowerShell} />
              <label>
                Agent config
                <textarea className="code-textarea small" readOnly value={agentSetup.configJson} />
              </label>
            </div>
          )}
          {currentUser?.role === "admin" && (
            <form className="settings-card" onSubmit={createUser}>
              <h2>Create user</h2>
              <input autoComplete="off" placeholder="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} />
              <input autoComplete="new-password" placeholder="temporary password" type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} />
              <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as "admin" | "user")}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <button disabled={busy || !newUserEmail.trim() || !newUserPassword} type="submit"><Plus size={16} /> Create user</button>
            </form>
          )}
          {settingsNotice && <div className="notice">{settingsNotice}</div>}
          {currentUser?.role === "admin" && (
            <div className="settings-card">
              <h2>Users</h2>
              {users.map((user) => (
                <div className="settings-row" key={user.id}>
                  <span>{user.email}</span>
                  <strong>{user.role}</strong>
                </div>
              ))}
              {!users.length && <span className="small-empty">No users loaded.</span>}
            </div>
          )}
          <div className="settings-card">
            <h2>Agents</h2>
            {agents.map((agent) => (
              <div className="settings-row" key={agent.id}>
                <span>{agent.name}</span>
                <strong>{agent.status}</strong>
              </div>
            ))}
            {!agents.length && <span className="small-empty">No agents yet.</span>}
          </div>
        </section>
      </section>
    );
  }

  async function logout() {
    if (csrf) await api("/api/logout", { method: "POST", headers: { "x-csrf-token": csrf }, body: "{}" });
    setCsrf(undefined);
    setCurrentUser(null);
  }

  function expandChangeCard(actionKey: string, message: ChatMessage, job?: Job) {
    const willExpand = expandedActions[actionKey] === false;
    setExpandedActions((current) => ({ ...current, [actionKey]: current[actionKey] === false }));
    if (!willExpand) return;
    if (job?.id && (job.gitDiffOmitted || (job.gitDiffStat && !job.gitDiff))) {
      loadJobDetails(job.id).catch(() => undefined);
    }
    if (message.metadata?.metadataOmitted || message.metadata?.gitDiffOmitted) {
      loadMessageDetails(message.id).catch(() => undefined);
    }
  }

  function expandCodexActions(actionKey: string, message: ChatMessage) {
    const willExpand = !expandedActions[actionKey];
    setExpandedActions((current) => ({ ...current, [actionKey]: !current[actionKey] }));
    if (willExpand && message.metadata?.metadataOmitted) {
      loadMessageDetails(message.id).catch(() => undefined);
    }
  }

  function toggleFileDiff(diffKey: string, message: ChatMessage, job?: Job, fileDiff?: FileDiff) {
    const willExpand = !expandedActions[diffKey];
    setExpandedActions((current) => ({ ...current, [diffKey]: !current[diffKey] }));
    if (!willExpand || fileDiff) {
      return;
    }
    if (job?.id && (job.gitDiffOmitted || (job.gitDiffStat && !job.gitDiff))) {
      loadJobDetails(job.id).catch(() => undefined);
    }
    if (message.metadata?.metadataOmitted || message.metadata?.gitDiffOmitted) {
      loadMessageDetails(message.id).catch(() => undefined);
    }
  }

  function renderCodexChangeCard(message: ChatMessage, job?: Job, progress?: JobProgress | null) {
    const stat = job?.gitDiffStat || (typeof message.metadata?.gitDiffStat === "string" ? message.metadata.gitDiffStat : "");
    const diff = job?.gitDiff || (typeof message.metadata?.gitDiff === "string" ? message.metadata.gitDiff : "");
    if (message.role !== "assistant" || (!stat && !progress?.files?.length)) return null;
    const fileDiffs = parseUnifiedDiff(diff);
    const exactRows = diffRowsFromFileDiffs(fileDiffs);
    const rows = exactRows.length ? exactRows : diffRows(stat || null, progress?.files);
    const summary = exactRows.length ? diffSummaryFromRows(exactRows) : diffSummary(stat || null, progress);
    const actionKey = `changes:${message.id}`;
    const fileListVisible = expandedActions[actionKey] !== false;
    const durationSeconds = job?.finishedAt ? jobDurationSeconds(job) : messageDurationSeconds(message);
    return (
      <div className="codex-change-card">
        <div className="codex-change-head">
          <div className="codex-change-title">
            <span className="change-icon"><Wrench size={16} /></span>
            <div>
              <strong>Edited {summary.files} {summary.files === 1 ? "file" : "files"}</strong>
              <small>
                {durationSeconds > 0 && <span className="duration">Worked for {formatDuration(durationSeconds)}</span>}
                <span className="added">+{summary.added}</span>
                <span className="deleted">-{summary.deleted}</span>
              </small>
            </div>
          </div>
          <button type="button" onClick={() => expandChangeCard(actionKey, message, job)}>
            {fileListVisible ? "Hide" : "Details"}
          </button>
        </div>
        {fileListVisible && rows.length ? (
          <div className="codex-change-files">
            {rows.map((row) => {
              const fileDiff = findFileDiffInList(fileDiffs, row.file);
              const diffKey = `filediff:${message.id}:${row.file}`;
              const fileExpanded = Boolean(expandedActions[diffKey]);
              return (
                <div className="codex-change-file" key={row.file}>
                  <button
                    className="codex-change-file-row"
                    type="button"
                    onClick={() => toggleFileDiff(diffKey, message, job, fileDiff)}
                  >
                    <span>{row.file}</span>
                    <small className="diff-meta">
                      {renderDiffRowMeta(row)}
                      <ChevronDown className={fileExpanded ? "open" : ""} size={15} />
                    </small>
                  </button>
                  {fileExpanded && (fileDiff ? renderFileDiff(fileDiff) : <div className="codex-change-loading">Loading diff...</div>)}
                </div>
              );
            })}
          </div>
        ) : fileListVisible ? (
          <div className="codex-change-empty">
            {summary.files > 0 ? "File list is loading or not available yet." : "No files changed."}
          </div>
        ) : null}
      </div>
    );
  }

  function renderFileDiff(fileDiff: FileDiff) {
    return (
      <div className="file-diff-panel">
        {fileDiff.lines.map((line, index) => (
          <div className={`file-diff-line ${line.type}`} key={`${line.oldLine ?? ""}:${line.newLine ?? ""}:${index}`}>
            <span className="line-number">{line.oldLine ?? ""}</span>
            <span className="line-number">{line.newLine ?? ""}</span>
            <code>{line.text || " "}</code>
          </div>
        ))}
      </div>
    );
  }

  function renderCodexActions(message: ChatMessage, job?: Job) {
    const jobId = messageJobId(message);
    const webActions = job && job.id === activeJob?.id && jobId === activeJob.id ? codexActionEntries(logs) : [];
    const actions = webActions.length ? webActions : metadataCodexActions(message);
    if (!actions.length) return null;
    const actionKey = `actions:${message.id}`;
    const expanded = Boolean(expandedActions[actionKey]);
    return (
      <div className="message-actions run-actions">
        <button type="button" onClick={() => expandCodexActions(actionKey, message)}>
          <Terminal size={15} />
          <span>Ran {actions.length} commands</span>
          <ChevronDown className={expanded ? "open" : ""} size={15} />
        </button>
        {expanded && (
          <div className="message-action-details command-details">
            {actions.map((action) => {
              const parsed = parseCommandOutput(action.output);
              return (
                <details key={action.id}>
                  <summary>
                    <span>{action.command}</span>
                    <small>{action.status}</small>
                  </summary>
                  <div className="command-meta">
                    {parsed.exitCode && <span>Exit {parsed.exitCode}</span>}
                    {parsed.wallTime && <span>{parsed.wallTime}</span>}
                  </div>
                  {parsed.body ? <pre>{parsed.body}</pre> : <small>No output.</small>}
                </details>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderCollapsedRunTrace(finalMessage: ChatMessage, summary: CollapsedRunSummary) {
    const actionKey = `runtrace:${finalMessage.id}`;
    const expanded = Boolean(expandedActions[actionKey]);
    const updateCount = summary.messages.length;
    const traceLabel = `${updateCount} шагов${summary.commandCount ? ` · ${summary.commandCount} команд` : ""}`;
    return (
      <div className="run-trace">
        <button
          type="button"
          onClick={() => setExpandedActions((current) => ({ ...current, [actionKey]: !current[actionKey] }))}
        >
          <Clock3 size={15} />
          <span>{traceLabel}</span>
          <ChevronDown className={expanded ? "open" : ""} size={15} />
        </button>
        {expanded && (
          <div className="run-trace-details">
            {summary.messages.map((message, index) => {
              const jobId = messageJobId(message);
              const messageJob = jobId ? jobs.find((job) => job.id === jobId) ?? summary.job : summary.job;
              const messageProgress = messageJob ? progressByJob[messageJob.id] ?? messageJob.progress ?? null : null;
              return (
                <article className="run-trace-step" key={message.id}>
                  <div className="message-meta">
                    <span>Шаг {index + 1}</span>
                    <small>{new Date(message.createdAt).toLocaleString()}</small>
                  </div>
                  {renderRichText(message.content, "rich-text message-body")}
                  {renderMessageAttachments(message.attachments, setImagePreview)}
                  {renderCodexActions(message, messageJob)}
                  {renderCodexChangeCard(message, messageJob, messageProgress)}
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderComposer() {
    if (!selectedRepo) return null;
    const canSubmit = Boolean(prompt.trim() || attachments.length);
    const runDisabled = busy || !canSubmit || localCodexBusy || activeRunBusy;
    const selectedModelLabel = CODEX_MODEL_OPTIONS.find((option) => option.value === codexModel)?.label ?? codexModel;
    const selectedReasoningLabel = REASONING_OPTIONS.find((option) => option.value === reasoningEffort)?.label ?? reasoningEffort;
    const selectedSpeedLabel = SPEED_OPTIONS.find((option) => option.value === codexSpeed)?.label ?? codexSpeed;
    const showCodexBusy = localCodexBusy || activeRunBusy;
    return (
      <form className="composer" ref={composerRef} onSubmit={createJob}>
        {attachments.length > 0 && (
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id}>
                {attachment.previewUrl ? <img alt="" className="attachment-thumb" src={attachment.previewUrl} /> : <Paperclip size={16} />}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{attachment.mimeType} · {formatBytes(attachment.size)}</small>
                </span>
                <button aria-label={`Remove ${attachment.name}`} className="attachment-remove" type="button" onClick={() => removeAttachment(attachment.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentNotice && <div className="notice danger">{attachmentNotice}</div>}
        <textarea
          placeholder="Опишите задачу, что вы хотите сделать сегодня?"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onPaste={handleComposerPaste}
        />
        <div className="sticky-submit">
          <input
            className="file-input"
            id="composer-attachment-input"
            multiple
            type="file"
            onChange={(event) => {
              if (event.currentTarget.files) addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <button className="run-button" disabled={runDisabled} type="submit">
            {showCodexBusy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
            {showCodexBusy ? `Codex занят ${formatDuration(thinkingSeconds)}` : "Отправить"}
          </button>
          <label className="attachment-picker" htmlFor="composer-attachment-input" title="Attach files">
            <Paperclip size={18} />
          </label>
          <div className="sandbox-control">
            <button
              aria-expanded={sandboxMenuOpen}
              aria-label={`Sandbox mode: ${SANDBOX_LABELS[sandbox]}`}
              className="sandbox-trigger"
              title={`Sandbox mode: ${SANDBOX_LABELS[sandbox]}`}
              type="button"
              onClick={() => setSandboxMenuOpen((value) => !value)}
            >
              <ShieldCheck size={18} />
            </button>
            {sandboxMenuOpen && (
              <div className="sandbox-menu" role="menu">
                {selectedRepo.allowedSandboxes.map((item) => (
                  <button
                    className={sandbox === item ? "selected" : ""}
                    key={item}
                    role="menuitemcheckbox"
                    aria-checked={sandbox === item}
                    type="button"
                    onClick={() => {
                      setSandbox(item);
                      setSandboxMenuOpen(false);
                    }}
                  >
                    <span>{SANDBOX_LABELS[item]}</span>
                    {sandbox === item && <Check size={16} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="action-control">
            <button
              aria-expanded={actionMenuOpen}
              aria-label="Message actions"
              className="action-trigger"
              title="Actions"
              type="button"
              onClick={() => setActionMenuOpen((value) => !value)}
            >
              <MoreHorizontal size={18} />
            </button>
            {actionMenuOpen && (
              <div className="action-menu" role="menu">
                <button disabled={gitBusy || !gitMessage.trim()} role="menuitem" type="button" onClick={runGitSync}>
                  <UploadCloud size={16} />
                  <span>Commit & push</span>
                </button>
                <div className="menu-divider" />
                <div className="menu-section">
                  <span className="menu-section-title">Intelligence</span>
                  {REASONING_OPTIONS.map((option) => (
                    <button
                      className={reasoningEffort === option.value ? "selected" : ""}
                      key={option.value}
                      role="menuitemcheckbox"
                      aria-checked={reasoningEffort === option.value}
                      type="button"
                      onClick={() => setReasoningEffort(option.value)}
                    >
                      <span>{option.label}</span>
                      {reasoningEffort === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="menu-section">
                  <span className="menu-section-title">Model</span>
                  {CODEX_MODEL_OPTIONS.map((option) => (
                    <button
                      className={codexModel === option.value ? "selected" : ""}
                      key={option.value}
                      role="menuitemcheckbox"
                      aria-checked={codexModel === option.value}
                      type="button"
                      onClick={() => setCodexModel(option.value)}
                    >
                      <span>{option.label}</span>
                      {codexModel === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="menu-section">
                  <span className="menu-section-title">Speed</span>
                  {SPEED_OPTIONS.map((option) => (
                    <button
                      className={`speed-option ${codexSpeed === option.value ? "selected" : ""}`}
                      key={option.value}
                      role="menuitemcheckbox"
                      aria-checked={codexSpeed === option.value}
                      type="button"
                      onClick={() => setCodexSpeed(option.value)}
                    >
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.note}</small>
                      </span>
                      {codexSpeed === option.value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="menu-summary">
                  {selectedModelLabel} · {selectedReasoningLabel} · {selectedSpeedLabel}
                </div>
              </div>
            )}
          </div>
          {activeJob && ["queued", "assigned", "running"].includes(activeJob.status) && (
            <button className="stop" type="button" onClick={cancelJob}><Square size={18} /> Stop</button>
          )}
        </div>
      </form>
    );
  }

  if (!csrf) {
    return (
      <main className="login">
        <section className="login-panel">
          <img className="brand-logo large" src="/favicon.svg" alt="" />
          <h1>Codex Control</h1>
          <p>Домашний Codex, управляемый с iPhone.</p>
          <div className="auth-tabs">
            <button className={authMode === "login" ? "active" : ""} type="button" onClick={() => setAuthMode("login")}>Вход</button>
            <button className={authMode === "register" ? "active" : ""} type="button" onClick={() => setAuthMode("register")}>Регистрация</button>
          </div>
          <form onSubmit={authMode === "login" ? login : register}>
            <input autoComplete="email" placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            {authMode === "register" && (
              <input autoComplete="nickname" placeholder="nickname, optional" value={registerNickname} onChange={(event) => setRegisterNickname(event.target.value)} />
            )}
            <input autoComplete={authMode === "login" ? "current-password" : "new-password"} placeholder="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button disabled={busy || !email.trim() || !password || (authMode === "register" && password.length < 8)} type="submit"><Play size={18} /> {authMode === "login" ? "Войти" : "Создать аккаунт"}</button>
          </form>
          <div className="oauth-login">
            <span>Войти или зарегистрироваться через</span>
            <div>
              {(authOauthProviders.length ? authOauthProviders : ["google", "github", "vk", "mailru"].map((provider) => ({ provider, connected: false, configured: false } as OAuthProvider))).map((provider) => (
                <button key={provider.provider} type="button" disabled={busy} onClick={() => startAuthOAuth(provider.provider)} title={provider.configured ? oauthLabel(provider.provider) : `${oauthLabel(provider.provider)} не настроен`}>
                  {oauthIcon(provider.provider)}
                  <span>{oauthLabel(provider.provider)}</span>
                </button>
              ))}
            </div>
          </div>
          {authNotice && <div className="notice danger">{authNotice}</div>}
        </section>
      </main>
    );
  }

  return (
    <>
    <main className={`app-frame ${sidebarCollapsed ? "nav-collapsed" : ""}`}>
      <aside className={`app-nav ${mobileMenuOpen ? "open" : ""}`}>
        <div className="nav-brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <strong>codex.rodion.pro</strong>
          <button className="icon mobile-nav-close" type="button" onClick={() => setMobileMenuOpen(false)} title="Закрыть меню">
            <X size={18} />
          </button>
        </div>
        <nav>
          <div className="nav-group">
            <button className={view === "projects" ? "nav-item active" : "nav-item"} onClick={clearProjectSelection}><FolderGit2 size={17} /> Projects</button>
            <div className="nav-subtree">
              {repos.map((repo) => {
                const selected = selectedRepo?.agentId === repo.agentId && selectedRepo.id === repo.id;
                const currentRepoKey = `${repo.agentId}:${repo.id}`;
                const busyProjectCount = busyCountByRepo.get(currentRepoKey) ?? 0;
                return (
                  <div className="nav-project" key={currentRepoKey}>
                    <button className={selected ? "nav-leaf project active" : "nav-leaf project"} onClick={() => selectProject(repo)}>
                      <span className="nav-project-title">
                        {busyProjectCount > 0 && (
                          <span className="busy-indicator" aria-label={`${busyProjectCount} working chats`}>
                            <RefreshCw className="spin" size={13} />
                            {busyProjectCount > 1 && <small>{busyProjectCount}</small>}
                          </span>
                        )}
                        <span>{repo.name}</span>
                      </span>
                      <small>{repo.currentBranch || "no branch"} · {repo.dirty ? "dirty" : "clean"}</small>
                    </button>
                    {selected && (
                      <div className="nav-project-chats">
                        <form className="nav-new-chat" onSubmit={createChat}>
                          <input placeholder="New chat title" value={chatTitle} onChange={(event) => setChatTitle(event.target.value)} />
                          <button disabled={busy || !chatTitle.trim()}><Plus size={14} /></button>
                        </form>
                        {chats.map((chat) => (
                          <div className={activeChatId === chat.id ? "nav-chat-row active" : "nav-chat-row"} key={chat.id}>
                            {(() => {
                              const chatIsBusy = activeBusyChatIds.has(chat.id)
                                || (localBusyRepoKey === currentRepoKey && localBusyChatTitle === chat.title)
                                || (localBusyRepoKey === currentRepoKey && localBusyFallbackChatId === chat.id);
                              return (
                            <button className="nav-leaf chat-child" onClick={() => {
                              setMobileMenuOpen(false);
                              loadChat(chat.id, undefined, true).catch(() => undefined);
                            }}>
                              <span className="nav-chat-title">
                                {chatIsBusy && <RefreshCw className="spin" size={13} />}
                                <span>{chat.title}</span>
                              </span>
                              <small>{new Date(chat.updatedAt).toLocaleString()}</small>
                            </button>
                              );
                            })()}
                            <button className="nav-menu-trigger" disabled={busy} onClick={() => setChatMenuId((value) => value === chat.id ? "" : chat.id)} title="Chat menu">
                              <MoreHorizontal size={15} />
                            </button>
                            {chatMenuId === chat.id && (
                              <div className="nav-chat-menu">
                                <button type="button" onClick={() => openChatProperties(chat)}>Свойства</button>
                                <button
                                  type="button"
                                  disabled={activeJob?.chatId === chat.id && ["queued", "assigned", "running"].includes(activeJob.status)}
                                  onClick={() => hideChat(chat)}
                                >
                                  Скрыть
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                        {!chats.length && <span className="nav-empty inset">No chats</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <button className="nav-item"><Activity size={17} /> Runs</button>
          <button className={view === "profile" ? "nav-item active" : "nav-item"} onClick={openProfileView}><UserCircle size={17} /> Profile</button>
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={openSettingsView}><Settings size={17} /> Settings</button>
        </nav>
        <div className="nav-agent">
          <span>{online ? "Online" : "Offline"}</span>
          <strong>{selectedAgent?.name ?? "Home Windows Agent"}</strong>
          <small>{selectedAgent?.hostname ?? "Waiting for heartbeat"}</small>
        </div>
      </aside>
      {mobileMenuOpen && <button className="mobile-menu-backdrop" aria-label="Закрыть меню" type="button" onClick={() => setMobileMenuOpen(false)} />}

      <section className="shell" ref={shellRef} onScroll={updateChatBottomState}>
      <header className="topbar">
        <div className="top-nav-controls">
          <button
            className="icon sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed((value) => !value)}
            title={sidebarCollapsed ? "Показать боковую панель" : "Скрыть боковую панель"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
          </button>
          <button className="icon mobile-menu-toggle" type="button" onClick={() => setMobileMenuOpen(true)} title="Меню">
            <Menu size={19} />
          </button>
        </div>
        <div className="top-title">
          <span className={`status ${online ? "ok" : "bad"}`}>{online ? <Wifi size={16} /> : <WifiOff size={16} />} {online ? "Home PC online" : "Home PC offline"}</span>
          <h1>{view === "settings" ? "Settings" : view === "profile" ? "Profile" : selectedRepo ? selectedRepo.name : "Projects"}</h1>
        </div>
        <div className="top-actions">
          {selectedRepo && <button className="icon" onClick={clearProjectSelection} title="Проекты"><ArrowLeft size={18} /></button>}
          <button className="icon" onClick={refresh} title="Обновить"><RefreshCw size={18} /></button>
          <button className="icon" onClick={logout} title="Выйти"><LogOut size={18} /></button>
        </div>
      </header>

      <section className="machine-strip">
        {agents.map((agent) => (
          <article className="machine" key={agent.id}>
            <strong>{agent.name}</strong>
            <span>{agent.hostname || agent.id}</span>
            <small>{agent.codex_version || "codex not probed"} · {agent.git_version || "git not probed"}</small>
          </article>
        ))}
      </section>

      {view === "settings" && renderSettings()}
      {view === "profile" && renderProfile()}

      {view === "projects" && !selectedRepo && (
        <section className="project-picker">
          <div className="section-head">
            <h2><FolderGit2 size={18} /> Projects</h2>
            <button className="secondary" onClick={openNewProject}><Plus size={16} /> Add project</button>
          </div>
          <div className="project-grid">
            {repos.map((repo) => (
              <article className="project-card" key={`${repo.agentId}:${repo.id}`}>
                <button className="project-main" onClick={() => selectProject(repo)}>
                  <strong>{repo.name}</strong>
                  <span><GitBranch size={14} /> {repo.currentBranch || "no branch"} · {repo.dirty ? "dirty" : "clean"}</span>
                  <small>{repo.pathMasked}</small>
                  {repo.domain && <small>{repo.domain}</small>}
                </button>
                <button className="icon tiny" onClick={() => {
                  setRepoKey(`${repo.agentId}:${repo.id}`);
                  openProjectSettings(repo);
                }} title="Настройки проекта"><Settings size={16} /></button>
              </article>
            ))}
          </div>
        </section>
      )}

      {view === "projects" && projectPanel && (
        <form className="project-form" onSubmit={saveProject}>
          <div className="section-head">
            <h2>{projectPanel === "new" ? "New project" : "Project settings"}</h2>
            <button className="secondary" type="button" onClick={() => setProjectPanel(null)}>Close</button>
          </div>
          <label>
            Name
            <input value={projectName} onChange={(event) => {
              setProjectName(event.target.value);
              if (projectPanel === "new") setProjectPath(defaultProjectPath(event.target.value));
            }} />
          </label>
          <label>
            Folder on home PC
            <input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} />
          </label>
          <label>
            GitHub repository
            <input placeholder="https://github.com/WizardJIOCb/project.git" value={projectGithubUrl} onChange={(event) => setProjectGithubUrl(event.target.value)} />
          </label>
          <label>
            Server project folder
            <input placeholder="/var/www/project.domain" value={projectServerPath} onChange={(event) => setProjectServerPath(event.target.value)} />
          </label>
          <label>
            Domain
            <input placeholder="project.domain" value={projectDomain} onChange={(event) => setProjectDomain(event.target.value)} />
          </label>
          <label>
            Deploy SSH target
            <input placeholder="myserver" value={projectDeploySshTarget} onChange={(event) => setProjectDeploySshTarget(event.target.value)} />
          </label>
          <label>
            Deploy source folder
            <input placeholder="dist" value={projectDeploySourceDir} onChange={(event) => setProjectDeploySourceDir(event.target.value)} />
          </label>
          <label>
            Deploy target subfolder
            <input placeholder="dist, optional" value={projectDeployRemoteSubdir} onChange={(event) => setProjectDeployRemoteSubdir(event.target.value)} />
          </label>
          <label>
            Build command
            <input placeholder="npm.cmd run build" value={projectDeployBuildCommand} onChange={(event) => setProjectDeployBuildCommand(event.target.value)} />
          </label>
          <label className="checkbox-row">
            <input checked={projectDeployCleanRemote} type="checkbox" onChange={(event) => setProjectDeployCleanRemote(event.target.checked)} />
            Clean server folder before upload
          </label>
          <div className="segments">
            {SANDBOXES.map((item) => (
              <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{SANDBOX_LABELS[item]}</button>
            ))}
          </div>
          {projectNotice && <div className="notice danger">{projectNotice}</div>}
          <button disabled={busy || !online} type="submit"><Save size={16} /> Save project</button>
          {projectPanel === "settings" && (
            <button className="danger-button" disabled={busy || !selectedRepo} type="button" onClick={deleteProject}>Remove project from service</button>
          )}
        </form>
      )}

      {view === "projects" && selectedRepo && (
        <section className="project-workspace">
          {chatProperties && (
            <form className="project-form chat-properties" onSubmit={saveChatProperties}>
              <div className="section-head">
                <h2><MessageSquare size={18} /> Свойства чата</h2>
                <button className="secondary" type="button" onClick={() => setChatProperties(null)}>Close</button>
              </div>
              <label>
                Название
                <input value={chatSettingsTitle} onChange={(event) => setChatSettingsTitle(event.target.value)} />
              </label>
              <div className="settings-row">
                <span>Источник</span>
                <strong>{chatProperties.source || "web"}</strong>
              </div>
              {chatProperties.externalId && (
                <div className="settings-row">
                  <span>Local chat id</span>
                  <strong>{chatProperties.externalId}</strong>
                </div>
              )}
              <label>
                Подключить локальный Codex/VS Code чат
                <select value={linkedChatId} onChange={(event) => setLinkedChatId(event.target.value)}>
                  <option value="">Не менять связь</option>
                  {hiddenLocalChats.map((chat) => (
                    <option key={chat.id} value={chat.id}>{chat.source}: {chat.title}</option>
                  ))}
                </select>
              </label>
              <p>Скрытые локальные чаты можно вернуть или подключить к текущему веб-чату. История при скрытии не удаляется.</p>
              <div className="hidden-chat-list">
                {hiddenLocalChats.map((chat) => (
                  <div className="settings-row" key={chat.id}>
                    <span>{chat.source}: {chat.title}</span>
                    <button className="secondary" type="button" onClick={() => restoreHiddenChat(chat)}>Вернуть</button>
                  </div>
                ))}
                {!hiddenLocalChats.length && <span className="small-empty">Нет скрытых локальных чатов для этого проекта.</span>}
              </div>
              {chatNotice && <div className="notice danger">{chatNotice}</div>}
              <button disabled={busy || !chatSettingsTitle.trim()} type="submit"><Save size={16} /> Save chat</button>
            </form>
          )}

          <section className="chat-work">
            <div className="section-head">
              <h2><MessageSquare size={18} /> {activeChat?.title ?? "Project chat"}</h2>
              <button className="icon tiny" onClick={() => openProjectSettings(selectedRepo)} title="Настройки"><Settings size={16} /></button>
            </div>
            <div className="repo-meta">
              <GitBranch size={16} /> {selectedRepo.currentBranch || "no branch"} · {selectedRepo.dirty ? "dirty" : "clean"} · {selectedRepo.pathMasked}
              {selectedRepo.domain && <> · {selectedRepo.domain}</>}
              {selectedRepo.serverPath && <> · {selectedRepo.serverPath}</>}
            </div>
            <form className="git-panel" onSubmit={syncGit}>
              <input aria-label="Commit message" value={gitMessage} onChange={(event) => setGitMessage(event.target.value)} />
              <input aria-label="Remote URL" placeholder="origin URL, optional" value={gitRemoteUrl} onChange={(event) => setGitRemoteUrl(event.target.value)} />
              <button disabled={gitBusy || !gitMessage.trim()} type="submit"><UploadCloud size={16} /> Commit & push</button>
              <button disabled={deployBusy || !selectedRepo.serverPath || !selectedRepo.deploy?.sshTarget} type="button" onClick={deployProject}><UploadCloud size={16} /> Deploy</button>
              <button disabled={nginxBusy || !selectedRepo.serverPath || !selectedRepo.domain || !selectedRepo.deploy?.sshTarget} type="button" onClick={configureNginx}><Settings size={16} /> Nginx</button>
              <button disabled={sslBusy || !selectedRepo.serverPath || !selectedRepo.domain || !selectedRepo.deploy?.sshTarget} type="button" onClick={configureSsl}><Settings size={16} /> SSL</button>
              {gitNotice && <pre>{gitNotice}</pre>}
              {deployNotice && <pre>{deployNotice}</pre>}
              {nginxNotice && <pre>{nginxNotice}</pre>}
              {sslNotice && <pre>{sslNotice}</pre>}
            </form>
            {activeChat ? (
              <>
                {chatNotice && <div className="notice danger">{chatNotice}</div>}
                <section className="workspace">
                  <section className="job-detail">
                    <section className="chat-thread" ref={chatThreadRef}>
                      {chatIsLoading ? (
                        <div className="chat-loading">
                          <span className="chat-loading-orbit" aria-hidden="true">
                            <RefreshCw className="spin" size={22} />
                          </span>
                          <strong>Загружаю чат</strong>
                          <small>{chatLoadingLabel}</small>
                          <div className={`chat-loading-progress ${chatLoadingDeterminate ? "" : "indeterminate"}`} aria-label="Прогресс загрузки чата">
                            <span style={chatLoadingDeterminate ? { width: `${chatLoadingPercent}%` } : undefined} />
                          </div>
                          <small>
                            {chatLoadingProgress?.loadedBytes
                              ? chatLoadingProgress.totalBytes
                                ? `${formatBytes(chatLoadingProgress.loadedBytes)} из ${formatBytes(chatLoadingProgress.totalBytes)} · ${chatLoadingPercent}%`
                                : `Получено ${formatBytes(chatLoadingProgress.loadedBytes)}`
                              : "Ожидаю ответ сервера"}
                          </small>
                        </div>
                      ) : timelineItems.length ? timelineItems.map((item, index) => {
                        const { message, collapsedRun } = item;
                        const jobId = messageJobId(message);
                        const messageJob = jobs.find((job) => job.id === jobId);
                        const messageProgress = messageJob ? progressByJob[messageJob.id] ?? messageJob.progress ?? null : null;
                        const isNew = highlightedMessageIds.has(message.id);
                        const isFirst = index === 0;
                        const isLast = index === timelineItems.length - 1;
                        const author = message.role === "user" ? currentUser?.nickname || currentUser?.email || "You" : message.source === "vscode" ? "VS Code" : "Codex";
                        const assistantDetails = message.role === "assistant" || message.role === "tool" || message.role === "system"
                          ? messageRunDetails(message, messageJob, collapsedRun)
                          : undefined;
                        return (
                          <article
                            className={`message ${message.role}${isNew ? " new-message" : ""}`}
                            key={message.id}
                            ref={isFirst || isLast ? (node) => {
                              if (isFirst) firstMessageRef.current = node;
                              if (isLast) lastMessageRef.current = node;
                            } : undefined}
                          >
                            <div className="message-meta">
                              {assistantDetails ? (
                                <div className="message-author-stack">
                                  <span>
                                    {author}
                                    {assistantDetails.settings.length > 0 && <small className="message-run-settings">{assistantDetails.settings.join(" · ")}</small>}
                                  </span>
                                  {assistantDetails.timing.length > 0 && <small>{assistantDetails.timing.join(" · ")}</small>}
                                </div>
                              ) : message.role === "user" ? (
                                <div className="message-author-stack">
                                  <span>{author}</span>
                                  <small>{new Date(message.createdAt).toLocaleString()}</small>
                                </div>
                              ) : (
                                <>
                                  <span>{author}</span>
                                  <small>
                                    {new Date(message.createdAt).toLocaleString()}
                                    {collapsedRun && <> · Работал {formatDuration(collapsedRun.durationSeconds)}</>}
                                  </small>
                                </>
                              )}
                            </div>
                            {collapsedRun && renderCollapsedRunTrace(message, collapsedRun)}
                            {renderRichText(message.content, "rich-text message-body")}
                            {renderMessageAttachments(message.attachments, setImagePreview)}
                            {jobId === activeJob?.id && activeRunBusy && (
                              <div className="message-thinking">
                                <RefreshCw className="spin" size={14} />
                                <span>Codex думает {formatDuration(thinkingSeconds)}</span>
                              </div>
                            )}
                            {renderCodexActions(message, messageJob)}
                            {renderCodexChangeCard(message, messageJob, messageProgress)}
                          </article>
                        );
                      }) : (
                        <div className="empty">Начни этот чат или дождись синхронизации истории из локального Codex/VS Code.</div>
                      )}
                    </section>
                    {renderComposer()}
                    {activeJob && activeRunBusy ? (
                      <>
                        <div className="job-head">
                          <span className={`pill ${activeJob.status}`}><CheckCircle2 size={15} /> {activeJob.status}</span>
                          <strong>{activeJob.prompt}</strong>
                        </div>
                        {activeProgress && (
                          <div className="progress-wrap">
                            <div className="progress-panel">
                              <div>
                                <span className="progress-label">{activeProgress.phase}</span>
                                <strong>{activeProgress.message}</strong>
                              </div>
                              <div className="progress-stats">
                                <span>{activeProgress.filesChanged ?? 0} files</span>
                                <span>+{activeProgress.added ?? 0}</span>
                                <span>-{activeProgress.deleted ?? 0}</span>
                              </div>
                            </div>
                            {activeProgress.files?.length ? (
                              <div className="progress-files">
                                {(activeProgress.files ?? []).slice(0, 8).map((file) => (
                                  <div key={file.path}>
                                    <span>{file.path}</span>
                                    <small className="diff-meta">
                                      <span className="diff-added">+{file.added}</span>
                                      <span className="diff-deleted">-{file.deleted}</span>
                                    </small>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        )}
                        {firstActiveProgressFile && activeRunBusy ? (
                          <div className="message-actions current-edit">
                            <button type="button" onClick={() => setExpandedActions((current) => ({ ...current, currentProgress: !current.currentProgress }))}>
                              <Wrench size={15} />
                              <span>Editing {firstActiveProgressFile.path} +{firstActiveProgressFile.added} -{firstActiveProgressFile.deleted}</span>
                            </button>
                            {expandedActions.currentProgress && (
                              <div className="message-action-details">
                                {(activeProgress.files ?? []).slice(0, 8).map((file) => (
                                  <div key={file.path}>
                                    <span>{file.path}</span>
                                    <small>+{file.added} -{file.deleted}</small>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : null}
                        {renderLogs(logs)}
                      </>
                    ) : null}
                  </section>
                </section>
              </>
            ) : (
              <>
                <div className="empty">Нет выбранного чата. Первое сообщение создаст чат, следующие продолжат его.</div>
                {renderComposer()}
              </>
            )}
          </section>
        </section>
      )}
      </section>

      <aside className="agent-console">
        <section className="agent-card">
          <div className="section-head">
            <h2><Bot size={18} /> Home Windows Agent</h2>
            <span className={`status ${online ? "ok" : "bad"}`}>{online ? "Online" : "Offline"}</span>
          </div>
          <div className="metric-grid">
            <div><span>Queue</span><strong>{jobs.filter((job) => ["queued", "assigned", "running"].includes(job.status)).length}</strong></div>
            <div><span>Mode</span><strong>{SANDBOX_LABELS[sandbox]}</strong></div>
            <div><span>Branch</span><strong>{selectedRepo?.currentBranch ?? "n/a"}</strong></div>
          </div>
          <div className="agent-rules">
            <span>Filesystem Access <strong>{sandbox === "danger-full-access" ? "Full" : "Scoped"}</strong></span>
            <span>Network Access <strong>{sandbox === "danger-full-access" ? "Enabled" : "Restricted"}</strong></span>
            <span>Auto Deploy <strong>{selectedRepo?.serverPath && selectedRepo.deploy?.sshTarget ? "Ready" : "Not set"}</strong></span>
          </div>
          <div className={`local-activity ${localCodexBusy ? "busy" : "idle"}`}>
            <div>
              <span>Local Codex</span>
              <strong>{localCodexBusy ? "Busy" : "Idle"}</strong>
            </div>
            <p>{localActivity?.summary ?? "Waiting for local activity heartbeat."}</p>
            {localActivity?.chatTitle && <small>{localActivity.chatTitle}</small>}
            {localActivity?.updatedAt && <small>Updated {new Date(localActivity.updatedAt).toLocaleTimeString()}</small>}
          </div>
          <div className="codex-limit">
            <div>
              <span>Codex Account</span>
              <strong>{selectedAgent?.codexUsage?.status === "signed-in" ? "Signed in" : selectedAgent?.codexUsage?.status === "signed-out" ? "Signed out" : "Unknown"}</strong>
            </div>
            <p>{selectedAgent?.codexUsage?.summary ?? "Waiting for agent limit probe."}</p>
            {typeof selectedAgent?.codexUsage?.usedPercent === "number" && (
              <div className="limit-bar" aria-label="Codex usage">
                <span style={{ width: `${selectedAgent.codexUsage.usedPercent}%` }} />
              </div>
            )}
            <small>
              {selectedAgent?.codexUsage?.remaining !== undefined && selectedAgent?.codexUsage?.limit !== undefined
                ? `${selectedAgent.codexUsage.remaining} of ${selectedAgent.codexUsage.limit} left`
                : "Exact remaining limit is not exposed by Codex CLI."}
            </small>
            {selectedAgent?.codexUsage?.checkedAt && <small>Checked {new Date(selectedAgent.codexUsage.checkedAt).toLocaleString()}</small>}
          </div>
        </section>

        <section className="agent-card">
          <div className="section-head">
            <h2><Activity size={18} /> Recent Runs</h2>
          </div>
          <div className="compact-runs">
            {jobs.slice(0, 6).map((job) => (
              <button className="compact-run" key={job.id} onClick={() => openJob(job)}>
                <span>{job.prompt.slice(0, 56)}</span>
                <small className={job.status}>{job.status}</small>
              </button>
            ))}
            {!jobs.length && <div className="empty small-empty">No runs in selected chat.</div>}
          </div>
        </section>
      </aside>
      {imagePreview && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={imagePreview.name} onClick={() => setImagePreview(null)}>
          <figure onClick={(event) => event.stopPropagation()}>
            <button aria-label="Close image preview" type="button" onClick={() => setImagePreview(null)}>
              <X size={20} />
            </button>
            <img alt={imagePreview.name} src={imagePreview.src} />
            <figcaption>
              <strong>{imagePreview.name}</strong>
              <span>{imagePreview.mimeType} · {formatBytes(imagePreview.size)}</span>
            </figcaption>
          </figure>
        </div>
      )}
    </main>
    {activeChat && (showChatScrollTop || showChatScrollBottom) && (
      <div className="chat-scroll-controls" aria-label="Прокрутка чата">
        {showChatScrollTop && (
          <button className="scroll-up" type="button" onClick={() => scrollChatToTop("smooth")} title="К началу чата">
            <ArrowUp size={18} />
          </button>
        )}
        {showChatScrollBottom && (
          <button className={`scroll-down ${showJumpToLatest ? "has-new" : ""}`} type="button" onClick={() => scrollChatToLatest("smooth")} title="К последним сообщениям">
            <ArrowDown size={18} />
          </button>
        )}
      </div>
    )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
