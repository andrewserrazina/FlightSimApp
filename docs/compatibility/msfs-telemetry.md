# MSFS telemetry compatibility matrix

**Runtime verification status: NOT VERIFIED.** No MSFS 2020 or MSFS 2024 installation was
available while this was built. The SimVar names and units below follow the published
SimConnect documentation, but they have not been checked against an installed SDK or a
running simulator. `ManagedSimConnectClient.cs` has never been compiled. Do not claim
support until each row has evidence for each simulator version.

| Contract field | SimVar (unit requested) | Conversion | MSFS 2020 | MSFS 2024 |
|---|---|---|---|---|
| aircraft.title | TITLE (string256) | trim; empty = unavailable | unverified | unverified |
| aircraft.icao_type | ATC MODEL (string256) | trusted only if profile says so (currently never) | unverified | unverified |
| on_ground | SIM ON GROUND (bool) | >= 0.5 | unverified | unverified |
| lat_deg / lon_deg | PLANE LATITUDE / LONGITUDE (degrees) | range-checked | unverified | unverified |
| indicated_altitude_ft | INDICATED ALTITUDE (feet) | range-checked | unverified | unverified |
| pressure_altitude_ft | PRESSURE ALTITUDE (feet) | range-checked | unverified | unverified |
| radio_altitude_ft | RADIO HEIGHT (feet) | range-checked | unverified | unverified |
| indicated_airspeed_kt | AIRSPEED INDICATED (knots) | small negatives clamped to 0 | unverified | unverified |
| ground_speed_kt | GROUND VELOCITY (knots) | small negatives clamped to 0 | unverified | unverified |
| vertical_speed_fpm | VERTICAL SPEED (feet per minute) | range-checked | unverified | unverified |
| heading_true_deg | PLANE HEADING DEGREES TRUE (degrees) | normalized to [0,360) | unverified | unverified |
| total_fuel_kg | FUEL TOTAL QUANTITY WEIGHT (pounds) | x 0.45359237 | unverified | unverified |
| engine_count | NUMBER OF ENGINES (number) | integer 0..16 | unverified | unverified |
| engines_running_count | GENERAL ENG COMBUSTION:1..4 (bool) | count of first `engine_count` | unverified | unverified |
| parking_brake_set | BRAKE PARKING POSITION (bool) | >= 0.5 | unverified | unverified |

Sampling: one `RequestDataOnSimObject(..., PERIOD.ONCE)` every 500 ms (2 Hz), issued on the owner thread.

## Verification checklist (per simulator version, per test aircraft)
1. Build with `-p:SimConnectSdkDir=...` and record the SDK version.
2. Start the bridge with `--adapter msfs2020|msfs2024`, with the sim closed: expect RECONNECTING / `simulator_not_running`.
3. Start the sim and load a default airliner: expect CONNECTED and a plausible `simulator_version`.
4. Compare every field above with the in-sim value. Record the aircraft, value and pass/fail here.
5. Quit the sim mid-flight: expect RECONNECTING, then a gap event after it restarts.
