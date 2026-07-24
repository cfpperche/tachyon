# 422 — Companion Mobile v1 — cookbook (operator)

_Human-validated 2026-07-23 (Tailscale mesh). Worktree trail: `tachyon/change/companion-mobile-one-qr`._

## Goal

Phone pairs with the local Tachyon engine, sees fleet attention, sends a short prompt or resolves an approval, unpairs — without a store app or cloud companion.

## Prerequisites

1. **Tailscale** on the machine that runs the engine (WSL if engine is in WSL) and on the phone — **same account / tailnet**.
2. Tachyon with Companion Mobile packaged (`media/companion-mobile` → engine serves `/companion/app/*`).
3. Workspace `tachyon.yml`:

```yaml
settings:
  companion:
    lanAccess: true   # name historical: enables mobile via Tailscale (not raw multi-NIC Wi‑Fi)
    # tabTools: true  # optional; unrelated to mobile pair
```

4. Engine Bridge listening (Control Engine tab shows a port).

## Pair (happy path)

1. Open **Control → Settings → Companion**.
2. **Show pair code** (mint short-lived code + QR).
3. Confirm URL is the **Tailscale IP** (`http://100.x.y.z:<port>/…`), not `127.0.0.1`.
4. Phone: Tailscale **connected** → camera on QR (or open the `openUrl` link).
5. PWA loads, auto-pairs (`kind=mobile`), shows **Connected · sse**.
6. Control → **Connected devices** shows *Tachyon Companion Mobile*.

## Operate

| Action | Where |
|--------|--------|
| See agents / attention | Phone **Fleet** (start agents on the host if roster is empty) |
| Short prompt | Phone → select agent → send |
| Approvals | Phone **Approvals** → Accept / Deny (host-authoritative) |
| Unpair from phone | Phone **Unpair** |
| Unpair from host | Control Connected devices → **Unpair** |

## Session policy (v1)

**Last-pair-wins:** the engine keeps **one** companion session. A new successful pair (browser or mobile) **replaces** the previous session; the old client gets unpaired/expired on next use. Concurrent browser+mobile is **not** v1 — follow-up if needed.

## Privacy / PWA install (minimal)

- Pair secrets live in the phone browser (**session token** in `localStorage` under a companion key; pair code only in the URL hash until auto-pair clears it).
- Prefer a **trusted device**; unpair when done.
- **Add to Home Screen** (iOS Share → Add to Home Screen / Android browser menu) is optional polish — the mobile web app works in a normal tab after pair.
- No cloud relay: traffic is PC ↔ phone on the **Tailscale mesh** (or loopback for same-host browser companion).

## Failure modes

| Symptom | Check |
|---------|--------|
| Pair fails / `tailscale_required` | `tailscale ip -4` on **engine host**; phone on same tailnet |
| QR is `127.0.0.1` | `lanAccess` false or wrong Dev Host / fixture |
| Phone cannot open `100.x` | Tailscale not connected on phone; wrong peer offline |
| Fleet empty | No running agents on host |
| Doctor error companion.tailscale | Mobile on without mesh IP |

## Headless (agent / CI smoke)

With Dev Host pointed at a build that serves `/companion/app/*` and Tailscale up:

```bash
node scripts/dev-host/headless-interactive.mjs \
  --scenario scripts/dev-host/scenarios/companion-one-qr.mjs
```

Phone step uses loopback rewrite for local Chromium; real-phone dogfood still requires the human path above.

## Out of scope (v1)

Terminal scrollback, tab tools on mobile, multi-engine picker, store native app, TLS on mesh HTTP (deferred).
