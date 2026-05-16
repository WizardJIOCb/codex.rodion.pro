import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  FolderGit2,
  GitBranch,
  LogOut,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Square,
  Trash2,
  UploadCloud,
  Wifi,
  WifiOff
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
  name: string;
  hostname?: string;
  status: "online" | "offline";
  codex_version?: string;
  git_version?: string;
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

type Repo = {
  id: string;
  agentId: string;
  name: string;
  pathMasked: string;
  githubUrl?: string;
  serverPath?: string;
  domain?: string;
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

function App() {
  const [csrf, setCsrf] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [progressByJob, setProgressByJob] = useState<Record<string, JobProgress>>({});
  const [prompt, setPrompt] = useState("");
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
  const [originalProjectPath, setOriginalProjectPath] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [gitMessage, setGitMessage] = useState("Update project");
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitNotice, setGitNotice] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [deployNotice, setDeployNotice] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const [projectNotice, setProjectNotice] = useState("");

  const selectedRepo = useMemo(() => repos.find((repo) => `${repo.agentId}:${repo.id}` === repoKey), [repoKey, repos]);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [activeChatId, chats]);
  const selectedAgent = agents.find((agent) => agent.status === "online") ?? agents[0];
  const online = agents.some((agent) => agent.status === "online");
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
    setActiveChatId("");
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    setProjectPanel(null);
    loadChats(repo, true);
  }

  function clearProjectSelection() {
    setRepoKey("");
    setChats([]);
    setActiveChatId("");
    setJobs([]);
    setMessages([]);
    setActiveJob(null);
    setLogs([]);
    setProjectPanel(null);
    setGitNotice("");
    setDeployNotice("");
  }

  function openNewProject() {
    setProjectName("New Project");
    setProjectPath(defaultProjectPath("New Project"));
    setProjectGithubUrl("");
    setProjectServerPath("");
    setProjectDomain("");
    setOriginalProjectPath("");
    setProjectPanel("new");
  }

  function openProjectSettings(repo: Repo) {
    setProjectName(repo.name);
    setProjectPath(repo.pathMasked);
    setProjectGithubUrl(repo.githubUrl ?? "");
    setProjectServerPath(repo.serverPath ?? "");
    setProjectDomain(repo.domain ?? "");
    setOriginalProjectPath(repo.pathMasked);
    setSandbox(repo.defaultSandbox);
    setProjectPanel("settings");
    setProjectNotice("");
  }

  useEffect(() => {
    api("/api/me").then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      setCsrf(data.csrfToken);
      refresh();
    });
  }, []);

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
      if (["job.updated", "job.created", "agent.status", "repos.updated", "chats.updated"].includes(message.type)) {
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

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    setBusy(false);
    if (!response.ok) return;
    const data = await response.json();
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
    if (!response.ok) return;
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
    if (!selectedRepo || !prompt.trim() || !csrf) return;
    let targetChatId = activeChatId;
    setBusy(true);
    if (!targetChatId) {
      const chatResponse = await api("/api/chats", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({
          agentId: selectedRepo.agentId,
          repoId: selectedRepo.id,
          title: prompt.trim().slice(0, 120)
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
        prompt,
        sandbox,
        branchMode: "current"
      })
    });
    setBusy(false);
    if (!response.ok) return;
    const { jobId } = await response.json();
    setPrompt("");
    await loadChat(targetChatId, jobId);
  }

  async function deleteChat(chat: Chat) {
    if (!csrf || !selectedRepo) return;
    const activeInChat = activeJob?.chatId === chat.id && ["queued", "assigned", "running"].includes(activeJob.status);
    if (activeInChat) return;
    setBusy(true);
    setChatNotice("");
    const response = await api(`/api/chats/${chat.id}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setChatNotice(data.error === "chat_has_running_job" ? "Stop the running job before deleting this chat." : data.error || "Chat delete failed.");
      return;
    }
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

  async function logout() {
    if (csrf) await api("/api/logout", { method: "POST", headers: { "x-csrf-token": csrf }, body: "{}" });
    setCsrf(undefined);
  }

  function renderComposer() {
    if (!selectedRepo) return null;
    return (
      <form className="composer" onSubmit={createJob}>
        <div className="segments">
          {selectedRepo.allowedSandboxes.map((item) => (
            <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{SANDBOX_LABELS[item]}</button>
          ))}
        </div>
        <textarea placeholder={activeChat ? `Напиши следующую задачу в чат "${activeChat.title}"...` : "Напиши первую задачу, чат создастся автоматически..."} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <div className="sticky-submit">
          <button disabled={busy || !prompt.trim()} type="submit"><Play size={18} /> Run Codex</button>
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
          <div className="brand-mark"><Bot size={30} /></div>
          <h1>Codex Control</h1>
          <p>Домашний Codex, управляемый с iPhone.</p>
          <form onSubmit={login}>
            <input autoComplete="email" placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <input autoComplete="current-password" placeholder="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button disabled={busy} type="submit"><Play size={18} /> Войти</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-frame">
      <aside className="app-nav">
        <div className="nav-brand">
          <div className="brand-mark small"><Bot size={20} /></div>
          <strong>codex.rodion.pro</strong>
        </div>
        <nav>
          <div className="nav-group">
            <button className="nav-item active" onClick={clearProjectSelection}><FolderGit2 size={17} /> Projects</button>
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
                            <button className="nav-delete" disabled={busy || (activeJob?.chatId === chat.id && ["queued", "assigned", "running"].includes(activeJob.status))} onClick={() => deleteChat(chat)} title="Delete chat">
                              <Trash2 size={13} />
                            </button>
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
          <button className="nav-item"><Settings size={17} /> Settings</button>
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
          <h1>{selectedRepo ? selectedRepo.name : "Projects"}</h1>
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

      {!selectedRepo && (
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

      {projectPanel && (
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

      {selectedRepo && (
        <section className="project-workspace">

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
              <button disabled={deployBusy || !selectedRepo.serverPath} type="button" onClick={deployProject}><UploadCloud size={16} /> Deploy</button>
              {gitNotice && <pre>{gitNotice}</pre>}
              {deployNotice && <pre>{deployNotice}</pre>}
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
                          <p>{message.content}</p>
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
                        <pre className="logs">{logs.map((line) => `[${line.stream}] ${line.message}`).join("\n") || "Waiting for logs..."}</pre>
                        <div className="results">
                          <h2>Git status</h2>
                          <pre>{activeJob.gitStatus || "No status yet."}</pre>
                          <h2>Diff stat</h2>
                          <pre>{activeJob.gitDiffStat || "No diff yet."}</pre>
                          <h2>Diff</h2>
                          <pre>{activeJob.gitDiff || "No diff yet."}</pre>
                        </div>
                      </>
                    ) : (
                      <div className="empty">Запусти первую задачу в этом чате.</div>
                    )}
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
            <span>Auto Deploy <strong>{selectedRepo?.serverPath ? "Ready" : "Not set"}</strong></span>
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
