# S2-01 Dispatch page screenshots

These were captured from the production frontend build (`apps/desktop/dist`) in headless Chromium, outside the
desktop shell, which is why the header reads "Bridge unavailable". The SimBrief request went to the real URL but
was answered by the synthetic fixtures in `fixtures/simbrief/`, so no real account or flight plan is shown.

| File | Shows |
|---|---|
| dispatch-imported-kg.png | `ofp-v2-kgs.json` imported: overview, route, schedule, fuel, weights |
| dispatch-imported-lb-unavailable-fields.png | `ofp-v2-lbs.json`: weights converted to kg with the planned lb; empty fields shown as Unavailable |
| dispatch-error-unknown-user.png | SimBrief's real "Unknown UserID" error (HTTP 400) shown to the user |
