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
  UploadCloud,
  Wifi,
  WifiOff
} from "lucide-react";
import "./styles.css";

type Agent = {
  id: string;
  name: string;
  hostname?: string;
  status: "online" | "offline";
  codex_version?: string;
  git_version?: string;
};

type Repo = {
  id: string;
  agentId: string;
  name: string;
  pathMasked: string;
  currentBranch?: string;
  dirty: boolean;
  defaultSandbox: "read-only" | "workspace-write";
  allowedSandboxes: Array<"read-only" | "workspace-write">;
  testCommands: Array<{ id: string; label: string }>;
};

type Chat = {
  id: string;
  agentId: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `C:\\Projects\\${slug || "new-project"}`;
}

function App() {
  const [csrf, setCsrf] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [progressByJob, setProgressByJob] = useState<Record<string, JobProgress>>({});
  const [prompt, setPrompt] = useState("");
  const [repoKey, setRepoKey] = useState("");
  const [activeChatId, setActiveChatId] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("workspace-write");
  const [busy, setBusy] = useState(false);
  const [projectPanel, setProjectPanel] = useState<"new" | "settings" | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [originalProjectPath, setOriginalProjectPath] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [gitMessage, setGitMessage] = useState("Update project");
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitNotice, setGitNotice] = useState("");
  const [gitBusy, setGitBusy] = useState(false);

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

  async function loadChats(repo: Repo) {
    const response = await api(`/api/chats?agentId=${encodeURIComponent(repo.agentId)}&repoId=${encodeURIComponent(repo.id)}`);
    if (!response.ok) return;
    const nextChats = (await response.json()).chats;
    setChats(nextChats);
    if (activeChatId && !nextChats.some((chat: Chat) => chat.id === activeChatId)) {
      setActiveChatId("");
      setJobs([]);
      setActiveJob(null);
      setLogs([]);
    }
  }

  async function loadChat(chatId: string) {
    const response = await api(`/api/chats/${chatId}`);
    if (!response.ok) return;
    const data = await response.json();
    setActiveChatId(chatId);
    setJobs(data.jobs);
    if (data.jobs[0]) await loadJob(data.jobs[0].id);
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

  function selectProject(repo: Repo) {
    setRepoKey(`${repo.agentId}:${repo.id}`);
    setSandbox(repo.defaultSandbox);
    setGitMessage(`Update ${repo.name}`);
    setGitRemoteUrl("");
    setGitNotice("");
    setActiveChatId("");
    setJobs([]);
    setActiveJob(null);
    setLogs([]);
    setProjectPanel(null);
    loadChats(repo);
  }

  function clearProjectSelection() {
    setRepoKey("");
    setChats([]);
    setActiveChatId("");
    setJobs([]);
    setActiveJob(null);
    setLogs([]);
    setProjectPanel(null);
    setGitNotice("");
  }

  function openNewProject() {
    setProjectName("New Project");
    setProjectPath(defaultProjectPath("New Project"));
    setOriginalProjectPath("");
    setProjectPanel("new");
  }

  function openProjectSettings(repo: Repo) {
    setProjectName(repo.name);
    setProjectPath(repo.pathMasked);
    setOriginalProjectPath(repo.pathMasked);
    setSandbox(repo.defaultSandbox);
    setProjectPanel("settings");
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
      defaultSandbox: sandbox,
      allowedSandboxes: ["read-only", "workspace-write"]
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
      setSandbox("workspace-write");
    }
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
    if (!selectedRepo || !activeChatId || !prompt.trim() || !csrf) return;
    setBusy(true);
    const response = await api("/api/jobs", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        agentId: selectedRepo.agentId,
        repoId: selectedRepo.id,
        chatId: activeChatId,
        prompt,
        sandbox,
        branchMode: "current"
      })
    });
    setBusy(false);
    if (!response.ok) return;
    const { jobId } = await response.json();
    setPrompt("");
    await loadJob(jobId);
    await loadChat(activeChatId);
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
        remoteUrl: gitRemoteUrl.trim() || undefined
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

  async function logout() {
    if (csrf) await api("/api/logout", { method: "POST", headers: { "x-csrf-token": csrf }, body: "{}" });
    setCsrf(undefined);
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
    <main className="shell">
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
          <div className="segments">
            {(["read-only", "workspace-write"] as const).map((item) => (
              <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{item}</button>
            ))}
          </div>
          <button disabled={busy || !online} type="submit"><Save size={16} /> Save project</button>
        </form>
      )}

      {selectedRepo && (
        <section className="project-workspace">
          <aside className="chat-sidebar">
            <div className="section-head">
              <h2><MessageSquare size={18} /> Chats</h2>
              <button className="icon tiny" onClick={() => openProjectSettings(selectedRepo)} title="Настройки"><Settings size={16} /></button>
            </div>
            <form className="new-chat" onSubmit={createChat}>
              <input placeholder="New chat title" value={chatTitle} onChange={(event) => setChatTitle(event.target.value)} />
              <button disabled={busy || !chatTitle.trim()}><Plus size={16} /></button>
            </form>
            <div className="chat-list">
              {chats.map((chat) => (
                <button className={activeChatId === chat.id ? "chat active" : "chat"} key={chat.id} onClick={() => loadChat(chat.id)}>
                  <span>{chat.title}</span>
                  <small>{new Date(chat.updatedAt).toLocaleString()}</small>
                </button>
              ))}
            </div>
          </aside>

          <section className="chat-work">
            <div className="repo-meta">
              <GitBranch size={16} /> {selectedRepo.currentBranch || "no branch"} · {selectedRepo.dirty ? "dirty" : "clean"} · {selectedRepo.pathMasked}
            </div>
            <form className="git-panel" onSubmit={syncGit}>
              <input aria-label="Commit message" value={gitMessage} onChange={(event) => setGitMessage(event.target.value)} />
              <input aria-label="Remote URL" placeholder="origin URL, optional" value={gitRemoteUrl} onChange={(event) => setGitRemoteUrl(event.target.value)} />
              <button disabled={gitBusy || !gitMessage.trim()} type="submit"><UploadCloud size={16} /> Commit & push</button>
              {gitNotice && <pre>{gitNotice}</pre>}
            </form>
            {activeChat ? (
              <>
                <form className="composer" onSubmit={createJob}>
                  <div className="segments">
                    {selectedRepo.allowedSandboxes.map((item) => (
                      <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{item}</button>
                    ))}
                  </div>
                  <textarea placeholder={`Напиши задачу в чат "${activeChat.title}"...`} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                  <div className="sticky-submit">
                    <button disabled={busy || !prompt.trim()} type="submit"><Play size={18} /> Run Codex</button>
                    {activeJob && ["queued", "assigned", "running"].includes(activeJob.status) && (
                      <button className="stop" type="button" onClick={cancelJob}><Square size={18} /> Stop</button>
                    )}
                  </div>
                </form>

                <section className="workspace">
                  <aside className="history">
                    <h2><Activity size={18} /> Jobs</h2>
                    {jobs.map((job) => (
                      <button className={activeJob?.id === job.id ? "job active" : "job"} key={job.id} onClick={() => loadJob(job.id)}>
                        <span>{job.prompt.slice(0, 76)}</span>
                        <small>{job.status} · {new Date(job.createdAt).toLocaleString()}</small>
                      </button>
                    ))}
                  </aside>

                  <section className="job-detail">
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
              <div className="empty">Выбери чат проекта или создай новый.</div>
            )}
          </section>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
