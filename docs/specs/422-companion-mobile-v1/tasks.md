# 422 — companion-mobile-v1 — tasks

_Board umbrella: `t-af2c9b`. Research: `t-619157` done. Product card: `t-fe52f0` frente 2._

## Phase 0 — Design

- [x] Research `docs/architecture/companion-mobile-v1-research.md` (`t-619157`)
- [x] Maintainer ratify M1–M8 (2026-07-21)
- [x] Scaffold SDD `422-companion-mobile-v1`
- [x] Fill `spec.md` / `plan.md` / this file from ratification
- [x] Umbrella `t-af2c9b` + child board tasks created

## Phase 1 — ADE reachability

- [x] `t-da645b` — `settings.companion.lanAccess` + bind + doctor
- [x] `t-0e1f58` — pair QR + baseUrl candidates in Control
- [ ] Connected devices shows mobile kind (smoke with slice 3)

## Phase 2 — Session policy (M4)

- [ ] Decide implement: browser+mobile concurrent **or** document last-pair-wins for v1
- [ ] If concurrent: pairing registry supports both without silent kill of the other shell

## Phase 3 — apps/mobile PWA

- [ ] `t-cc73c4` — scaffold + pair (`kind=mobile`)
- [ ] `t-5b3445` — roster + attention + prompt + approvals

## Phase 4 — Serve & dogfood

- [ ] Optional: engine serves mobile static for single-process dogfood
- [ ] PRIVACY / README install (“Add to Home Screen”)
- [ ] `t-900149` — human dogfood phone LAN; close `t-fe52f0` frente 2

## Verification

**Verify:** unit tests for `lanAccess` schema + pair baseUrl when LAN on (command TBD when code lands).  
**Dogfood-Opt-Out:** headless cannot exercise real phone LAN pair; use **Human dogfood** below.  
**Human dogfood:** enable LAN → QR pair from phone → see agent → prompt or approval → unpair.  
**Visual QA:** mobile PWA pair + home roster (screenshots under `.tachyon/evidence/companion-mobile/`).  
**Cookbook:** yes (operator path: Control pair QR + phone install) — add at ship.  
