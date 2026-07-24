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
- [x] `t-0e1f58` — pair QR + baseUrl in Control
- [x] Connected devices shows mobile kind (human dogfood 2026-07-23: *Tachyon Companion Mobile*)

## Phase 2 — Session policy (M4)

- [x] **v1 = last-pair-wins** (shipped first; documented in cookbook + notes)
- [x] **t-44dfb6:** concurrent one-per-kind (browser + mobile); same-kind replace; SSE tab.command isolation; Control unpair by deviceId

## Phase 3 — apps/mobile PWA

- [x] `t-cc73c4` — scaffold + pair (`kind=mobile`)
- [x] `t-5b3445` — roster + attention + prompt + approvals

## Phase 4 — Serve & dogfood

- [x] Engine serves mobile static at `/companion/app/*`
- [x] Control QR encodes `openUrl` → phone auto-pair via `#pair=`
- [x] Mobile reachability = Tailscale only (`lanAccess` opt-in)
- [x] Operator cookbook + privacy/A2HS minimal notes (`cookbook.md`)
- [x] `t-900149` — human dogfood (Tailscale mesh + phone)

## Verification

**Verify:** unit tests for Tailscale pair baseUrl + packaging.  
**Dogfood:** headless `companion-one-qr.mjs` + human phone on same tailnet (**PASS 2026-07-23**).  
**Cookbook:** `docs/specs/422-companion-mobile-v1/cookbook.md`.

## Follow-ups (out of v1 ship bar)

| Item | Notes |
|------|--------|
| Concurrent browser+mobile sessions | M4 — **t-44dfb6 done** (one per kind) |
| Headscale / self-host mesh | Same client path as Tailscale |
| A2HS polish / deeper PRIVACY | Optional install UX |
| TLS on companion HTTP | Deferred v1.1 |
| Merge trail → main | Ship step for this branch |
