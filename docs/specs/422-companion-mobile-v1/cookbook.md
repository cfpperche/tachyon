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

**Session policy (t-44dfb6):** the engine keeps **at most one browser and one mobile** session. Pairing the same kind **replaces** that kind only; the other kind stays live. Control **Unpair** on a device row revokes that row; omit device id to clear all. `tab.command` SSE is **browser-only** (mobile does not receive tab tool traffic).

## Privacy / PWA install (t-bd281f)

### What is stored on the phone
- **Session token** in `localStorage` (companion key) after a successful pair. Treat the phone like a second Control shell for this engine until you unpair or the session TTL expires.
- **Pair code** only appears in the URL hash (`#pair=…`) long enough for auto-pair; it is not a long-lived secret.
- No Tachyon cloud: traffic is **PC ↔ phone on the Tailscale mesh** (or loopback for same-host browser companion). Mesh HTTP is cleartext on the CGNAT path (TLS is a later residual).

### Add to Home Screen (optional)
The engine serves a web app at `/companion/app/` with `manifest.webmanifest` + service worker. A normal tab works after pair; A2HS is polish for a home-screen icon.

| Platform | Steps |
|----------|--------|
| **iOS Safari** | Open the paired URL → Share → **Add to Home Screen** → Add. Prefer Safari (not in-app browsers) so storage and A2HS behave predictably. |
| **Android Chrome** | Open the paired URL → menu ⋮ → **Install app** / **Add to Home screen**. |

After install, open from the icon (same origin as the Tailscale base URL). If you re-pair with a new engine/port, unpair first or clear site data for the old origin.

### Unpair hygiene
1. Phone **Unpair**, or Control → Connected devices → **Unpair** on that row (other kind stays paired).
2. On a shared/borrowed phone: unpair + clear site data for the Companion origin before handing it back.
3. Turning off `settings.companion.lanAccess` stops new Tailscale pair URLs; existing sessions still expire or unpair explicitly.

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
