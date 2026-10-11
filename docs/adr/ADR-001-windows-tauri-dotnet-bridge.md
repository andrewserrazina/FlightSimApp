# ADR-001: Windows desktop = Tauri 2 shell + out-of-process .NET sim bridge

Status: accepted (Sprint 1A) · Date: 2026-10-10

## Context
SimConnect is a Windows, C/C++/.NET SDK whose calls are not safe to dispatch concurrently.
Microsoft recommends out-of-process clients. The UI should be web technology (React/TS) and
must stay alive if the simulator, SDK or bridge misbehaves.

## Decision
- `apps/desktop`: Tauri 2 (Rust) + React/TypeScript webview.
- `services/sim-bridge`: .NET 8 sidecar process, spawned and supervised by the Rust shell.
- All SimConnect access goes through one `SimConnectOwnerThread`; nothing else touches the SDK.
- MSFS 2020/2024 differences live in `IMsfsCompatibilityProfile` implementations.
- The real SDK client (`ManagedSimConnectClient.cs`) only compiles with `-p:SimConnectSdkDir=...`.
  Without it the bridge still builds and reports `sdk_unavailable`, which is a supported state.

## Local IPC security
- Transport: OS named pipe (Windows) / Unix domain socket (dev), created with
  `PipeOptions.CurrentUserOnly`, one client at a time. **No TCP/HTTP listener exists**, so no
  browser origin can reach it and CORS does not apply.
- Auth: the Rust shell generates a 256-bit token per bridge process and writes it to the
  bridge's **stdin** (never argv or env, both readable by other local processes). The first pipe
  message must be `hello` with that token, checked in constant time within 5 s, or the
  connection is closed.
- The token never leaves Rust: the webview gets only framed bridge messages (re-validated
  against the JSON Schemas) and may only send `health.request` / `adapter.reconnect`.
- The bridge exits when its stdin closes, so it cannot outlive the desktop app.
- Bounded line size (64 KiB), bounded outbound queue, malformed-message budget.

## Consequences
- The bridge needs the .NET 8 runtime (or a self-contained publish) on user machines.
- Real-simulator behaviour must be verified on Windows with MSFS installed; CI cannot do it.
