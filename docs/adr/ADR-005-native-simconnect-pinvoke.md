# ADR-005: Native SimConnect (P/Invoke) instead of the managed SDK wrapper

Status: accepted (S1-06)

## Context
Through S1-05 the bridge targeted the managed wrapper `Microsoft.FlightSimulator.SimConnect.dll`. That assembly
ships only inside the MSFS SDK installer. It cannot be restored from NuGet or used in CI, so
`ManagedSimConnectClient.cs` was behind a compile flag and **had never been compiled** anywhere. S1-06 requires
compiling the real adapter and validating it as far as possible without MSFS.

## Decision
- **Bind the SimConnect C API directly** with P/Invoke (`Native/SimConnectDll.cs`): 8 functions from
  `SimConnect.h`. The adapter now always compiles, on Windows and Linux, in CI.
- **Parse receive messages in pure C#** from raw buffers, using the documented `SimConnect.h` layouts
  (`SimConnectMessages.cs`), and decode data blocks by SimVar name (`TelemetryLayout.cs`). Both are unit-tested
  with byte-exact buffers.
- **Put a seam (`ISimConnectApi`) under the client**, so registration, send-ID → SimVar mapping, events,
  rejected-SimVar handling and the bounded message pump are tested over a fake. Only the 8-function binding is
  untested without MSFS.
- **Load SimConnect.dll at runtime** from next to the bridge, or from `FLIGHTSIM_SIMCONNECT_DLL`. Without it:
  `simconnect_sdk: not_built`, `sdk_unavailable` (no contract change). With it: `unverified` until real-simulator
  validation is recorded.
- **Delete the managed client.** Keeping two unverified implementations would double the review burden.

## Consequences
- **What is still unverified:** struct layouts, the calling convention and runtime behaviour against MSFS
  2020/2024. A probe mode and replay tool exist so that a tester can verify them quickly (see
  `docs/compatibility/windows-validation.md`).
- **Licensing is unanswered.** We cannot say whether `SimConnect.dll` may be redistributed. The installer does not
  include it; the user copies it from their SDK. A decision is needed before a public release.
- **The parser relies on documented layouts.** If a future SimConnect version changes them, the size checks drop
  data instead of misparsing it, and the probe shows `layout_mismatch`.
