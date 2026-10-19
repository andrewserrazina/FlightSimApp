# Turnline by SimuNet: brand integration proposal

**Status:** documentation only, for owner review.

- **Nothing here changes production branding,** the website, the desktop app, accounts or billing.
- **Each phase in §8 is a separate, owner-approved change.**
- **This document builds on `turnline-working-brand.md`.** Its trademark caution and safe-migration checklist still apply.

**Owner decision being implemented:**

| | |
|---|---|
| **Product** | **Turnline** |
| **Endorsement** | **by SimuNet** |
| **Tagline** | **Every flight. The whole operation.** |

- **Turnline** is the dedicated aviation operations application. It keeps its navy and gold identity.
- **SimuNet** is the parent simulation ecosystem: contracts, economy, logistics and operator progression.

**Fixed product requirements (from the owner):**
1. Turnline is usable on its own and offline.
2. The Operations Center, Dispatch, GSX, recording, Debrief and flight economics stay in Turnline.
3. SimuNet is authoritative for contracts, verification and simulated payouts.
4. Codebases, local storage and backends stay separate until an integration architecture is approved.
5. Optional SimuNet account linking and native aviation assignments come later.
6. No SimuNet-specific clutter or new technical detail in the Operations Center.

---

## 0. What exists today (verified in the code, Oct 19, 2026)

| Surface | Today |
|---|---|
| **Desktop top bar** | `▲ FlightSimApp  OPERATIONS` (`apps/desktop/src/app/AppShell.tsx:99-103`) |
| **Window title** | `FlightSimApp` (`apps/desktop/index.html`, `tauri.conf.json` `title`) |
| **Product name** | Tauri `productName`: `FlightSimApp`; install folder `%LOCALAPPDATA%\FlightSimApp`; uninstall key `…\Uninstall\FlightSimApp` |
| **Data identifier** | `dev.flightsimapp.desktop`, which is the `%APPDATA%` data folder that holds `flightsim.db` |
| **Side-nav footer** | `v0.1.0 · Sprint 1 preview` / `Not for real-world navigation` |
| **Recovery banner** | "…was still open when FlightSimApp closed" (`RecorderBanners.tsx`) |
| **Website: domain and pages** | **turnlineops.com**: `/`, `/privacy.html`, `/confirm.html`, `/unsubscribe.html`, `/404.html` |
| **Website: indexing and contact** | `noindex,nofollow`; contact `support@turnlineops.com` |
| **Website: brand and tagline** | Curved-route mark in gold on navy plus the `TURNLINE` wordmark; tagline already "Every flight. The whole operation." |
| **Website: legal line** | "© 2026 Turnline. Turnline is operated by Apex Aviation Training Group LLC. Turnline is a working product name." The same operator is named in the privacy notice and the welcome email. |
| **Turnline colours** | Navy `#0B1F3A` / deep `#081629`, gold `#F4B400` / strong `#FFC933`; slate `#4B5B6B`, cloud `#E6EAEE` |
| **SimuNet identity** | White "SimuNet" wordmark (capital S and N) over three orange chevrons on a charcoal disc (`simunet-html/assets/SimuNetLogo.png`) |
| **SimuNet colours** | Charcoal `#1F232C`, orange accent `#FF6B2C`, signal blue `#3E92CC` |
| **SimuNet domain and hero** | simunet.co; hero line "Fly it. Drive it. Watch the world react." |
| **SimuNet accounts** | JWT accounts with FREE and PRO tiers through Stripe (`app/routers/billing.py`) |
| **SimuNet legal entity** | Not stated anywhere in the SimuNet repo or site. **This needs an owner and legal decision (§9).** |

Two consequences shape the plan:

- **The desktop app still shows its old project name.** The first visible brand change in the app is "FlightSimApp" → "Turnline". Adding "by SimuNet" is a small step on top of that.
- **Install and data identifiers must not change.** Renaming `productName` or `identifier` would move the install folder, the uninstall entry or the data folder. That is a separate migration with upgrade testing, not part of a brand rollout.

---

## 1. "by SimuNet" inside the desktop app

**Principle:** the endorsement belongs to *chrome and identity* (frame, about, installer), never to *operational content*. A pilot mid-approach should never see SimuNet in their working view unless they have deliberately linked an account and a SimuNet contract is involved.

### Recommended placements

| Placement | What it shows | Why |
|---|---|---|
| **Top bar brand block** (replaces `FlightSimApp OPERATIONS`) | Turnline mark, then the **Turnline** wordmark, then a small muted **by SimuNet** (text only, no SimuNet logo) | One quiet endorsement in the frame. It replaces the "OPERATIONS" label, so no extra element is added. |
| **Narrow windows** | Below 1100 px the endorsement text hides; the mark and wordmark stay | The top bar holds the connection chip, DEMO DATA tag and UTC clock, which matter more |
| **Window title / taskbar / Start menu** | `Turnline` | Short and recognisable; the endorsement would be noise in the taskbar |
| **Settings → About** (new, small section) | Mark, Turnline wordmark, by SimuNet, tagline, version, "Not for real-world navigation", the legal operator line, and links to turnlineops.com and simunet.co | The natural home for the full lockup and legal text |
| **Side-nav footer** | `Turnline 0.x · Preview` / `Not for real-world navigation` | Drops "Sprint 1"; no second endorsement here |
| **Installer welcome and finish pages** | Full horizontal lockup (§2) | First impression; a moment when users look at branding |
| **Splash / first-run** (if one is added later) | Full lockup, briefly | Same reason |
| **Recovery banner and other system text** | "…when Turnline closed" | The product name only; never the endorsement in messages |

### Explicitly not
- **Not in the Operations Center:** no SimuNet text, logo, colour, health item or empty-state promotion on Live Flight, Dispatch, Debrief, Flight History or Receipts & Expenses while no SimuNet account is linked (requirement 6).
- **Not in the metric tiles, route card, milestone strip, attention bar or health summary.**
- **No SimuNet orange anywhere in the Turnline interface.** Orange would read as a warning next to Turnline's status colours.
- **No upsell banners,** "Get SimuNet PRO" prompts or locked-feature teasers.
- **Not before trademark clearance:** the display rename waits until the Turnline name is cleared, per `turnline-working-brand.md`.

**After account linking exists (§6), and only when linked:**
- **Health summary:** one "SimuNet" item, using the same muted style as Simulator, Recording, Plan and GSX.
- **Plan basis:** a "SimuNet contract" plan-basis chip on the Route card when the flight came from a SimuNet assignment.
- **Wording:** plain status words only ("Linked", "Contract attached", "Couldn't reach SimuNet"). The technical detail stays in Settings → Advanced diagnostics, as for the bridge today.

---

## 2. Logo relationship

**Model:** an **endorsed brand**. Turnline is the hero; SimuNet is a quiet, secondary signature, as in "Courtyard by Marriott" or "Instagram from Meta". It is **not** a co-brand, where both logos would carry equal weight.

See `concepts/turnline-by-simunet-lockups.svg` for concept sketches. The final artwork must come from a designer using the official SimuNet artwork; these sketches are not production assets.

### Lockups
1. **Horizontal (primary):** the Turnline mark, then the TURNLINE wordmark, then a thin divider and "by SimuNet" set in text. Used in the website header, installer and About.
2. **Stacked:** the Turnline mark above the TURNLINE wordmark, with "by SimuNet" centred beneath. Used on social avatars with a caption, splash screens and merchandise.
3. **Turnline alone:** the mark plus wordmark, or the mark only for the app icon, favicon and taskbar. **The app icon never contains SimuNet.**

### Rules
- **Endorsement size:** "by SimuNet" is set at about **40% of the TURNLINE cap height**, never above 50%. It uses a regular weight with normal tracking; TURNLINE stays bold and wide-tracked.
- **Endorsement colour on Turnline backgrounds:** cloud `#E6EAEE` at about 70% opacity on navy, or slate `#4B5B6B` on light backgrounds. **Never orange.**
- **Typeface:** "by" is lowercase, and "SimuNet" keeps its capital S and N.
- **Wordmark versus logo:** in Turnline contexts SimuNet appears as a **wordmark only**. The orange chevron disc is SimuNet's own logo; it appears only on SimuNet surfaces and in "SimuNet ecosystem" listings.
- **Clear space:** at least the height of the Turnline mark's dot around the full lockup; the divider sits at one dot-width from both sides.
- **Minimum size:** below 120 px lockup width (24 px mark), drop the endorsement and use Turnline alone.
- **App mark:** the desktop app currently uses a `▲` placeholder. Phase 3 replaces it with the curved-route mark the website already uses, so the app and site carry the same mark.

---

## 3. turnlineops.com

The domain, URLs, signup flow, privacy notice structure and support address stay unchanged. No redirects to or from simunet.co. Indexing stays `noindex,nofollow` until you separately approve discoverability.

### Proposed changes (Phase 2, preview deploy first)

| Area | Change |
|---|---|
| **Header brand** | Horizontal lockup: mark + TURNLINE + "by SimuNet" (text). The endorsement hides below 480 px wide. |
| **`<title>`** | `Turnline by SimuNet: airline operations for Microsoft Flight Simulator (in development)` |
| **`og:site_name`** | Stays `Turnline` |
| **`og:title` / `twitter:title`** | `Turnline by SimuNet: Every flight. The whole operation.` |
| **OG image** | Re-export with the lockup; same layout otherwise |
| **Hero** | Unchanged headline. One line under the lead: *"Turnline is the aviation operations app in the SimuNet simulation ecosystem."* |
| **New short section "Part of SimuNet"** (before the FAQ) | Three sentences and a link to simunet.co (copy in §4). Clearly labelled as planned. |
| **FAQ additions** | "Do I need a SimuNet account?", "What is SimuNet?", "Is my early-access signup shared with SimuNet?" (copy in §4) |
| **Footer** | Lockup, tagline and the legal line updated per the entity decision (§9). Add "Part of the SimuNet ecosystem" with a link to simunet.co under *Explore*. |
| **Privacy notice** | Unchanged unless data is shared. Any sharing of waitlist data with SimuNet needs a new notice and fresh consent (§7). |
| **Welcome email** | Sign-off changes to "Turnline by SimuNet"; the legal footer follows §9 |
| **Site tests** | `scripts/marketing-site-test.mjs` gains checks that: (a) no copy claims a SimuNet integration, account linking, contracts or payouts are available; (b) the endorsement never appears in orange; (c) existing URLs and the noindex directives remain. |

### Never on turnlineops.com (until built and approved)
- Any claim that a SimuNet integration, contracts, payouts or account linking is available.
- Real-money language. SimuNet payouts are **simulated**.
- SimuNet pricing on Turnline pages.

---

## 4. Product descriptions and marketing copy

**Status guard for all copy:** Turnline is in development and tested internally with MSFS 2020. The SimuNet integration is **planned**. Copy must say so wherever a status is implied.

### Name usage
- **First mention in formal contexts** (site title, press, store listing, About): **Turnline by SimuNet**.
- **Thereafter:** **Turnline**.
- **Never:** "SimuNet Turnline", "Turnline (SimuNet)", "TurnLine", "Turnline from SimuNet", or "Simunet" (lowercase n).
- **"by SimuNet" stays lowercase "by".**

### One-liner
> **Turnline by SimuNet.** Every flight. The whole operation.

### Short description (≈25 words, store and social bio)
> Turnline is the airline operations app for Microsoft Flight Simulator: SimBrief dispatch, live flight recording and planned-versus-actual debriefs. By SimuNet. In development.

### Medium description (≈60 words)
> Turnline brings the airline operation around your flight to life in Microsoft Flight Simulator. Import your SimBrief plan, record the flight as it happens, track ground services, and review plan against actual after landing. Turnline works on its own, offline, on your PC. It is the aviation operations app in the SimuNet simulation ecosystem. In development.

### Long description / press boilerplate (≈110 words)
> **About Turnline.** Turnline by SimuNet is a pilot-first airline operations application for Microsoft Flight Simulator. It connects dispatch, live flight recording, ground handling and post-flight debriefs around each flight you fly, with a clear record of what was planned, what was detected and what you recorded. Turnline runs locally and works on its own. No SimuNet account is required. Turnline is in development and tested internally with MSFS 2020.
>
> **About SimuNet.** SimuNet is a simulation ecosystem for contracts, logistics, economy and operator progression across flight and driving simulators. Turnline is its dedicated aviation operations application. Optional SimuNet account linking and aviation assignments are planned.

### "Part of SimuNet" section (website)
> **Part of SimuNet.** Turnline is the aviation operations app in the SimuNet simulation ecosystem. On its own, Turnline gives you dispatch, recording and debriefs for every flight. In future, an optional SimuNet link is planned to bring contracts, logistics and operator progression to your flights. It is not available yet. [Visit SimuNet →]

### FAQ copy
- **Do I need a SimuNet account?** No. Turnline works on its own and offline. A SimuNet account will be optional, if and when linking becomes available.
- **What is SimuNet?** SimuNet is the simulation ecosystem behind Turnline: contracts, logistics, economy and operator progression. Turnline is its aviation operations app.
- **Is my early-access signup shared with SimuNet?** No. Your Turnline early-access signup is used only for Turnline updates, as described in the privacy notice.

### Voice
- **Turnline:** precise and operational, using airline vocabulary (OUT, OFF, ON, IN, release, turnaround). Honest status labels; never overclaims.
- **SimuNet:** a broader, more energetic "world" voice ("Watch the world react"). It is used on SimuNet surfaces and in the "About SimuNet" paragraph, not inside Turnline copy.

---

## 5. Shared brand guidelines (summary)

A one-page "SimuNet family" sheet that both repositories reference. Each product keeps its own detailed guide.

| | Turnline | SimuNet |
|---|---|---|
| **Role** | Product (aviation operations) | Parent ecosystem / endorser |
| **Primary colours** | Navy `#0B1F3A`, gold `#F4B400` | Charcoal `#1F232C`, orange `#FF6B2C` |
| **Support colours** | Slate `#4B5B6B`, cloud `#E6EAEE` | Signal blue `#3E92CC` |
| **Logo** | Curved-route mark + TURNLINE | White SimuNet wordmark + orange chevrons on charcoal |
| **In the other brand's context** | On SimuNet surfaces Turnline keeps its navy and gold product card | On Turnline surfaces SimuNet is a mono wordmark only |
| **Typography** | Segoe UI Variable / Inter (app); site fonts as today | SimuNet's existing fonts |
| **Voice** | Operational, exact, honest status | World-building, energetic |

**Shared rules**
- **Product colours stay separate.** Each product's accent belongs to that product; Turnline gold and SimuNet orange never appear together as equal accents.
- **One endorsement per surface.**
- **Status honesty:** "Planned", "In development" and "Internal build" labels follow the same definitions on both sites.
- **"Simulated payouts" / "in-sim earnings"** is the only wording for SimuNet rewards. Never "earn money" or "income".
- **Not affiliated:** both sites keep their disclaimers for Microsoft, SimBrief, GSX and real-world airlines.

---

## 6. Future cross-navigation

Nothing below is built until you approve it. The account-linking items also wait on the integration architecture in the SimuNet feasibility study.

### Now (Phase 2–3, no accounts)
- **turnlineops.com → simunet.co:** footer link and the "Part of SimuNet" section.
- **simunet.co → turnlineops.com:** a Turnline product card in a SimuNet "Ecosystem" or "Apps" area, in Turnline's navy and gold, labelled "In development". This lives in the SimuNet repo and needs its own approval.
- **Desktop:** links to both sites appear only in Settings → About, and open in the system browser.

### Later (after linking is approved)

| From | To | Where | Condition |
|---|---|---|---|
| **Turnline Settings** | SimuNet account | Settings → Accounts → "SimuNet (optional)": link, unlink, status | Always available there; off by default |
| **Turnline Dispatch** | SimuNet assignment | A second plan source beside SimBrief import: "Assignments from SimuNet" | Only when linked |
| **Turnline Debrief** | SimuNet contract outcome | "Request SimuNet verification" and the outcome; "View on SimuNet" opens the browser | Only for a flight linked to an assignment |
| **SimuNet job board** | Turnline | "Fly with Turnline" on aviation assignments (opens Turnline or the download page) | SimuNet side; aviation jobs only |
| **Turnline Live Flight** | (none) | Only the optional "SimuNet" health item and plan-basis chip described in §1 | Only when linked |

**Cross-navigation rules**
- **External links open in the system browser.**
- **No embedded SimuNet web views** inside Turnline.
- **No deep-link handler** until it has a security review.

---

## 7. Accounts and subscriptions

### Positioning
- **Turnline stands alone.** It works offline and needs no SimuNet account. Its own optional cloud sign-in (Turnline's existing auth and sync) stays a Turnline account.
- **A SimuNet account is optional and additive.** Linking connects a Turnline installation to a SimuNet identity so you can receive aviation assignments and have flights verified. It never replaces Turnline sign-in, and it never gates Turnline features.
- **Turnline keeps flight economics.** SimuNet keeps contracts, verification and simulated payouts.
  - A linked flight's SimuNet payout is shown as SimuNet's figure, attributed to SimuNet.
  - It is never added to Turnline's own revenue or ledger, so nothing is counted twice.

### Subscriptions: options for decision
| Option | Description | Assessment |
|---|---|---|
| **A. Separate** (recommended at launch) | Turnline has its own plan (TBD). SimuNet FREE and PRO stay as they are. Linking works with SimuNet FREE where SimuNet's rules allow it. | Simplest; no billing coupling; matches "keep backends separate" |
| **B. SimuNet PRO includes Turnline premium** | One subscription unlocks both | Strong ecosystem story, but couples billing systems and entitlement checks |
| **C. Bundle discount** | Separate plans with a discount for both | Middle ground; needs shared entitlement data |

**Recommendation:** A now, and revisit B or C once linking exists and both products have real users.

**Messaging:**
- *"Turnline is complete on its own. SimuNet membership adds contracts, logistics and progression across simulators."*
- No price or plan names on either site until terms exist, which `turnline-working-brand.md` already requires.

### Consent and data
- **The waitlist stays Turnline's.** Subscribers consented to Turnline updates from the current operator.
  - Emailing them SimuNet marketing, or sharing their addresses with SimuNet, needs updated notices and fresh opt-in.
  - A Turnline update that *mentions* the endorsement is fine.
- **Linking will need explicit consent** for which telemetry and flight fields leave the machine (see the feasibility study).

---

## 8. Phased rollout (preserves users, URLs and functionality)

| Phase | Scope | Preserves | Gate |
|---|---|---|---|
| **P0** | This proposal | — | Owner review |
| **P1: Clearance and artwork** | Trademark and domain clearance for "Turnline", and for "Turnline by SimuNet" as a combined mark. The entity and legal relationship statement (§9). Designer-final lockups, app icon and favicon. The shared guideline sheet. | Everything (no product change) | Owner and legal approval |
| **P2: Website copy** | §3 and §4 on turnlineops.com, with site tests updated. **Preview deploy only**; production deploy on your approval. | All URLs, signup and confirmation flow, unsubscribe links, support address, noindex | Owner approval for production |
| **P3: Desktop display branding** | "FlightSimApp" → "Turnline" in the top bar, window title, side-nav footer and recovery banner; the curved-route mark replaces ▲; "by SimuNet" in the top bar and installer pages; a new Settings → About. **`productName`, `identifier`, install folder, uninstall key and data folder are unchanged.** It touches only the frame and Settings, never Live Flight content. | Installed builds, data, upgrade path, tests (the smoke test checks the uninstall key and data folder) | Owner approval. Scheduled **after the Ops Center L-series** (or as a tiny PR rebased onto it) so it doesn't collide with L6–L8 in `AppShell.tsx` |
| **P3b (optional): Installed identity** | Rename the installer `productName` and install folder to Turnline, with a tested upgrade from 0.1.x that keeps `%APPDATA%\dev.flightsimapp.desktop` and the flight history | User data and flight history | Separate approval plus a Windows upgrade and recovery test |
| **P4: SimuNet side** | Turnline product card on simunet.co (SimuNet repo) | SimuNet URLs and accounts | Owner approval (SimuNet repo) |
| **P5: Optional account linking** | Per the approved integration architecture: Settings → Accounts, the optional health item, and Debrief verification | Offline use; linking off by default | Integration architecture approval |
| **P6: Native aviation assignments** | SimuNet assignments as a Dispatch plan source | SimBrief import unchanged | Owner approval |

**The Operations Center priority is unaffected.**
- P1, P2 and P4 touch no app code.
- P3 is a small frame-only change scheduled after the L-series.
- P5 and P6 wait on the integration architecture.

---

## 9. Decisions requiring owner approval

1. **Legal relationship and operator line.** Today every Turnline surface says "operated by Apex Aviation Training Group LLC", and SimuNet's legal entity is not stated anywhere. Is SimuNet a brand of the same company, a separate entity, or a licence arrangement? This decides:
   - the footer and privacy wording;
   - whether a trademark licence is needed for the endorsement;
   - the installer publisher name.
2. **Trademark and domain clearance** for "Turnline", still outstanding per `turnline-working-brand.md`, and for the combined "Turnline by SimuNet" mark.
3. **Endorsement placement in the app top bar** (recommended), or only in About and the installer (more minimal).
4. **Logo model:** endorsed brand with a text-only "by SimuNet" (recommended), or a small SimuNet chevron glyph beside the text.
5. **Website changes in P2,** including the "Part of SimuNet" section and the FAQ answers.
6. **simunet.co listing Turnline** (P4) and its wording.
7. **Subscription model:** A separate (recommended), B included in PRO, or C bundle.
8. **Whether waitlist subscribers are told** about the endorsement in a Turnline update email.
9. **Whether to do P3b** (installed-identity rename with migration), or keep the FlightSimApp install identity indefinitely behind a Turnline display name.
10. **Optional future alias,** for example `turnline.simunet.co` redirecting to turnlineops.com, or none.
