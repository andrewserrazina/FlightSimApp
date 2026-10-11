# Turnline — provisional brand direction

Status: **Working concept only — pending trademark clearance and domain verification.**
Former project label: FlightSimApp.

## Positioning
Turnline is a pilot-first airline operations simulation platform for MSFS, with an eventual airline management experience.

**Tagline:** Every flight. The whole operation.

## Product naming
- Turnline Pilot — desktop pilot experience
- Turnline Pro — proposed subscription
- Turnline Dispatch — future dispatch workflow
- Turnline Ground — future passenger/ground operations
- Turnline Airline / OCC — future management simulator

These are working marketing labels, not yet finalized trademarks.

## Visual language
- Navy: `#0B1F3A`
- Gold: `#F4B400`
- Slate: `#4B5B6B`
- Cloud: `#E6EAEE`
- White: `#FFFFFF`
- Typeface direction: geometric, highly legible sans-serif.
- Motif: intersection of a route and stylized T; must work as a monochrome desktop icon.
- Interface: airline operations-center feel, restrained status indicators, accessibility-first.

## Naming due diligence (October 11, 2026)
Preliminary online findings:
- https://turnline.app/ is currently used by a software/CRM business.
- https://turnlinehq.com/ is currently used for another software product.
- https://turnline.co/ is in use by a client acquisition service.
- An earlier US TURNLINE registration 75333950 is listed cancelled; this is not clearance.

- https://turnline.com/ currently redirects to a HugeDomains sales listing advertising a $3,295 asking price (observed October 11, 2026); this is a seller listing, not a domain purchase or ownership verification.\n\n**Do not assume any Turnline domain is available to register.** Live registrar checks and a comprehensive USPTO/state/common-law/international trademark review remain outstanding.

## Safe migration checklist
Until brand clearance:
1. Keep the current repo, internal package names, SQLite application data path, Tauri bundle identifier and historical migrations unchanged.
2. Do not alter production OAuth redirect URLs, billing descriptors, signing keys or installer identity.
3. Mock up logos, landing pages and marketing copy as provisional artifacts.
4. After clearance, implement separately reviewed changes to display name, icons, website, store metadata and installed-app naming.
5. Plan a migration for existing user data if bundle identifiers or storage paths change.
6. Preserve flight/event UUIDs, database migrations and all replay/sync behavior.
7. Run Windows installer upgrade and recovery tests before release.

## Landing-page copy concept

### Turnline
**Every flight. The whole operation.**

Experience airline operations beyond the flight deck. Dispatch, passengers, turnaround, ground handling and post-flight analysis — coordinated around the flights you fly.

**Primary CTA:** Join the early access list
**Secondary CTA:** Explore the platform

**Benefits:**
- Realistic dispatch and flight preparation
- Operationally connected passenger and ground services
- Persistent flights and meaningful debriefs
- Built for pilots first; airline management planned for later

**Transparency:** The application is in development. SimBrief, GSX, and advanced operational capabilities are not yet released. Do not imply availability or collect payments without ready features and terms.

## Next engineering work
Continue S1-05 security/cloud groundwork and parallel Windows/SimConnect validation under existing stable internal identifiers. Branding should not block engineering.
