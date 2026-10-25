//! Native-only, opt-in SimuNet telemetry sender. No webview network access.
//! Builds without a configured destination, but NEVER sends until the build's
//! SIMUNET_HTTPS_ORIGIN is set to an approved HTTPS origin.
use std::{
    future::Future,
    pin::Pin,
    sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock},
    time::{Duration, Instant},
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::{futures::Notified, Mutex as AsyncMutex, Notify};

const DESTINATION: Option<&str> = option_env!("SIMUNET_HTTPS_ORIGIN");
const MIN_INTERVAL: Duration = Duration::from_secs(5);
const MAX_AGE: i64 = 60;
const MAX_FUTURE_SECONDS: i64 = 15;
const MAX_BODY_BYTES: usize = 4096;
/// SimuNet answers with three counters; anything larger is not a valid reply and is not buffered.
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);

/// Coarse, privacy-safe outcome codes. Serialized as snake_case strings for the webview; they carry
/// no credential, URL, response body or environment detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SendError {
    NotConfigured,
    InvalidFrame,
    UnsupportedSource,
    StaleFrame,
    TooLarge,
    RateLimited,
    Disabled,
    CredentialUnavailable,
    /// Consent was withdrawn or the credential replaced or disconnected while the request was in flight.
    Cancelled,
    Network,
    Unauthorized,
    ServerRateLimited,
    Redirected,
    Rejected,
    InvalidResponse,
}

#[derive(Debug, Deserialize, Serialize)]
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
    parse_destination(DESTINATION?)
}

fn parse_destination(value: &str) -> Option<reqwest::Url> {
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
        || host.ends_with(".localhost") || host.starts_with('[')
        || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(url)
}

pub fn sender_configured() -> bool { destination().is_some() }

fn validate_frame(frame: &Frame) -> Result<(), SendError> {
    if frame.session_id.len() > 128 || frame.session_id.is_empty()
        || !frame.lat.is_finite() || !frame.lon.is_finite()
        || !(-90.0..=90.0).contains(&frame.lat)
        || !(-180.0..=180.0).contains(&frame.lon)
        || frame.alt.is_some_and(|n| !n.is_finite())
        || frame.speed.is_some_and(|n| !n.is_finite() || n < 0.0)
        || frame.heading.is_some_and(|n| !n.is_finite() || !(0.0..360.0).contains(&n))
    { return Err(SendError::InvalidFrame); }
    let simulator = frame.sim.get("simulator").and_then(|x| x.as_str());
    if frame.sim.get("source").and_then(|x| x.as_str()) != Some("turnline")
        || !matches!(simulator, Some("msfs2020" | "msfs2024")) {
        return Err(SendError::UnsupportedSource);
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&frame.ts).map_err(|_| SendError::InvalidFrame)?;
    let age = chrono::Utc::now().signed_duration_since(parsed.with_timezone(&chrono::Utc)).num_seconds();
    if !(-MAX_FUTURE_SECONDS..=MAX_AGE).contains(&age) { return Err(SendError::StaleFrame); }
    Ok(())
}

// ---------------------------------------------------------------- revocation

static REVOCATION_EPOCH: AtomicU64 = AtomicU64::new(0);

fn revocation() -> &'static Notify {
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    NOTIFY.get_or_init(Notify::new)
}

/// Withdraws permission for every request already started: called when consent is turned off and
/// when the credential is replaced or disconnected. An in-flight request is dropped (its connection
/// closed) and its result discarded, so nothing sent under the old permission is reported as sent.
pub(crate) fn revoke_in_flight() {
    REVOCATION_EPOCH.fetch_add(1, Ordering::SeqCst);
    revocation().notify_waiters();
}

/// Taken before the credential is read, so a revocation at any later point is observed.
struct Permission {
    epoch: u64,
    notified: Pin<Box<Notified<'static>>>,
}

impl Permission {
    fn begin() -> Self {
        let mut notified = Box::pin(revocation().notified());
        // Register before reading the epoch: a revocation after this point either changes the
        // epoch we read or wakes `notified`.
        notified.as_mut().enable();
        Self { epoch: REVOCATION_EPOCH.load(Ordering::SeqCst), notified }
    }

    fn revoked(&self) -> bool {
        REVOCATION_EPOCH.load(Ordering::SeqCst) != self.epoch
    }

    async fn run<T>(mut self, work: impl Future<Output = Result<T, SendError>>) -> Result<T, SendError> {
        if self.revoked() { return Err(SendError::Cancelled); }
        let out = tokio::select! {
            biased;
            _ = self.notified.as_mut() => return Err(SendError::Cancelled),
            out = work => out,
        };
        if self.revoked() { Err(SendError::Cancelled) } else { out }
    }
}

// ---------------------------------------------------------------- transport

fn http_client() -> Result<reqwest::Client, SendError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| SendError::Network)
}

/// Reads at most `limit` bytes of a response body; a longer body is refused, not buffered.
async fn read_capped(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, SendError> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(SendError::InvalidResponse);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| SendError::Network)? {
        if body.len() + chunk.len() > limit { return Err(SendError::InvalidResponse); }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// One POST of an already validated, serialized batch. The key travels only in the header.
async fn deliver(client: &reqwest::Client, endpoint: reqwest::Url, key: &str, body: Vec<u8>) -> Result<SendResult, SendError> {
    let response = client.post(endpoint)
        .header("x-api-key", key)
        .header("content-type", "application/json")
        .body(body)
        .send().await.map_err(|_| SendError::Network)?;
    let status = response.status();
    if status.is_redirection() { return Err(SendError::Redirected); }
    if status.as_u16() == 401 || status.as_u16() == 403 { return Err(SendError::Unauthorized); }
    if status.as_u16() == 429 { return Err(SendError::ServerRateLimited); }
    if !status.is_success() { return Err(SendError::Rejected); }
    let body = read_capped(response, MAX_RESPONSE_BYTES).await?;
    let result: serde_json::Value = serde_json::from_slice(&body).map_err(|_| SendError::InvalidResponse)?;
    if !result.is_object() { return Err(SendError::InvalidResponse); }
    let count = |name: &str| result[name].as_u64().unwrap_or(0);
    Ok(SendResult { accepted: count("accepted"), duplicates: count("duplicates"), rejected: count("rejected") })
}

#[tauri::command]
pub async fn simunet_telemetry_send(
    frame: Frame,
    state: State<'_, SenderState>,
) -> Result<SendResult, SendError> {
    // No token or destination is accepted from JavaScript.
    let url = destination().ok_or(SendError::NotConfigured)?;
    validate_frame(&frame)?;
    let _guard = state.gate.lock().await;
    {
        let last = state.last.lock().map_err(|_| SendError::Network)?;
        if last.is_some_and(|at| at.elapsed() < MIN_INTERVAL) {
            return Err(SendError::RateLimited);
        }
    }
    let permission = Permission::begin();
    let key = crate::secure::simunet_sender_key()
        .map_err(|_| SendError::CredentialUnavailable)?
        .ok_or(SendError::Disabled)?;
    let body = serde_json::to_vec(&vec![&frame]).map_err(|_| SendError::InvalidFrame)?;
    if body.len() > MAX_BODY_BYTES { return Err(SendError::TooLarge); }
    {
        let mut last = state.last.lock().map_err(|_| SendError::Network)?;
        *last = Some(Instant::now());
    }
    let endpoint = url.join("v1/telemetry").map_err(|_| SendError::NotConfigured)?;
    let client = http_client()?;
    permission.run(deliver(&client, endpoint, &key, body)).await
}

/// Explicit operator-initiated, read-only auth test. No telemetry, job claim,
/// heartbeat, or economy transaction is created by this GET request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub state: &'static str,
    pub message: &'static str,
}

#[tauri::command]
pub async fn simunet_connection_test() -> ConnectionTestResult {
    let failed = |state, message| ConnectionTestResult { state, message };
    let Some(url) = destination() else {
        return failed("not_configured", "No approved HTTPS endpoint is configured in this build.");
    };
    let key = match crate::secure::simunet_probe_key() {
        Ok(Some(value)) => value,
        Ok(None) => return failed("missing_credential", "Save an operator API key before testing."),
        Err(_) => return failed("credential_unavailable", "Secure credential storage is unavailable."),
    };
    let endpoint = match url.join("v1/connectors/status") {
        Ok(value) => value,
        Err(_) => return failed("not_configured", "Invalid approved endpoint configuration."),
    };
    let Ok(client) = http_client() else {
        return failed("unreachable", "Could not initialize the secure HTTPS connection.");
    };
    match client.get(endpoint).header("x-api-key", key).send().await {
        Ok(response) if response.status().is_success() =>
            failed("connected", "SimuNet authenticated this operator. No flight telemetry was sent."),
        Ok(response) if response.status().as_u16() == 401 || response.status().as_u16() == 403 =>
            failed("unauthorized", "SimuNet rejected the operator credential."),
        Ok(response) if response.status().is_redirection() =>
            failed("endpoint_error", "The staging endpoint redirected unexpectedly."),
        Ok(_) => failed("endpoint_error", "SimuNet returned an unexpected response."),
        Err(_) => failed("unreachable", "Could not reach the approved SimuNet API over HTTPS."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const KEY: &str = "test-operator-key-not-real";

    /// Minimal local HTTP/1.1 server: records each raw request and answers with `reply`
    /// after `delay`. Plain HTTP on 127.0.0.1, so no TLS and nothing leaves the machine.
    async fn mock_server(reply: String, delay: Duration) -> (reqwest::Url, Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/v1/telemetry", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let (seen, count) = (requests.clone(), hits.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                count.fetch_add(1, Ordering::SeqCst);
                let (reply, seen) = (reply.clone(), seen.clone());
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        let Ok(n) = socket.read(&mut buf).await else { return };
                        if n == 0 { return; }
                        raw.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&raw).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end].lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                                .unwrap_or(0);
                            if raw.len() >= end + 4 + length { break; }
                        }
                    }
                    seen.lock().unwrap().push(String::from_utf8_lossy(&raw).to_string());
                    tokio::time::sleep(delay).await;
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (url, requests, hits)
    }

    fn reply(status: &str, extra_headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra_headers}\r\n{body}", body.len())
    }

    fn frame(ts: String) -> Frame {
        serde_json::from_value(serde_json::json!({
            "session_id": "session-1234", "ts": ts, "lat": 42.36, "lon": -71.0,
            "alt": 1000.0, "speed": 250.0, "heading": 90.0,
            "sim": { "source": "turnline", "simulator": "msfs2020", "source_sequence": 7 }
        })).unwrap()
    }

    fn body() -> Vec<u8> {
        serde_json::to_vec(&vec![frame(chrono::Utc::now().to_rfc3339())]).unwrap()
    }

    #[test]
    fn only_a_plain_public_https_origin_is_accepted() {
        assert!(parse_destination("https://api.example.com").is_some());
        assert!(parse_destination("https://api.example.com/").is_some());
        for bad in [
            "http://api.example.com", "https://api.example.com:8443", "https://api.example.com/v1",
            "https://api.example.com/?x=1", "https://api.example.com/#f", "https://user:pw@api.example.com",
            "https://localhost", "https://api.localhost", "https://printer.local", "https://svc.internal",
            "https://127.0.0.1", "https://10.0.0.5", "https://[::1]", "https://intranet", "not a url", "",
        ] {
            assert!(parse_destination(bad).is_none(), "accepted {bad}");
        }
    }

    #[test]
    fn frames_are_validated_before_any_credential_or_network_use() {
        let now = chrono::Utc::now();
        assert_eq!(validate_frame(&frame(now.to_rfc3339())), Ok(()));
        assert_eq!(validate_frame(&frame((now - chrono::Duration::seconds(90)).to_rfc3339())), Err(SendError::StaleFrame));
        assert_eq!(validate_frame(&frame((now + chrono::Duration::seconds(60)).to_rfc3339())), Err(SendError::StaleFrame));
        assert_eq!(validate_frame(&frame("yesterday".into())), Err(SendError::InvalidFrame));
        let mut f = frame(now.to_rfc3339());
        f.sim["simulator"] = "mock".into();
        assert_eq!(validate_frame(&f), Err(SendError::UnsupportedSource));
        let mut f = frame(now.to_rfc3339());
        f.sim["source"] = "other".into();
        assert_eq!(validate_frame(&f), Err(SendError::UnsupportedSource));
        for (lat, lon, heading) in [(91.0, 0.0, 0.0), (0.0, 181.0, 0.0), (f64::NAN, 0.0, 0.0), (0.0, 0.0, 360.0)] {
            let mut f = frame(now.to_rfc3339());
            (f.lat, f.lon, f.heading) = (lat, lon, Some(heading));
            assert_eq!(validate_frame(&f), Err(SendError::InvalidFrame));
        }
    }

    #[test]
    fn error_codes_serialize_as_plain_strings() {
        assert_eq!(serde_json::to_string(&SendError::ServerRateLimited).unwrap(), "\"server_rate_limited\"");
        assert_eq!(serde_json::to_string(&SendError::Cancelled).unwrap(), "\"cancelled\"");
    }

    #[tokio::test]
    async fn delivers_with_the_key_only_in_the_header_and_reads_the_counters() {
        let (url, requests, _) = mock_server(reply("200 OK", "", r#"{"accepted":1,"duplicates":0,"rejected":0}"#), Duration::ZERO).await;
        let result = deliver(&http_client().unwrap(), url, KEY, body()).await.unwrap();
        assert_eq!((result.accepted, result.duplicates, result.rejected), (1, 0, 0));
        let raw = requests.lock().unwrap()[0].clone();
        let (head, payload) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /v1/telemetry HTTP/1.1"));
        assert!(head.to_ascii_lowercase().contains(&format!("x-api-key: {KEY}")));
        assert!(!head.lines().next().unwrap().contains(KEY), "key in the request line");
        assert!(!payload.contains(KEY), "key in the body");
        assert!(payload.starts_with("[{") && payload.contains("\"source\":\"turnline\""));
    }

    #[tokio::test]
    async fn maps_http_statuses_to_coarse_codes() {
        for (status, expected) in [
            ("401 Unauthorized", SendError::Unauthorized),
            ("403 Forbidden", SendError::Unauthorized),
            ("429 Too Many Requests", SendError::ServerRateLimited),
            ("500 Internal Server Error", SendError::Rejected),
            ("400 Bad Request", SendError::Rejected),
        ] {
            let (url, _, _) = mock_server(reply(status, "", r#"{"error":"detail that must not surface"}"#), Duration::ZERO).await;
            assert_eq!(deliver(&http_client().unwrap(), url, KEY, body()).await.unwrap_err(), expected, "{status}");
        }
    }

    #[tokio::test]
    async fn never_follows_a_redirect_so_the_key_cannot_be_forwarded() {
        let (elsewhere, _, elsewhere_hits) = mock_server(reply("200 OK", "", "{}"), Duration::ZERO).await;
        for status in ["301 Moved Permanently", "302 Found", "307 Temporary Redirect", "308 Permanent Redirect"] {
            let (url, _, _) = mock_server(reply(status, &format!("location: {elsewhere}\r\n"), ""), Duration::ZERO).await;
            assert_eq!(deliver(&http_client().unwrap(), url, KEY, body()).await.unwrap_err(), SendError::Redirected, "{status}");
        }
        assert_eq!(elsewhere_hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn refuses_oversized_or_malformed_replies() {
        let huge = format!("{{\"accepted\":1,\"pad\":\"{}\"}}", "x".repeat(MAX_RESPONSE_BYTES));
        for body_text in [huge.as_str(), "not json", "[1,2,3]"] {
            let (url, _, _) = mock_server(reply("200 OK", "", body_text), Duration::ZERO).await;
            assert_eq!(deliver(&http_client().unwrap(), url, KEY, body()).await.unwrap_err(), SendError::InvalidResponse);
        }
        // A body longer than the limit without a content-length header is cut off while reading.
        let chunked = format!("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n{}", "x".repeat(MAX_RESPONSE_BYTES + 1));
        let (url, _, _) = mock_server(chunked, Duration::ZERO).await;
        assert_eq!(deliver(&http_client().unwrap(), url, KEY, body()).await.unwrap_err(), SendError::InvalidResponse);
    }

    #[tokio::test]
    async fn an_unreachable_endpoint_is_a_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/v1/telemetry", listener.local_addr().unwrap())).unwrap();
        drop(listener);
        assert_eq!(deliver(&http_client().unwrap(), url, KEY, body()).await.unwrap_err(), SendError::Network);
    }

    /// All revocation cases live in one test: the revocation signal is process-wide, so running
    /// them in parallel with each other would let one case cancel another's request.
    #[tokio::test]
    async fn revoking_consent_stops_a_request_in_flight_and_discards_its_result() {
        // 1. Revoked while the server is still answering: the request is dropped promptly.
        let (url, _, _) = mock_server(reply("200 OK", "", r#"{"accepted":1}"#), Duration::from_secs(3)).await;
        let permission = Permission::begin();
        let client = http_client().unwrap();
        let started = Instant::now();
        let task = tokio::spawn(async move { permission.run(deliver(&client, url, KEY, body())).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        revoke_in_flight();
        assert_eq!(task.await.unwrap().unwrap_err(), SendError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2), "not cancelled promptly");

        // 2. Revoked after permission was taken but before the request starts: nothing is sent.
        let (url, _, hits) = mock_server(reply("200 OK", "", r#"{"accepted":1}"#), Duration::ZERO).await;
        let permission = Permission::begin();
        revoke_in_flight();
        let client = http_client().unwrap();
        assert_eq!(permission.run(deliver(&client, url, KEY, body())).await.unwrap_err(), SendError::Cancelled);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        // 3. Revoked while the result is being produced: the success is discarded.
        let permission = Permission::begin();
        let result = permission.run(async {
            revoke_in_flight();
            Ok::<_, SendError>(SendResult { accepted: 1, duplicates: 0, rejected: 0 })
        }).await;
        assert_eq!(result.unwrap_err(), SendError::Cancelled);

        // 4. Without a revocation the result comes through.
        let (url, _, _) = mock_server(reply("200 OK", "", r#"{"accepted":2,"duplicates":1}"#), Duration::ZERO).await;
        let client = http_client().unwrap();
        let ok = Permission::begin().run(deliver(&client, url, KEY, body())).await.unwrap();
        assert_eq!((ok.accepted, ok.duplicates), (2, 1));
    }
}
