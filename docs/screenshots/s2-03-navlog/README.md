# S2-03 navlog and route monitoring screenshots

Captured in headless Chromium from the desktop frontend, outside the desktop shell, with in-memory stores and the
synthetic `fixtures/simbrief/ofp-v2-navlog.json` (fictional fixes; coordinates on great circles). No real account,
flight plan or flight is shown.

| File | Shows |
|---|---|
| dispatch-navlog.png | Navigation log on Dispatch: summary, geographic route map, and waypoint rows (TOC/TOD, a fix whose position was not sent, the repeated STAR fix) |
| dispatch-navlog-narrow.png | The same at a narrow window width |
| dispatch-navlog-positions.png | The same OFP with TLNC3 sent as (0, 0) and TLND4 with a malformed latitude: every row is kept; (0, 0) is shown as imported and marked Unverified because SimBrief's own leg distances contradict it; the malformed value is shown as sent; the geometry skips both (dashed) |
| live-route-monitoring.png | Live Flight route monitoring as an unbound preview, from mock telemetry moved along the route: current leg, next fix, distances, cross-track, upcoming waypoints, aircraft on the map. Remaining distance is withheld because a later leg crosses the unpositioned fix |
| live-outside-corridor.png | The aircraft 14 nm right of the active leg: "Outside planned route corridor", with possible causes stated as unverified and no progress figures |
| debrief-navigation.png | Debrief navigation observations from a synthetic recorded track that leaves the corridor once: planned vs recorded distance, tracked share, the period outside the planned route corridor (with possible, unverified causes), altitude at sequenced fixes, limitations |
