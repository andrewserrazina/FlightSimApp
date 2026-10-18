//! Native side of the desktop <-> sim-bridge link.
//!
//! Security model (see docs/adr/ADR-001):
//! * The per-session token is generated here, written to the bridge's stdin, and used in the
//!   pipe `hello`. It is never sent to the webview, logged, or put on a command line.
//! * Transport is an OS named pipe (Windows) / Unix domain socket (dev), created by the bridge
//!   with `CurrentUserOnly`. There is no TCP/HTTP listener anywhere.
//! * The webview only receives already-framed JSON messages (validated again in TS against the
//!   versioned schema) and may only ask for two fixed commands, or pick one of the three known
//!   adapters (which restarts the bridge with a fresh token and pipe).

use std::{path::PathBuf, process::Stdio, time::Duration};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, Mutex},
};

const MAX_LINE_BYTES: usize = 64 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(180); // `dotnet run` may compile first in dev
const ADAPTERS: [&str; 3] = ["mock", "msfs2020", "msfs2024"];
const ALLOWED_COMMANDS: [&str; 2] = ["health.request", "adapter.reconnect"];

#[derive(Clone, Serialize)]
struct ShellStatus {
    state: &'static str,
    message: String,
    attempt: u32,
}

/// Outbound command queue to the currently connected bridge (None while disconnected), plus the
/// latest state-bearing messages so a webview that subscribes late can catch up.
pub struct BridgeHandle {
    tx: Mutex<Option<mpsc::Sender<String>>>,
    snapshot: std::sync::Mutex<Snapshot>,
    adapter: std::sync::Mutex<&'static str>,
    restart: tokio::sync::Notify,
    /// Bridge stderr is appended here (see bridge_log.rs); None if the log directory is unusable.
    log_path: Option<PathBuf>,
}

#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    shell: Option<ShellStatus>,
    /// Adapter the shell starts the bridge with (mock | msfs2020 | msfs2024).
    adapter: &'static str,
    /// Latest `hello.ok`, `connection.state` and `bridge.health` messages, in that order.
    messages: Vec<Value>,
}

const STICKY_TYPES: [&str; 4] = ["hello.ok", "connection.state", "bridge.health", "gsx.state"];

/// Current shell status and sticky bridge messages. The webview calls this once after it has
/// registered its event listeners, because events emitted before that are not delivered.
#[tauri::command]
pub fn bridge_snapshot(handle: State<'_, BridgeHandle>) -> Snapshot {
    handle.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
}

fn remember(app: &AppHandle, f: impl FnOnce(&mut Snapshot)) {
    if let Ok(mut snap) = app.state::<BridgeHandle>().snapshot.lock() {
        f(&mut snap);
    }
}

#[tauri::command]
pub async fn bridge_command(command: String, handle: State<'_, BridgeHandle>) -> Result<(), String> {
    if !ALLOWED_COMMANDS.contains(&command.as_str()) {
        return Err("unsupported command".into());
    }
    let line = serde_json::json!({
        "protocol": "flightsim.bridge",
        "protocol_version": 1,
        "type": command,
        "data": {}
    })
    .to_string();
    let guard = handle.tx.lock().await;
    match guard.as_ref() {
        Some(tx) => tx.send(line).await.map_err(|_| "bridge not connected".to_string()),
        None => Err("bridge not connected".into()),
    }
}

/// Select the simulator adapter. Only the three known adapter ids are accepted; a change
/// restarts the bridge process (new token, new pipe).
#[tauri::command]
pub fn bridge_select_adapter(adapter: String, app: AppHandle, handle: State<'_, BridgeHandle>) -> Result<(), String> {
    let Some(adapter) = ADAPTERS.into_iter().find(|a| *a == adapter) else {
        return Err("unsupported adapter".into());
    };
    {
        let mut current = handle.adapter.lock().map_err(|_| "state unavailable".to_string())?;
        if *current == adapter {
            return Ok(());
        }
        *current = adapter;
    }
    remember(&app, |snap| snap.adapter = adapter);
    handle.restart.notify_one();
    Ok(())
}

fn current_adapter(app: &AppHandle) -> &'static str {
    app.state::<BridgeHandle>().adapter.lock().map(|a| *a).unwrap_or("mock")
}

pub fn start(app: AppHandle, log_path: Option<PathBuf>) {
    let adapter = selected_adapter();
    app.manage(BridgeHandle {
        tx: Mutex::new(None),
        snapshot: std::sync::Mutex::new(Snapshot { adapter, ..Default::default() }),
        adapter: std::sync::Mutex::new(adapter),
        restart: tokio::sync::Notify::new(),
        log_path,
    });
    tauri::async_runtime::spawn(supervise(app));
}

fn emit_shell(app: &AppHandle, state: &'static str, message: impl Into<String>, attempt: u32) {
    let status = ShellStatus { state, message: message.into(), attempt };
    remember(app, |snap| {
        if state != "running" {
            snap.messages.clear(); // nothing from a dead bridge process is live any more
        }
        snap.shell = Some(status.clone());
    });
    let _ = app.emit("bridge://shell", status);
}

/// Keeps a bridge process alive for the lifetime of the app, restarting it with capped backoff.
async fn supervise(app: AppHandle) {
    let mut attempt: u32 = 0;
    loop {
        emit_shell(&app, if attempt == 0 { "starting" } else { "restarting" }, "Starting sim bridge…", attempt);
        let outcome = run_once(&app, attempt).await;
        set_sender(&app, None).await;
        attempt = attempt.saturating_add(1);
        let delay = Duration::from_secs(1u64 << attempt.min(5)).min(Duration::from_secs(30));
        match outcome {
            Ok(()) => emit_shell(&app, "restarting", "Sim bridge exited; restarting.", attempt),
            Err(BridgeError::Restart) => {
                attempt = 0; // deliberate adapter switch: restart immediately
                continue;
            }
            Err(BridgeError::Unavailable(msg)) => emit_shell(&app, "unavailable", msg, attempt),
            Err(BridgeError::Lost(msg)) => emit_shell(&app, "restarting", msg, attempt),
        }
        let handle = app.state::<BridgeHandle>();
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = handle.restart.notified() => attempt = 0,
        }
    }
}

enum BridgeError {
    /// The bridge could not be started at all (missing executable / runtime).
    Unavailable(String),
    /// The bridge started but the link was lost.
    Lost(String),
    /// The user selected a different adapter.
    Restart,
}

async fn set_sender(app: &AppHandle, tx: Option<mpsc::Sender<String>>) {
    *app.state::<BridgeHandle>().tx.lock().await = tx;
}

async fn run_once(app: &AppHandle, attempt: u32) -> Result<(), BridgeError> {
    let token = random_token();
    let pipe_name = format!("flightsim-{}", random_hex(8));
    let adapter = current_adapter(app);

    let mut child = spawn_bridge(adapter, &pipe_name).map_err(BridgeError::Unavailable)?;
    if let Some(stderr) = child.stderr.take() {
        match app.state::<BridgeHandle>().log_path.clone() {
            Some(path) => {
                let header = format!("=== {} bridge start: adapter={adapter} attempt={attempt} ===", crate::bridge_log::utc_now());
                tokio::spawn(crate::bridge_log::copy(stderr, path, header, token.clone(), crate::bridge_log::MAX_BYTES));
            }
            None => {
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(_)) = lines.next_line().await {}
                });
            }
        }
    }
    let mut stdin = child.stdin.take().ok_or_else(|| BridgeError::Unavailable("bridge stdin unavailable".into()))?;
    stdin
        .write_all(format!("{token}\n").as_bytes())
        .await
        .map_err(|e| BridgeError::Unavailable(format!("could not hand token to bridge: {e}")))?;
    stdin.flush().await.ok();
    // `stdin` stays open for the bridge's lifetime: closing it is the bridge's shutdown signal.

    let stdout = child.stdout.take().ok_or_else(|| BridgeError::Unavailable("bridge stdout unavailable".into()))?;
    let mut stdout = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(READY_TIMEOUT, async {
        while let Ok(Some(line)) = stdout.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("event").and_then(Value::as_str) == Some("ready") {
                    return v.get("pipe_name").and_then(Value::as_str) == Some(pipe_name.as_str());
                }
            }
        }
        false
    })
    .await;
    if !matches!(ready, Ok(true)) {
        let _ = child.kill().await;
        return Err(BridgeError::Unavailable("Sim bridge did not become ready. Is the .NET 8 runtime installed?".into()));
    }
    tokio::spawn(async move { while let Ok(Some(_)) = stdout.next_line().await {} });

    let (reader, mut writer) = connect_pipe(&pipe_name).await.map_err(BridgeError::Lost)?;
    let hello = serde_json::json!({
        "protocol": "flightsim.bridge",
        "protocol_version": 1,
        "type": "hello",
        "data": { "token": token, "client": "flightsim-desktop" }
    });
    writer
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .map_err(|e| BridgeError::Lost(format!("hello failed: {e}")))?;
    drop(token);

    let (tx, mut rx) = mpsc::channel::<String>(16);
    set_sender(app, Some(tx)).await;
    emit_shell(app, "running", "Sim bridge running.", attempt);

    let writer_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if writer.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let handle = app.state::<BridgeHandle>();
    let result = tokio::select! {
        r = relay(app, reader) => r,
        _ = handle.restart.notified() => Err(BridgeError::Restart),
        status = child.wait() => Err(BridgeError::Lost(format!("Sim bridge exited ({})", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string())))),
    };
    writer_task.abort();
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    let _ = child.kill().await;
    result
}

/// Forward bounded, well-framed bridge messages to the webview.
async fn relay(app: &AppHandle, reader: Box<dyn AsyncRead + Unpin + Send>) -> Result<(), BridgeError> {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::with_capacity(4096);
    loop {
        buf.clear();
        let n = (&mut reader)
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut buf)
            .await
            .map_err(|e| BridgeError::Lost(format!("bridge read failed: {e}")))?;
        if n == 0 {
            return Err(BridgeError::Lost("Sim bridge closed the connection.".into()));
        }
        if buf.len() > MAX_LINE_BYTES {
            return Err(BridgeError::Lost("Sim bridge sent an oversize message.".into()));
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
        if msg.get("protocol").and_then(Value::as_str) != Some("flightsim.bridge") {
            continue;
        }
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
        if kind == "hello" {
            continue; // never reflect credentials-bearing message types
        }
        if let Some(slot) = STICKY_TYPES.iter().position(|t| *t == kind) {
            remember(app, |snap| {
                snap.messages.retain(|m| m.get("type").and_then(Value::as_str) != Some(STICKY_TYPES[slot]));
                snap.messages.push(msg.clone());
                snap.messages.sort_by_key(|m| {
                    let t = m.get("type").and_then(Value::as_str).unwrap_or_default();
                    STICKY_TYPES.iter().position(|s| *s == t)
                });
            });
        }
        let unauthorized = kind == "error"
            && msg.pointer("/data/code").and_then(Value::as_str) == Some("unauthorized");
        let _ = app.emit("bridge://message", &msg);
        if unauthorized {
            return Err(BridgeError::Lost("Sim bridge rejected authentication.".into()));
        }
    }
}

/// Initial adapter from FLIGHTSIM_BRIDGE_ADAPTER (dev override); the UI may change it later.
fn selected_adapter() -> &'static str {
    let wanted = std::env::var("FLIGHTSIM_BRIDGE_ADAPTER").unwrap_or_default();
    ADAPTERS.into_iter().find(|a| *a == wanted).unwrap_or("mock")
}

fn spawn_bridge(adapter: &str, pipe_name: &str) -> Result<Child, String> {
    let mut bridge_args = vec!["--adapter".to_string(), adapter.to_string(), "--pipe-name".to_string(), pipe_name.to_string()];
    // Dev/test hook: start the mock demo flight part-way through (simulates the simulator having
    // kept flying while the app was closed). Ignored for real simulators.
    if adapter == "mock" {
        if let Some(offset) = std::env::var("FLIGHTSIM_MOCK_START_OFFSET_S").ok().and_then(|v| v.parse::<u32>().ok()).filter(|v| *v <= 86_400) {
            bridge_args.extend(["--mock-start-offset-s".to_string(), offset.to_string()]);
        }
    }
    let mut cmd = match std::env::var("FLIGHTSIM_BRIDGE_PATH").ok().filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            let mut c = Command::new(path);
            c.args(&bridge_args);
            c
        }
        None if cfg!(debug_assertions) => {
            // Dev: build and run the bridge from source.
            let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../services/sim-bridge/src/FlightSim.SimBridge.Host");
            let mut c = Command::new("dotnet");
            c.arg("run").arg("--project").arg(project).arg("--").args(&bridge_args);
            c
        }
        None => {
            // Release: sidecar bundled next to the app executable (tauri.bundle.conf.json externalBin).
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let name = if cfg!(windows) { "flightsim-sim-bridge.exe" } else { "flightsim-sim-bridge" };
            let mut c = Command::new(exe.with_file_name(name));
            c.args(&bridge_args);
            c
        }
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("Could not start sim bridge: {e}"))
}

type PipeHalves = (Box<dyn AsyncRead + Unpin + Send>, Box<dyn AsyncWrite + Unpin + Send>);

async fn connect_pipe(name: &str) -> Result<PipeHalves, String> {
    let mut last_err = String::new();
    for _ in 0..50 {
        match open_pipe(name).await {
            Ok(halves) => return Ok(halves),
            Err(e) => last_err = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("could not connect to bridge pipe: {last_err}"))
}

#[cfg(windows)]
async fn open_pipe(name: &str) -> std::io::Result<PipeHalves> {
    let client = tokio::net::windows::named_pipe::ClientOptions::new().open(format!(r"\\.\pipe\{name}"))?;
    let (r, w) = tokio::io::split(client);
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(unix)]
async fn open_pipe(name: &str) -> std::io::Result<PipeHalves> {
    // .NET maps named pipes to Unix domain sockets at $TMPDIR/CoreFxPipe_<name>.
    let path = std::env::temp_dir().join(format!("CoreFxPipe_{name}"));
    let stream = tokio::net::UnixStream::connect(path).await?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    bytes
}

fn random_token() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

fn random_hex(n: usize) -> String {
    random_bytes::<16>()[..n.min(16)].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_43_url_safe_chars() {
        let t = random_token();
        assert_eq!(t.len(), 43);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(t, random_token());
    }

    #[test]
    fn pipe_suffix_is_hex() {
        let h = random_hex(8);
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn only_known_adapters_are_selected() {
        std::env::set_var("FLIGHTSIM_BRIDGE_ADAPTER", "../../evil");
        assert_eq!(selected_adapter(), "mock");
        std::env::set_var("FLIGHTSIM_BRIDGE_ADAPTER", "msfs2024");
        assert_eq!(selected_adapter(), "msfs2024");
        std::env::remove_var("FLIGHTSIM_BRIDGE_ADAPTER");
    }
}
