# 422 — companion-mobile-v1 — notes

## Decisions

- 2026-07-21 — Maintainer ratified research M1–M8 (`companion-mobile-v1-research.md`). Orca reference-only; `t-784bc8` out of trail.
- 2026-07-21 — SDD `422-companion-mobile-v1` scaffolded; umbrella board `t-af2c9b`.
- Defaults without further ratify: TLS deferred v1.1; LAN opt-in only; engine static serve preferred for dogfood.

## Open during build

- Multi-session (browser+mobile) cost vs last-pair-wins
- Control UI toggle for lanAccess (yml + YamlConfigEditor done in t-da645b; Control chrome in t-0e1f58 with QR)

## Deviations

- 2026-07-22 — **t-da645b:** shared Bridge on `0.0.0.0` when lanAccess, with **route filter**: non-loopback peers only get `/companion/v1/*` (MCP → 403). Companion-only second port still deferred. Pair baseUrl first-LAN-IP residual for multi-NIC → t-0e1f58 candidates UI.

## Implementation log

- 2026-07-22 — t-da645b: `settings.companion.lanAccess`, Bridge `start(port, {host})`, pair baseUrl via `lanReachability.ts`, doctor `companion.lan_access` warn, reload rebinds Bridge.
- 2026-07-22 — t-0e1f58: IssuedPairCode gains `baseUrls` + `qrPayload`; Control pair offer shows QR PNG + candidates; companionBaseUrl respects lanAccess.
- 2026-07-22 — one-QR dogfood (worktree `companion-mobile-one-qr`): engine serves `media/companion-mobile` at `/companion/app/*`; `IssuedPairCode.openUrl`; Control QR encodes openUrl; mobile auto-pairs from `#pair=`; LAN filter allows `/companion/app/*`.
