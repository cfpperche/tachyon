# Companion Mobile one-QR — human dogfood (2026-07-23)

**Result:** PASS (maintainer validated)

## Path
- Worktree: `tachyon/change/companion-mobile-one-qr` (post-merge main + Tailscale-only reachability)
- Dev Host: companion-track fixture, `lanAccess: true`
- Reachability: Tailscale mesh (`100.87.149.83:41179`) — not raw Wi‑Fi LAN

## Validated
- [x] QR openUrl → phone opens PWA on mesh IP
- [x] Auto-pair (`kind=mobile`); Control shows Paired + device row
- [x] Connected · SSE / live heartbeat on phone
- [x] Fleet / prompt / approvals / unpair (maintainer confirmed working)

## Evidence
- `phone-paired.jpg` — Connected · sse, engine workspace
- `control-paired.png` — Settings Paired + Tachyon Companion Mobile device

## Residual / non-blocking
- A2HS / PRIVACY install docs
- Headscale self-host later (same client path)
