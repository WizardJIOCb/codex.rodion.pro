#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    env,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

const SERVICE_NAME: &str = "codex.rodion.pro.desktop-agent";
const MAX_LOG_LINES: usize = 160;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    server_url: String,
    agent_id: String,
    agent_root: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            server_url: "wss://codex.rodion.pro/api/agent/ws".to_string(),
            agent_id: "home-windows".to_string(),
            agent_root: default_agent_root().to_string_lossy().to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPayload {
    server_url: String,
    agent_id: String,
    agent_root: String,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledAgentConfig {
    #[serde(alias = "agentId")]
    agent_id: String,
    #[serde(alias = "serverUrl")]
    server_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    configured: bool,
    running: bool,
    token_configured: bool,
    server_url: String,
    agent_id: String,
    agent_root: String,
    config_path: String,
    hostname: String,
    platform: String,
    last_error: Option<String>,
    logs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigFile {
    agent_id: String,
    server_url: String,
    token_env: String,
    heartbeat_interval_ms: u64,
    max_job_duration_ms: u64,
    cancel_grace_ms: u64,
    max_log_bytes_per_job: u64,
    fake_runner: bool,
    repos: Vec<Value>,
    redact_patterns: Vec<String>,
}

struct DesktopState {
    config: Mutex<DesktopConfig>,
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<VecDeque<String>>>,
    last_error: Mutex<Option<String>>,
}

struct LaunchEnv {
    path: String,
    path_entries: Vec<String>,
    codex_env: Vec<(String, String)>,
}

fn main() {
    tauri::Builder::default()
        .manage(DesktopState {
            config: Mutex::new(DesktopConfig::default()),
            child: Mutex::new(None),
            logs: Arc::new(Mutex::new(VecDeque::new())),
            last_error: Mutex::new(None),
        })
        .setup(|app| {
            let config = load_config(app.handle()).unwrap_or_default();
            if let Some(state) = app.try_state::<DesktopState>() {
                *state.config.lock().map_err(|_| "config lock poisoned")? = config;
            }
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            save_settings,
            import_existing_setup,
            start_agent,
            stop_agent,
            open_web
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codex Agent");
}

#[tauri::command]
fn get_status(app: tauri::AppHandle, state: State<'_, DesktopState>) -> Result<AgentStatus, String> {
    reap_child(&state);
    let config = state.config.lock().map_err(|_| "config lock poisoned")?.clone();
    let config_path = agent_config_path(&app)?;
    let token_configured = load_agent_token(&config.agent_id).is_some();
    let running = state.child.lock().map_err(|_| "child lock poisoned")?.is_some();
    let last_error = state
        .last_error
        .lock()
        .map_err(|_| "error lock poisoned")?
        .clone();
    let logs = state
        .logs
        .lock()
        .map_err(|_| "log lock poisoned")?
        .iter()
        .cloned()
        .collect();

    Ok(AgentStatus {
        configured: token_configured && agent_entrypoint(&config).exists(),
        running,
        token_configured,
        server_url: config.server_url,
        agent_id: config.agent_id,
        agent_root: config.agent_root,
        config_path: config_path.to_string_lossy().to_string(),
        hostname: hostname(),
        platform: std::env::consts::OS.to_string(),
        last_error,
        logs,
    })
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    settings: SettingsPayload,
) -> Result<(), String> {
    validate_agent_id(&settings.agent_id)?;
    validate_server_url(&settings.server_url)?;
    let next = DesktopConfig {
        server_url: settings.server_url.trim().to_string(),
        agent_id: settings.agent_id.trim().to_string(),
        agent_root: expand_home(settings.agent_root.trim()),
    };
    if let Some(token) = settings.token.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        save_token(&next.agent_id, token)?;
    }
    save_config(&app, &next)?;
    write_agent_config(&app, &next)?;
    *state.config.lock().map_err(|_| "config lock poisoned")? = next;
    *state.last_error.lock().map_err(|_| "error lock poisoned")? = None;
    push_log(&state.logs, "Settings saved");
    Ok(())
}

#[tauri::command]
fn import_existing_setup(app: tauri::AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    let current = state.config.lock().map_err(|_| "config lock poisoned")?.clone();
    let mut next = current.clone();

    if let Some(imported) = find_installed_agent_config(&current) {
        validate_agent_id(&imported.agent_id)?;
        validate_server_url(&imported.server_url)?;
        next = imported;
    }

    let token = load_existing_agent_token()
        .ok_or_else(|| "Could not find CMC_AGENT_TOKEN in this process or Windows user environment.".to_string())?;
    save_token(&next.agent_id, &token)?;
    save_config(&app, &next)?;
    write_agent_config(&app, &next)?;
    *state.config.lock().map_err(|_| "config lock poisoned")? = next;
    *state.last_error.lock().map_err(|_| "error lock poisoned")? = None;
    push_log(&state.logs, "Existing setup imported");
    Ok(())
}

#[tauri::command]
fn start_agent(app: tauri::AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    reap_child(&state);
    if state.child.lock().map_err(|_| "child lock poisoned")?.is_some() {
        return Ok(());
    }

    let config = state.config.lock().map_err(|_| "config lock poisoned")?.clone();
    validate_agent_id(&config.agent_id)?;
    validate_server_url(&config.server_url)?;
    let token = load_agent_token(&config.agent_id).ok_or_else(|| "Agent token is not available yet.".to_string())?;
    let entrypoint = agent_entrypoint(&config);
    if !entrypoint.exists() {
        return Err(format!(
            "Agent package is not installed: {}",
            entrypoint.to_string_lossy()
        ));
    }
    let config_path = write_agent_config(&app, &config)?;
    let launch_env = agent_launch_env()?;
    let node_command = launch_env
        .codex_env
        .iter()
        .find_map(|(key, value)| (key == "CMC_CODEX_NODE").then(|| value.clone()))
        .or_else(|| find_executable("node.exe", &launch_env.path_entries))
        .unwrap_or_else(|| "node".to_string());
    let mut child = Command::new(node_command)
        .arg("--no-warnings=ExperimentalWarning")
        .arg(&entrypoint)
        .arg("--config")
        .arg(&config_path)
        .current_dir(&config.agent_root)
        .env("CMC_AGENT_TOKEN", token)
        .env("PATH", &launch_env.path)
        .env("Path", &launch_env.path)
        .env("PATHEXT", ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC")
        .envs(launch_env.codex_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start node agent: {error}"))?;

    if let Some(stdout) = child.stdout.take() {
        pipe_logs("agent", stdout, Arc::clone(&state.logs));
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_logs("agent:error", stderr, Arc::clone(&state.logs));
    }

    *state.child.lock().map_err(|_| "child lock poisoned")? = Some(child);
    *state.last_error.lock().map_err(|_| "error lock poisoned")? = None;
    push_log(&state.logs, "Agent process started");
    Ok(())
}

#[tauri::command]
fn stop_agent(state: State<'_, DesktopState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().map_err(|_| "child lock poisoned")?.take() {
        let _ = child.kill();
        let _ = child.wait();
        push_log(&state.logs, "Agent process stopped");
    }
    Ok(())
}

#[tauri::command]
fn open_web() -> Result<(), String> {
    open::that("https://codex.rodion.pro/sync").map_err(|error| format!("Could not open web UI: {error}"))
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start agent", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop agent", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;
    let icon = Image::new_owned(tray_icon_rgba(), 16, 16);

    TrayIconBuilder::new()
        .tooltip("Codex Agent")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "start" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    let _ = start_agent(app.clone(), state);
                }
            }
            "stop" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    let _ = stop_agent(state);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn pipe_logs<R>(label: &'static str, stream: R, logs: Arc<Mutex<VecDeque<String>>>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            push_log(&logs, &format!("{label}: {line}"));
        }
    });
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: &str) {
    if line.contains("cmc_agent_") || line.contains("CMC_AGENT_TOKEN") {
        return;
    }
    if is_noisy_agent_warning(line) {
        return;
    }
    if let Ok(mut guard) = logs.lock() {
        guard.push_back(line.to_string());
        while guard.len() > MAX_LOG_LINES {
            guard.pop_front();
        }
    }
}

fn is_noisy_agent_warning(line: &str) -> bool {
    line.contains("ExperimentalWarning: SQLite is an experimental feature")
        || line.contains("Use `node --trace-warnings ...` to show where the warning was created")
}

fn reap_child(state: &State<'_, DesktopState>) {
    let mut child_guard = match state.child.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let Some(child) = child_guard.as_mut() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            let message = format!("Agent process exited: {status}");
            *child_guard = None;
            if let Ok(mut last_error) = state.last_error.lock() {
                *last_error = Some(message.clone());
            }
            push_log(&state.logs, &message);
        }
        Ok(None) => {}
        Err(error) => {
            let message = format!("Could not read agent process status: {error}");
            *child_guard = None;
            if let Ok(mut last_error) = state.last_error.lock() {
                *last_error = Some(message.clone());
            }
            push_log(&state.logs, &message);
        }
    }
}

fn load_config(app: &tauri::AppHandle) -> Result<DesktopConfig, String> {
    let path = desktop_config_path(app)?;
    if !path.exists() {
        return Ok(DesktopConfig::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("Could not read desktop config: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("Could not parse desktop config: {error}"))
}

fn save_config(app: &tauri::AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let path = desktop_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create config folder: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|error| format!("Could not serialize config: {error}"))?;
    fs::write(path, format!("{raw}\n")).map_err(|error| format!("Could not write desktop config: {error}"))
}

fn write_agent_config(app: &tauri::AppHandle, config: &DesktopConfig) -> Result<PathBuf, String> {
    let path = agent_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create agent config folder: {error}"))?;
    }
    let mut agent_config = best_agent_config_value(app, config).unwrap_or_else(|| {
        json!(AgentConfigFile {
            agent_id: config.agent_id.clone(),
            server_url: config.server_url.clone(),
            token_env: "CMC_AGENT_TOKEN".to_string(),
            heartbeat_interval_ms: 20_000,
            max_job_duration_ms: 3_600_000,
            cancel_grace_ms: 5_000,
            max_log_bytes_per_job: 10_485_760,
            fake_runner: false,
            repos: Vec::new(),
            redact_patterns: vec![
                "sk-[A-Za-z0-9_-]+".to_string(),
                "ghp_[A-Za-z0-9_]+".to_string(),
                "OPENAI_API_KEY=\\S+".to_string(),
                "cmc_agent_[A-Za-z0-9_-]+".to_string(),
            ],
        })
    });
    if let Some(object) = agent_config.as_object_mut() {
        object.insert("agentId".to_string(), json!(config.agent_id));
        object.insert("serverUrl".to_string(), json!(config.server_url));
        object.insert("tokenEnv".to_string(), json!("CMC_AGENT_TOKEN"));
        object.entry("heartbeatIntervalMs".to_string()).or_insert(json!(20_000));
        object.entry("maxJobDurationMs".to_string()).or_insert(json!(3_600_000));
        object.entry("cancelGraceMs".to_string()).or_insert(json!(5_000));
        object.entry("maxLogBytesPerJob".to_string()).or_insert(json!(10_485_760));
        object.entry("fakeRunner".to_string()).or_insert(json!(false));
        object.entry("repos".to_string()).or_insert(json!([]));
        object.entry("redactPatterns".to_string()).or_insert(json!([
            "sk-[A-Za-z0-9_-]+",
            "ghp_[A-Za-z0-9_]+",
            "OPENAI_API_KEY=\\S+",
            "cmc_agent_[A-Za-z0-9_-]+"
        ]));
    }
    let raw = serde_json::to_string_pretty(&agent_config)
        .map_err(|error| format!("Could not serialize agent config: {error}"))?;
    fs::write(&path, format!("{raw}\n")).map_err(|error| format!("Could not write agent config: {error}"))?;
    Ok(path)
}

fn desktop_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("desktop-agent.json"))
}

fn agent_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("agent.config.json"))
}

fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve app config folder: {error}"))
}

fn agent_entrypoint(config: &DesktopConfig) -> PathBuf {
    Path::new(&config.agent_root)
        .join("apps")
        .join("agent-windows")
        .join("dist")
        .join("index.js")
}

fn best_agent_config_value(app: &tauri::AppHandle, config: &DesktopConfig) -> Option<Value> {
    let mut best: Option<(usize, Value)> = None;
    for path in candidate_agent_config_paths(app, config) {
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let repo_count = config_repo_count(&value);
        if best.as_ref().map(|(count, _)| repo_count > *count).unwrap_or(true) {
            best = Some((repo_count, value));
        }
    }
    best.map(|(_, value)| value)
}

fn candidate_agent_config_paths(app: &tauri::AppHandle, config: &DesktopConfig) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(path) = agent_config_path(app) {
        paths.push(path);
    }
    paths.push(
        Path::new(&config.agent_root)
            .join("apps")
            .join("agent-windows")
            .join("agent.config.json"),
    );
    paths.push(
        default_agent_root()
            .join("apps")
            .join("agent-windows")
            .join("agent.config.json"),
    );
    if let Ok(mut cwd) = std::env::current_dir() {
        loop {
            paths.push(cwd.join("apps").join("agent-windows").join("agent.config.json"));
            if !cwd.pop() {
                break;
            }
        }
    }
    paths.dedup();
    paths
}

fn config_repo_count(value: &Value) -> usize {
    value
        .get("repos")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default()
}

fn agent_launch_env() -> Result<LaunchEnv, String> {
    let mut entries = Vec::new();
    push_path(&mut entries, env::var("APPDATA").ok().map(|value| Path::new(&value).join("npm")));
    push_path(&mut entries, find_executable("node.exe", &current_path_entries()).and_then(|value| {
        Path::new(&value).parent().map(|parent| parent.to_path_buf())
    }));
    for entry in user_path_entries() {
        push_path(&mut entries, Some(PathBuf::from(entry)));
    }
    for entry in machine_path_entries() {
        push_path(&mut entries, Some(PathBuf::from(entry)));
    }
    for entry in current_path_entries() {
        push_path(&mut entries, Some(PathBuf::from(entry)));
    }

    let separator = if cfg!(windows) { ";" } else { ":" };
    let path = entries.join(separator);
    let codex_env = codex_launch_env(&entries)?;
    Ok(LaunchEnv {
        path,
        path_entries: entries,
        codex_env,
    })
}

fn codex_launch_env(path_entries: &[String]) -> Result<Vec<(String, String)>, String> {
    let Some(node) = find_executable("node.exe", path_entries).or_else(|| find_executable("node", path_entries)) else {
        return Err("node.exe was not found in PATH.".to_string());
    };
    if let Some(codex_cmd) = find_executable("codex.cmd", path_entries) {
        let codex_js = Path::new(&codex_cmd)
            .parent()
            .map(|parent| parent.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js"))
            .filter(|path| path.exists())
            .map(|path| path.to_string_lossy().to_string());
        if let Some(codex_js) = codex_js {
            return Ok(vec![
                ("CMC_CODEX_BIN".to_string(), codex_cmd),
                ("CMC_CODEX_NODE".to_string(), node),
                ("CMC_CODEX_JS".to_string(), codex_js),
            ]);
        }
        return Ok(vec![("CMC_CODEX_BIN".to_string(), codex_cmd)]);
    }
    if let Some(codex_exe) = find_executable("codex.exe", path_entries).or_else(|| find_executable("codex", path_entries)) {
        return Ok(vec![("CMC_CODEX_BIN".to_string(), codex_exe)]);
    }
    Err("Codex CLI was not found. Install Codex CLI or make codex.cmd available in PATH.".to_string())
}

fn find_executable(name: &str, path_entries: &[String]) -> Option<String> {
    let candidates = executable_candidates(name);
    for entry in path_entries {
        for candidate in &candidates {
            let path = Path::new(entry).join(candidate);
            if path.is_file() {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn executable_candidates(name: &str) -> Vec<String> {
    if Path::new(name).extension().is_some() {
        return vec![name.to_string()];
    }
    if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    }
}

fn push_path(entries: &mut Vec<String>, path: Option<PathBuf>) {
    let Some(path) = path else {
        return;
    };
    if !path.exists() {
        return;
    }
    let value = path.to_string_lossy().to_string();
    if entries.iter().any(|entry| entry.eq_ignore_ascii_case(&value)) {
        return;
    }
    entries.push(value);
}

fn current_path_entries() -> Vec<String> {
    env::var("PATH")
        .or_else(|_| env::var("Path"))
        .unwrap_or_default()
        .split(if cfg!(windows) { ';' } else { ':' })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(windows)]
fn user_path_entries() -> Vec<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey("Environment")
        .ok()
        .and_then(|key| key.get_value::<String, _>("Path").ok())
        .map(split_windows_path)
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn user_path_entries() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn machine_path_entries() -> Vec<String> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    hklm.open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
        .ok()
        .and_then(|key| key.get_value::<String, _>("Path").ok())
        .map(split_windows_path)
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn machine_path_entries() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn split_windows_path(value: String) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(expand_windows_env_refs)
        .collect()
}

#[cfg(windows)]
fn expand_windows_env_refs(value: &str) -> String {
    let mut expanded = value.to_string();
    for (key, replacement) in [
        ("APPDATA", env::var("APPDATA").unwrap_or_default()),
        ("LOCALAPPDATA", env::var("LOCALAPPDATA").unwrap_or_default()),
        ("ProgramFiles", env::var("ProgramFiles").unwrap_or_default()),
        ("ProgramFiles(x86)", env::var("ProgramFiles(x86)").unwrap_or_default()),
        ("USERPROFILE", env::var("USERPROFILE").unwrap_or_default()),
        ("SystemRoot", env::var("SystemRoot").unwrap_or_default()),
    ] {
        if !replacement.is_empty() {
            expanded = expanded.replace(&format!("%{key}%"), &replacement);
        }
    }
    expanded
}

fn find_installed_agent_config(current: &DesktopConfig) -> Option<DesktopConfig> {
    let mut roots = vec![PathBuf::from(&current.agent_root), default_agent_root()];
    roots.dedup();

    for root in roots {
        let path = root
            .join("apps")
            .join("agent-windows")
            .join("agent.config.json");
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(parsed) = serde_json::from_str::<InstalledAgentConfig>(&raw) {
                return Some(DesktopConfig {
                    server_url: parsed.server_url,
                    agent_id: parsed.agent_id,
                    agent_root: root.to_string_lossy().to_string(),
                });
            }
        }
    }

    None
}

fn save_token(agent_id: &str, token: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE_NAME, agent_id)
        .map_err(|error| format!("Could not open OS keychain: {error}"))?
        .set_password(token)
        .map_err(|error| format!("Could not save token in OS keychain: {error}"))
}

fn load_token(agent_id: &str) -> Option<String> {
    keyring::Entry::new(SERVICE_NAME, agent_id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

fn load_agent_token(agent_id: &str) -> Option<String> {
    load_token(agent_id).or_else(load_existing_agent_token)
}

fn load_existing_agent_token() -> Option<String> {
    std::env::var("CMC_AGENT_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(load_user_agent_token)
}

#[cfg(windows)]
fn load_user_agent_token() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey("Environment")
        .ok()
        .and_then(|key| key.get_value::<String, _>("CMC_AGENT_TOKEN").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(windows))]
fn load_user_agent_token() -> Option<String> {
    None
}

fn validate_agent_id(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.len() < 3 || trimmed.len() > 80 {
        return Err("Agent ID must be between 3 and 80 characters.".to_string());
    }
    if !trimmed
        .chars()
        .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
    {
        return Err("Agent ID may contain only letters, numbers, dash, and underscore.".to_string());
    }
    Ok(())
}

fn validate_server_url(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if !(trimmed.starts_with("wss://") || trimmed.starts_with("ws://")) {
        return Err("Server URL must start with ws:// or wss://.".to_string());
    }
    if !trimmed.ends_with("/api/agent/ws") {
        return Err("Server URL must point to /api/agent/ws.".to_string());
    }
    Ok(())
}

fn expand_home(value: &str) -> String {
    if value.is_empty() {
        return default_agent_root().to_string_lossy().to_string();
    }
    let home = home_dir().to_string_lossy().to_string();
    value
        .replace("%USERPROFILE%", &home)
        .replace("$HOME", &home)
        .replace('~', &home)
}

fn default_agent_root() -> PathBuf {
    home_dir().join("codex-agent")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local computer".to_string())
}

fn tray_icon_rgba() -> Vec<u8> {
    let mut pixels = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16 {
        for x in 0..16 {
            let border = x == 0 || y == 0 || x == 15 || y == 15;
            let accent = (x > 3 && x < 12 && y > 3 && y < 12) && (x + y) % 3 == 0;
            let (r, g, b, a) = if border {
                (36, 38, 43, 255)
            } else if accent {
                (0, 137, 93, 255)
            } else {
                (255, 254, 250, 255)
            };
            pixels.extend([r, g, b, a]);
        }
    }
    pixels
}
