//! Native-only, opt-in SimuNet telemetry sender. No webview network access.
//! Builds without a configured destination, but NEVER sends until the build's
//! SIMUNET_HTTPS_ORIGIN is set to an approved HTTPS origin.
use std::{sync::Mutex, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

const DESTINATION: Option<&str> = option_env!("SIMUNET_HTTPS_ORIGIN");
const MIN_INTERVAL: Duration = Duration::from_secs(5);
const MAX_AGE: i64 = 60;
const MAX_FUTURE_SECONDS: i64 = 15;
const MAX_BODY_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
pub struct Frame {
    session_id: String,
    ts: String,
    lat: f64,
    lon: f64,
    alt: Option<f64>,
    speed: Option<f64>,
    heading: Option<f64>,
    sim: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: u64,
}

pub struct SenderState {
    // Prevent overlapping submissions and hard-limit network call frequency.
    gate: AsyncMutex<()>,
    last: Mutex<Option<Instant>>,
}

impl Default for SenderState {
    fn default() -> Self { Self { gate: AsyncMutex::new(()), last: Mutex::new(None) } }
}

fn destination() -> Option<reqwest::Url> {
    let value = DESTINATION?;
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https" || url.host_str().is_none()
        || url.port().is_some() || url.username() != "" || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || url.path() != "/" {
        return None;
    }
    // Disallow localhost/IP literals, privately resolvable shortcuts, and
    // malformed/missing public DNS domains. Deployment must supply approved
    // build-time hostname, never arbitrary user input from the webview.
    let host = url.host_str()?;
    if !host.contains('.') || host.ends_with(".local") || host.ends_with(".internal")
        || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(url)
}

pub fn sender_configured() -> bool { destination().is_some() }

fn validate_frame(frame: &Frame) -> Result<(), &'static str> {
    if frame.session_id.len() > 128 || frame.session_id.is_empty()
        || !frame.lat.is_finite() || !frame.lon.is_finite()
        || !(-90.0..=90.0).contains(&frame.lat)
        || !(-180.0..=180.0).contains(&frame.lon)
        || frame.alt.is_some_and(|n| !n.is_finite())
        || frame.speed.is_some_and(|n| !n.is_finite() || n < 0.0)
        || frame.heading.is_some_and(|n| !n.is_finite() || !(0.0..360.0).contains(&n))
    { return Err("Invalid telemetry fields"); }
    let simulator = frame.sim.get("simulator").and_then(|x| x.as_str());
    if frame.sim.get("source").and_then(|x| x.as_str()) != Some("turnline")
        || !matches!(simulator, Some("msfs2020" | "msfs2024")) {
        return Err("Unsupported telemetry source");
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&frame.ts).map_err(|_| "Invalid timestamp")?;
    let age = chrono::Utc::now().signed_duration_since(parsed.with_timezone(&chrono::Utc)).num_seconds();
    if !(-MAX_FUTURE_SECONDS..=MAX_AGE).contains(&age) { return Err("Stale telemetry"); }
    Ok(())
}

#[tauri::command]
pub async fn simunet_telemetry_send(
    frame: Frame,
    state: State<'_, SenderState>,
) -> Result<SendResult, String> {
    // No token or destination is accepted from JavaScript.
    let url = destination().ok_or("SimuNet sender is not configured in this build")?;
    validate_frame(&frame).map_err(str::to_owned)?;
    let _guard = state.gate.lock().await;
    {
        let last = state.last.lock().map_err(|_| "Sender unavailable")?;
        if last.is_some_and(|at| at.elapsed() < MIN_INTERVAL) {
            return Err("Telemetry is rate limited".into());
        }
    }
    let key = crate::secure::simunet_sender_key()
        .map_err(|_| "SimuNet credential unavailable")?
        .ok_or("SimuNet integration disabled or disconnected")?;
    let body = serde_json::to_vec(&vec![&frame]).map_err(|_| "Invalid telemetry")?;
    if body.len() > MAX_BODY_BYTES { return Err("Telemetry exceeds limit".into()); }
    {
        let mut last = state.last.lock().map_err(|_| "Sender unavailable")?;
        *last = Some(Instant::now());
    }
    let endpoint = url.join("v1/telemetry").map_err(|_| "Invalid SimuNet endpoint")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(6))
        .build().map_err(|_| "Unable to prepare HTTPS sender")?;
    let response = client.post(endpoint)
        .header("x-api-key", key)
        .header("content-type", "application/json")
        .body(body)
        .send().await.map_err(|_| "SimuNet connection failed")?;
    if !response.status().is_success() { return Err(format!("SimuNet rejected telemetry (HTTP {})", response.status().as_u16())); }
    let result = response.json::<serde_json::Value>().await.map_err(|_| "Invalid SimuNet response")?;
    Ok(SendResult {
        accepted: result["accepted"].as_u64().unwrap_or(0),
        duplicates: result["duplicates"].as_u64().unwrap_or(0),
        rejected: result["rejected"].as_u64().unwrap_or(0),
    })
}
