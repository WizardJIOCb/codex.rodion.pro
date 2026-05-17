import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  Clock3,
  FolderGit2,
  Github,
  GitBranch,
  KeyRound,
  Link2,
  LogOut,
  Mail,
  MoreHorizontal,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Square,
  UploadCloud,
  UserCircle,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import "./styles.css";

type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
const SANDBOXES: Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const SANDBOX_LABELS: Record<Sandbox, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "danger-full-access": "full-access"
};

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
  dataBase64?: string;
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

type Job = {
  id: string;
  chatId?: string | null;
  agentId: string;
  repoId: string;
  prompt: string;
  sandbox: string;
  status: string;
  exitCode: number | null;
  finalMessage: string | null;
  gitStatus: string | null;
  gitDiffStat: string | null;
  gitDiff: string | null;
  createdAt: string;
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
  at: string;
};

function api(path: string, options: RequestInit = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
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
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
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

function diffRows(stat: string | null) {
  if (!stat) return [];
  return stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.*?)\s+\|\s+(\d+)\s+([+\-]+)?/);
      return {
        file: match?.[1]?.trim() || line,
        changed: Number(match?.[2] ?? 0),
        bars: match?.[3] ?? ""
      };
    })
    .slice(0, 8);
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

function renderMessageAttachments(attachments: MessageAttachment[] | undefined, onPreview: (preview: ImagePreview) => void) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment, index) => {
        const previewUrl = attachmentDataUrl(attachment);
        const body = (
          <>
            {previewUrl ? <img alt="" src={previewUrl} /> : <Paperclip size={16} />}
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [progressByJob, setProgressByJob] = useState<Record<string, JobProgress>>({});
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [repoKey, setRepoKey] = useState("");
  const [activeChatId, setActiveChatId] = useState("");
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

  const selectedRepo = useMemo(() => repos.find((repo) => `${repo.agentId}:${repo.id}` === repoKey), [repoKey, repos]);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [activeChatId, chats]);
  const selectedAgent = agents.find((agent) => agent.status === "online") ?? agents[0];
  const online = agents.some((agent) => agent.status === "online");
  const localActivity = selectedAgent?.localActivity;
  const localCodexBusy = localActivity?.status === "busy" || Boolean(selectedAgent?.current_job_id);
  const activeProgress = activeJob ? progressByJob[activeJob.id] ?? {
    jobId: activeJob.id,
    phase: activeJob.status,
    message: activeJob.status === "running" ? "Codex is running." : `Job is ${activeJob.status}.`,
    filesChanged: 0,
    added: 0,
    deleted: 0,
    at: new Date().toISOString()
  } : null;

  async function refresh() {
    const [agentResponse, repoResponse] = await Promise.all([api("/api/agents"), api("/api/repos")]);
    if (agentResponse.ok) setAgents((await agentResponse.json()).agents);
    if (repoResponse.ok) {
      const nextRepos = (await repoResponse.json()).repos;
      setRepos(nextRepos);
      if (repoKey && !nextRepos.some((repo: Repo) => `${repo.agentId}:${repo.id}` === repoKey)) {
        clearProjectSelection();
      }
    }
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
    const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}`);
    if (!response.ok) return;
    const nextChats = (await response.json()).chats;
    setChats(nextChats);
    if (selectFirst && nextChats[0]) {
      await loadChat(nextChats[0].id);
      return;
    }
    if (activeChatId && !nextChats.some((chat: Chat) => chat.id === activeChatId)) {
      setActiveChatId("");
      setJobs([]);
      setMessages([]);
      setActiveJob(null);
      setLogs([]);
    }
  }

  async function loadHiddenLocalChats(repo: Repo) {
    const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}&includeHidden=1&localOnly=1`);
    if (!response.ok) return;
    const nextChats = ((await response.json()).chats as Chat[]).filter((chat) => chat.hiddenAt);
    setHiddenLocalChats(nextChats);
  }

  async function loadChat(chatId: string, preferredJobId?: string) {
    const response = await api(`/api/chats/${chatId}`);
    if (!response.ok) return;
    const data = await response.json();
    setChats((current) => {
      const withoutLoaded = current.filter((chat) => chat.id !== data.chat.id);
      return [data.chat, ...withoutLoaded].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    });
    setActiveChatId(chatId);
    setJobs(data.jobs);
    setMessages(data.messages ?? []);
    const targetJobId = preferredJobId ?? data.jobs[0]?.id;
    if (targetJobId) await loadJob(targetJobId);
    else {
      setActiveJob(null);
      setLogs([]);
    }
  }

  async function loadJob(jobId: string) {
    const response = await api(`/api/jobs/${jobId}`);
    if (!response.ok) return;
    const data = await response.json();
    setActiveJob(data.job);
    setLogs(data.logs);
  }

  async function openJob(job: Job) {
    if (job.chatId) await loadChat(job.chatId, job.id);
    else await loadJob(job.id);
  }

  function selectProject(repo: Repo) {
    setRepoKey(`${repo.agentId}:${repo.id}`);
    setSandbox(repo.defaultSandbox);
    setGitMessage(`Update ${repo.name}`);
    setGitRemoteUrl(repo.githubUrl ?? "");
    setGitNotice("");
    setDeployNotice("");
    setNginxNotice("");
    setSslNotice("");
    setActiveChatId("");
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
    setView("projects");
    setRepoKey("");
    setChats([]);
    setActiveChatId("");
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
    setView("settings");
    setProjectPanel(null);
    setRepoKey("");
    setActiveChatId("");
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    loadUsers();
  }

  function openProfileView() {
    setView("profile");
    setProjectPanel(null);
    setRepoKey("");
    setActiveChatId("");
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
    if (!csrf) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/ui/ws`);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "job.log") {
        setLogs((current) => (activeJob?.id === message.jobId ? [...current, message] : current));
      }
      if (message.type === "job.progress") {
        setProgressByJob((current) => ({ ...current, [message.jobId]: message }));
      }
      if (["job.updated", "job.created", "agent.status", "agent.activity", "repos.updated", "chats.updated"].includes(message.type)) {
        refresh();
        if (selectedRepo && message.type === "chats.updated" && message.repoId === selectedRepo.id) loadChats(selectedRepo);
        if (message.jobId && activeJob?.id === message.jobId) loadJob(message.jobId);
        if (activeChatId) loadChat(activeChatId);
      }
    };
    return () => ws.close();
  }, [csrf, activeJob?.id, activeChatId, selectedRepo?.id]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

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

  async function syncGit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedRepo || !csrf || !gitMessage.trim()) return;
    setGitBusy(true);
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

  function renderComposer() {
    if (!selectedRepo) return null;
    const canSubmit = Boolean(prompt.trim() || attachments.length);
    const activeRunBusy = Boolean(activeJob && ["queued", "assigned", "running"].includes(activeJob.status));
    const runDisabled = busy || !canSubmit || localCodexBusy || activeRunBusy;
    return (
      <form className="composer" onSubmit={createJob}>
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
          <button className="run-button" disabled={runDisabled} type="submit">
            {localCodexBusy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}
            {localCodexBusy ? "Codex busy" : "Run Codex"}
          </button>
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
    <main className="app-frame">
      <aside className="app-nav">
        <div className="nav-brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <strong>codex.rodion.pro</strong>
        </div>
        <nav>
          <div className="nav-group">
            <button className={view === "projects" ? "nav-item active" : "nav-item"} onClick={clearProjectSelection}><FolderGit2 size={17} /> Projects</button>
            <div className="nav-subtree">
              {repos.map((repo) => {
                const selected = selectedRepo?.agentId === repo.agentId && selectedRepo.id === repo.id;
                return (
                  <div className="nav-project" key={`${repo.agentId}:${repo.id}`}>
                    <button className={selected ? "nav-leaf project active" : "nav-leaf project"} onClick={() => selectProject(repo)}>
                      <span>{repo.name}</span>
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
                            <button className="nav-leaf chat-child" onClick={() => loadChat(chat.id)}>
                              <span>{chat.title}</span>
                              <small>{new Date(chat.updatedAt).toLocaleString()}</small>
                            </button>
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

      <section className="shell">
      <header className="topbar">
        <div>
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
                    <section className="chat-thread">
                      {messages.length ? messages.map((message) => (
                        <article className={`message ${message.role}`} key={message.id}>
                          <div className="message-meta">
                            <span>{message.role === "user" ? "You" : message.source === "vscode" ? "VS Code" : "Codex"}</span>
                            <small>{new Date(message.createdAt).toLocaleString()}</small>
                          </div>
                          {renderRichText(message.content, "rich-text message-body")}
                          {renderMessageAttachments(message.attachments, setImagePreview)}
                        </article>
                      )) : (
                        <div className="empty">Начни этот чат или дождись синхронизации истории из локального Codex/VS Code.</div>
                      )}
                    </section>
                    {renderComposer()}
                    {activeJob ? (
                      <>
                        <div className="job-head">
                          <span className={`pill ${activeJob.status}`}><CheckCircle2 size={15} /> {activeJob.status}</span>
                          <strong>{activeJob.prompt}</strong>
                        </div>
                        {activeProgress && (
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
                        )}
                        {activeJob.gitDiffStat && (
                          <div className="edited-card">
                            <div className="edited-head">
                              <strong>Edited {diffRows(activeJob.gitDiffStat).length || activeProgress?.filesChanged || 0} files</strong>
                              <span>+{activeProgress?.added ?? 0} -{activeProgress?.deleted ?? 0}</span>
                            </div>
                            {diffRows(activeJob.gitDiffStat).map((row) => (
                              <div className="edited-row" key={row.file}>
                                <span>{row.file}</span>
                                <small>{row.changed} {row.bars}</small>
                              </div>
                            ))}
                          </div>
                        )}
                        {renderLogs(logs)}
                        <div className="results">
                          <h2>Git status</h2>
                          <pre>{activeJob.gitStatus || "No status yet."}</pre>
                          <h2>Diff stat</h2>
                          <pre>{activeJob.gitDiffStat || "No diff yet."}</pre>
                          <h2>Diff</h2>
                          <pre>{activeJob.gitDiff || "No diff yet."}</pre>
                        </div>
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
  );
}

createRoot(document.getElementById("root")!).render(<App />);
