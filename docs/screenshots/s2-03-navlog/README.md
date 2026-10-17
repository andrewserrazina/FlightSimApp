# S2-03 navlog and route monitoring screenshots

Captured in headless Chromium from the desktop frontend, outside the desktop shell, with in-memory stores and the
synthetic `fixtures/simbrief/ofp-v2-navlog.json` (fictional fixes; coordinates on great circles). No real account,
flight plan or flight is shown.

| File | Shows |
|---|---|
| dispatch-navlog.png | Navigation log on Dispatch: summary, geographic route map, and waypoint rows (TOC/TOD, a fix without a position shown as Unavailable, the repeated STAR fix) |
| dispatch-navlog-narrow.png | The same at a narrow window width |
| live-route-monitoring.png | Live Flight route monitoring as an unbound preview, from mock telemetry moved along the route: current leg, next fix, distances, cross-track, upcoming waypoints, aircraft on the map. Remaining distance is withheld because a later leg crosses the unpositioned fix |
| debrief-navigation.png | Debrief navigation observations from a synthetic recorded track with one deviation: planned vs recorded distance, tracked share, the period away from the route, altitude at sequenced fixes, limitations |
