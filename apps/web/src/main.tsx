import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, CheckCircle2, GitBranch, LogOut, Play, RefreshCw, Square, Wifi, WifiOff } from "lucide-react";
import "./styles.css";

type Agent = {
  id: string;
  name: string;
  hostname?: string;
  status: "online" | "offline";
  current_job_id?: string;
  last_seen_at?: string;
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

type Job = {
  id: string;
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

const templates = [
  "Почини тесты и кратко объясни изменения.",
  "Сделай ревью текущего проекта, найди риски и предложи минимальные правки.",
  "Найди баг по описанию, исправь его и запусти подходящие проверки.",
  "Сверстай экран аккуратно под мобильный UX.",
  "Добавь тесты к измененному поведению.",
  "Сделай минимальный рефакторинг без изменения публичного API."
];

function api(path: string, options: RequestInit = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
}

function App() {
  const [csrf, setCsrf] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [prompt, setPrompt] = useState("");
  const [repoKey, setRepoKey] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("workspace-write");
  const [busy, setBusy] = useState(false);

  const selectedRepo = useMemo(() => repos.find((repo) => `${repo.agentId}:${repo.id}` === repoKey), [repoKey, repos]);

  async function refresh() {
    const [agentResponse, repoResponse, jobResponse] = await Promise.all([
      api("/api/agents"),
      api("/api/repos"),
      api("/api/jobs")
    ]);
    if (agentResponse.ok) setAgents((await agentResponse.json()).agents);
    if (repoResponse.ok) {
      const nextRepos = (await repoResponse.json()).repos;
      setRepos(nextRepos);
      if (!repoKey && nextRepos[0]) {
        setRepoKey(`${nextRepos[0].agentId}:${nextRepos[0].id}`);
        setSandbox(nextRepos[0].defaultSandbox);
      }
    }
    if (jobResponse.ok) setJobs((await jobResponse.json()).jobs);
  }

  async function loadJob(jobId: string) {
    const response = await api(`/api/jobs/${jobId}`);
    if (!response.ok) return;
    const data = await response.json();
    setActiveJob(data.job);
    setLogs(data.logs);
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
      if (["job.updated", "job.created", "agent.status", "repos.updated"].includes(message.type)) {
        refresh();
        if (message.jobId && activeJob?.id === message.jobId) loadJob(message.jobId);
      }
    };
    return () => ws.close();
  }, [csrf, activeJob?.id]);

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

  async function createJob(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedRepo || !prompt.trim() || !csrf) return;
    setBusy(true);
    const response = await api("/api/jobs", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: JSON.stringify({
        agentId: selectedRepo.agentId,
        repoId: selectedRepo.id,
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
    await refresh();
  }

  async function cancelJob() {
    if (!activeJob || !csrf) return;
    await api(`/api/jobs/${activeJob.id}/cancel`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: "{}"
    });
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

  const online = agents.some((agent) => agent.status === "online");

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <span className={`status ${online ? "ok" : "bad"}`}>{online ? <Wifi size={16} /> : <WifiOff size={16} />} {online ? "Home PC online" : "Home PC offline"}</span>
          <h1>Codex Control</h1>
        </div>
        <div className="top-actions">
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

      <form className="composer" onSubmit={createJob}>
        <label>
          Проект
          <select value={repoKey} onChange={(event) => {
            setRepoKey(event.target.value);
            const repo = repos.find((item) => `${item.agentId}:${item.id}` === event.target.value);
            if (repo) setSandbox(repo.defaultSandbox);
          }}>
            {repos.map((repo) => (
              <option key={`${repo.agentId}:${repo.id}`} value={`${repo.agentId}:${repo.id}`}>
                {repo.name} {repo.currentBranch ? `· ${repo.currentBranch}` : ""}
              </option>
            ))}
          </select>
        </label>
        {selectedRepo && (
          <div className="repo-meta">
            <GitBranch size={16} /> {selectedRepo.currentBranch || "no branch"} · {selectedRepo.dirty ? "dirty" : "clean"} · {selectedRepo.pathMasked}
          </div>
        )}
        <div className="segments">
          {selectedRepo?.allowedSandboxes.map((item) => (
            <button className={sandbox === item ? "active" : ""} key={item} type="button" onClick={() => setSandbox(item)}>{item}</button>
          ))}
        </div>
        <div className="chips">
          {templates.map((template) => (
            <button key={template} type="button" onClick={() => setPrompt(template)}>{template}</button>
          ))}
        </div>
        <textarea placeholder="Напиши Codex задачу для выбранного проекта..." value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <div className="sticky-submit">
          <button disabled={busy || !selectedRepo || !prompt.trim()} type="submit"><Play size={18} /> Run Codex</button>
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
            <div className="empty">Выбери задачу или запусти новую.</div>
          )}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
