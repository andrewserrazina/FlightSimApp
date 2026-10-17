# S2-02 dispatch release screenshots

Captured in headless Chromium from the desktop frontend. They were rendered outside the desktop shell, with
in-memory stores and the synthetic `fixtures/simbrief/ofp-v2-iso-times.json`, which is why the header reads
"Bridge unavailable". Live Flight used the mock telemetry fixture. No real account, flight plan or flight is shown.
The stale-plan warning appears because the fixture's OFP date is in the past relative to the capture clock.

| File | Shows |
|---|---|
| dispatch-board-draft.png | Dispatch board: flight, route, OFP, dispatch state (Draft) and operational status |
| release-review-draft.png | Release review: required checks, informational fields, warnings to acknowledge and the review acknowledgment |
| release-confirm.png | Confirmation before issuing the release |
| dispatch-released-full.png | Released state: release card with the acknowledged warning, the attach hint and the release log |
| release-cancel-dialog.png | Cancellation with a required reason |
| release-log-cancelled.png | Release log after cancellation |
| live-operations.png | Live Flight Operations panel: status, release attached, OUT recorded manually, OFF/ON not yet detected |
| debrief-full.png | Debrief: dispatch release summary, milestones and planned versus actual |
| debrief-milestones.png | Milestones with scheduled, estimated and actual values (MANUAL vs DETECTED) |
| debrief-milestones-narrow.png | The same at a narrow window width |
