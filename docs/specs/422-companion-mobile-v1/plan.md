# 422 — companion-mobile-v1 — plan

_Grounded in: `docs/architecture/companion-mobile-v1-research.md`, `src/companion/*`, `src/bridge/Bridge.ts` (127.0.0.1 bind), `tachyon-companion` apps/mobile reserved, SDD 414 protocol._

## Approach

Ship a **thin mobile PWA** that reuses **existing** companion HTTP + pairing. The only hard ADE change is **reachability**: today Bridge listens on loopback only; mobile needs **opt-in LAN** advertisement + QR. Prefer **not** opening full Bridge MCP to the LAN if a companion-only bind is feasible; if not, document that LAN mode exposes the Bridge port and keep MCP auth fail-closed for non-agent tokens.

Clients stay in `cfpperche/tachyon-companion` (`apps/mobile` + shared `protocol` / `api-client`).

## Workstreams

### A — ADE reachability & pair UX

| Item | Detail |
|---|---|
| Setting | `settings.companion.lanAccess` (boolean, default `false`) — enables **mobile via Tailscale** |
| Bind | When true, Bridge `0.0.0.0` + pair URL = Tailscale IP; when false, `127.0.0.1` only |
| Pair issue payload | Single mesh `baseUrl` + pair code + `protocolVersion` + `openUrl` for QR |
| Control UI | QR + copy base URL; Connected devices already supports `kind` |
| Doctor | Warn when LAN access is on |
| Static (optional) | Serve built `apps/mobile` under e.g. `/companion/app/` for one-process dogfood |

**Files (likely):** `src/bridge/Bridge.ts`, `src/companion/*`, config schema, Control companion settings UI, tests for bind/pair payload.

### B — Concurrent sessions (M4)

**v1 decision (2026-07-23):** ship **last-pair-wins** (one active companion session; new pair replaces prior browser or mobile). Concurrent browser+mobile is an explicit follow-up, not a v1 bar.

### C — `apps/mobile` PWA

| Screen | Behavior |
|---|---|
| Pair | Decode QR / paste baseUrl + code; `client.kind=mobile` |
| Home | Roster + attention badges via SSE `/events` or poll fallback |
| Agent | Send short prompt |
| Approvals | List + resolve |
| Settings | Unpair, session expiry |

Stack: Preact + existing api-client; PWA manifest; PRIVACY notes for token storage.

### D — Caps enforcement

Server: no new endpoints for scrollback. Client: do not offer forbidden actions. Optional: method allowlist middleware for mobile kind if needed later.

## Risks

| Risk | Mitigation |
|---|---|
| LAN exposes Bridge port | Opt-in; doctor; prefer companion-only bind; MCP still needs agent token |
| Token on phone | Short session TTL; unpair; no logging |
| Scope creep (terminal, git) | Spec allowlist; reject in review |
| QR encodes wrong IP | List all non-internal IPv4 candidates; allow manual baseUrl |

## Rejected alternatives

| Idea | Why not |
|---|---|
| Depend on `t-784bc8` | Maintainer excluded from trail |
| Native RN/Flutter v1 | Cost; PWA enough |
| Cloud relay | Non-goal |
| Reopen 414 | Sibling product line |
| Full read_output on phone | Secret surface |

## Verification

- Unit: config schema, pair payload includes LAN URL when enabled, loopback default  
- Companion monorepo typecheck + mobile build  
- Human dogfood: real phone, same Wi‑Fi (see tasks.md)  
