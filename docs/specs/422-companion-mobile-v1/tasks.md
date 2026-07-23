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

- [x] `t-cc73c4` — scaffold + pair (`kind=mobile`)
- [x] `t-5b3445` — roster + attention + prompt + approvals

## Phase 4 — Serve & dogfood

- [x] Engine serves mobile static at `/companion/app/*` (one-QR dogfood; worktree `companion-mobile-one-qr`)
- [x] Control QR encodes `openUrl` → phone camera opens PWA + auto-pair via `#pair=`
- [x] Mobile reachability = Tailscale only (`lanAccess` opt-in; no multi-NIC Wi‑Fi list)
- [ ] PRIVACY / README install (“Add to Home Screen”)
- [x] `t-900149` — human dogfood (Tailscale mesh + phone); evidence under `.tachyon/evidence/companion-mobile/`

## Verification

**Verify:** unit tests for Tailscale pair baseUrl + `lanAccess` schema (worktree).  
**Dogfood:** headless scenario `companion-one-qr.mjs` + human phone on same tailnet.  
**Human dogfood (PASS 2026-07-23):** Tailscale on PC+phone → QR → auto-pair → fleet/prompt/approvals → unpair.  
**Visual QA:** screenshots under `.tachyon/evidence/companion-mobile/`.  
**Cookbook:** yes (operator path: Tailscale + Control pair QR) — add at ship.  
