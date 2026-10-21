//! SimuNet telemetry sender: fixed localhost **development** target only.
//! No production hostname is assumed or accepted in this review-only stage.
//! Key never leaves Rust; opt-in is rechecked for every POST. No redirects.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEV_URL: &str = "http://127.0.0.1:8000/v1/telemetry";
const MIN_INTERVAL: Duration = Duration::from_secs(5);
const MAX_FRAME_AGE: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 2048;

static LAST_SEND: Mutex<Option<(String, u64, Instant)>> = Mutex::new(None);

#[derive(Deserialize)]
pub struct Frame {
    session_id: String,
    ts: String,
    lat: f64,
    lon: f64,
    alt: Option<f64>,
    speed: Option<f64>,
    heading: Option<f64>,
    sim: SimInfo,
}

#[derive(Deserialize)]
struct SimInfo {
    source: String,
    simulator: String,
    source_sequence: u64,
    on_ground: Option<bool>,
    ground_speed_kt: Option<f64>,
    indicated_airspeed_kt: Option<f64>,
    vertical_speed_fpm: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub accepted: bool,
    pub status: String,
}

fn validate(frame: &Frame) -> Result<(), &'static str> {
    if frame.sim.source != "turnline"
        || !matches!(frame.sim.simulator.as_str(), "msfs2020" | "msfs2024")
        || frame.session_id.len() < 8 || frame.session_id.len() > 128
        || !frame.lat.is_finite() || !frame.lon.is_finite()
        || frame.lat.abs() > 90.0 || frame.lon.abs() > 180.0
        || [frame.alt, frame.speed, frame.heading, frame.sim.ground_speed_kt,
            frame.sim.indicated_airspeed_kt, frame.sim.vertical_speed_fpm]
            .iter().flatten().any(|v| !v.is_finite())
    {
        return Err("invalid-frame");
    }
    let time = chrono::DateTime::parse_from_rfc3339(&frame.ts).map_err(|_| "invalid-time")?;
    let age = chrono::Utc::now().signed_duration_since(time.with_timezone(&chrono::Utc));
    if age.num_seconds() < -5 || age.to_std().map_or(true, |a| a > MAX_FRAME_AGE) {
        return Err("stale-frame");
    }
    Ok(())
}

fn throttle(frame: &Frame) -> Result<(), &'static str> {
    let mut last = LAST_SEND.lock().map_err(|_| "sender-unavailable")?;
    if let Some((session, sequence, when)) = last.as_ref() {
        if session == &frame.session_id {
            if frame.sim.source_sequence <= *sequence { return Err("duplicate-frame"); }
            if when.elapsed() < MIN_INTERVAL { return Err("rate-limited"); }
        }
    }
    *last = Some((frame.session_id.clone(), frame.sim.source_sequence, Instant::now()));
    Ok(())
}

/// Called with a single *fresh* bridge frame, never stored flight history.
/// Only local test API is permitted. Does not allow caller-controlled URLs.
#[tauri::command]
pub async fn simunet_send_dev_frame(frame: serde_json::Value) -> Result<SendResult, String> {
    // Parse strictly and reject oversized payloads before any credential access.
    let raw = serde_json::to_vec(&frame).map_err(|_| "invalid-frame".to_string())?;
    if raw.len() > MAX_BODY_BYTES { return Err("invalid-frame".into()); }
    let parsed: Frame = serde_json::from_slice(&raw).map_err(|_| "invalid-frame".to_string())?;
    validate(&parsed).map_err(str::to_string)?;
    // Recheck consent *at send time*, so disabling sharing immediately blocks
    // all future calls even if a UI component still has a stale enabled flag.
    let key = crate::secure::simunet_sender_key()
        .map_err(|_| "secure-storage-unavailable".to_string())?
        .ok_or_else(|| "telemetry-disabled".to_string())?;
    throttle(&parsed).map_err(str::to_string)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .no_proxy()
        .build().map_err(|_| "sender-unavailable".to_string())?;
    let response = client.post(DEV_URL)
        .header("x-api-key", key)
        .header("content-type", "application/json")
        .body(raw)
        .send().await.map_err(|_| "network-unavailable".to_string())?;
    let status = response.status();
    Ok(SendResult {
        accepted: status.is_success(),
        status: if status.is_success() { "accepted" }
            else if status.as_u16() == 401 || status.as_u16() == 403 { "unauthorized" }
            else if status.as_u16() == 429 { "rate-limited" }
            else { "rejected" }.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_is_loopback_and_not_client_controlled() {
        assert_eq!(DEV_URL, "http://127.0.0.1:8000/v1/telemetry");
    }
    #[test]
    fn stale_or_mock_frames_rejected() {
        let mut f: Frame = serde_json::from_value(serde_json::json!({
            "session_id":"12345678", "ts":"2020-01-01T00:00:00Z",
            "lat":42.0,"lon":-71.0,"alt":1000.0,"speed":100.0,"heading":90.0,
            "sim":{"source":"turnline","simulator":"msfs2020","source_sequence":1,
            "on_ground":false,"ground_speed_kt":100.0,"indicated_airspeed_kt":100.0,
            "vertical_speed_fpm":0.0}
        })).unwrap();
        assert_eq!(validate(&f),Err("stale-frame"));
        f.ts=chrono::Utc::now().to_rfc3339();
        f.sim.simulator="mock".into();
        assert_eq!(validate(&f),Err("invalid-frame"));
        f.sim.simulator="msfs2024".into();
        f.lat=999.0;
        assert_eq!(validate(&f),Err("invalid-frame"));
    }
}
