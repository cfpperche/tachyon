# Companion Mobile v1 — research (Tachyon-first)

_Status: **ratified** 2026-07-21 (maintainer). Product SDD: `docs/specs/422-companion-mobile-v1/`. Board umbrella: `t-af2c9b`._  
_Research task: `t-619157` (done). Author: grok._  
_Orca / other products: **reference only** (appendix). Not a blueprint._

## 1. Problem (Tachyon)

Humans already run Tachyon as a **local fleet** (engine + Bridge + VS Code Control/sidebar). Away from the desk they cannot:

- See whether agents are idle / need input / failed
- Answer a short prompt or approve something without opening the laptop
- Confirm the workspace is still paired and healthy

**Job to be done (v1):** a **phone-reachable, local-first shell** that observes and lightly acts on the **same engine** that Control uses — not a second orchestrator, not Mission Control cloud, not a browser-tab automation client.

**Primary user:** maintainer / power user on the same LAN (or equivalent tunnel) as the machine running the engine.

## 2. Constraints (binding for this trail)

| Constraint | Source |
|---|---|
| Do **not** depend on Runtime API extraction (`t-784bc8`) | Maintainer 2026-07-21 |
| Do **not** reopen SDD 414/420 | 414 shipped; mobile is sibling |
| Clients live in `cfpperche/tachyon-companion` (`apps/mobile` reserved) | 414 repo strategy |
| Engine owns protocol semantics (`protocolVersion`, pairing) | 414 + `src/companion/*` |
| Orca is **optional inspiration**, not requirements | Maintainer 2026-07-21 |
| No cloud pairing / SaaS relay in v1 | Product lean local-first |
| No native store app required for v1 | Task ask + cost |

## 3. What already exists (inventory)

### ADE (`tachyon`)

| Piece | Location | Notes for mobile |
|---|---|---|
| Pair codes + session tokens | `CompanionPairingService` | Companion token ≠ Bridge agent token; TTL pair ~5m, session ~24h |
| HTTP surface | `GET/POST /companion/v1/*` on **Bridge listener** | `health`, `pair`, `status`, `unpair`, `agents`, `prompt`, `events` (SSE), `approvals*`, tab channel |
| Client kinds | `protocol.ts` `client.kind: "browser" \| "mobile"` | **Already modeled** |
| Connected devices UI | Control Settings | Host-facing rows; no session token in UI |
| Live push | `CompanionLiveSync` SSE `/events` | Full snapshots (loopback-era design) |
| Agent list + send prompt | Companion ops | Human → agent path exists for browser shell |
| Approvals list/resolve | Companion HTTP | Host-authoritative |

### Critical host fact

Bridge companion HTTP is served on the **same loopback bind** as Bridge MCP:

```text
server.listen(port, "127.0.0.1", …)
base URL shape: http://127.0.0.1:<port>/companion/v1/*
```

A phone on Wi‑Fi **cannot** reach `127.0.0.1` on the workstation without an extra hop (adb reverse, SSH tunnel, or **LAN bind**). This is the main engineering fork for mobile — not “missing Orca features”.

### Companion monorepo

| Piece | State |
|---|---|
| `apps/browser` | Shipped (pair, sidepanel, tab tools client) |
| `apps/mobile` | **Reserved** README only |
| `packages/protocol` + `api-client` | Reusable; pair/status/agents/prompt/approvals/events |

### Board

| Task | Role |
|---|---|
| `t-619157` | This research |
| `t-fe52f0` | Umbrella frente 2: pair mobile + webapp install (frente Control already landed) |
| `t-cb36c5` | Browser long-tail only — **out of trail** |
| `t-784bc8` | **Out of trail** |

## 4. Product form proposal (v1)

| Field | Proposal | Rationale |
|---|---|---|
| Name | **Tachyon Companion (Mobile)** — same product line | Continuity with 414 naming |
| Form | **Local web app / installable PWA** in `apps/mobile` | No store; reuses web stack; phone home-screen install |
| How it is served | Static assets **served by the engine** (or Bridge static mount under `/companion/app/…`) on a **phone-reachable URL** | One process to run; no separate “mobile daemon” in v1 |
| Stack | Preact (or shared companion UI kit) + existing `api-client` | Align with browser-ui lean; avoid RN/Expo for v1 |
| Source of truth | Engine / workspace on the PC | Phone is thin shell |

**Not v1:** React Native / Flutter store binaries, TestFlight/Play, cloud push (APNs/FCM).

## 5. Reachability & pairing proposal

### 5.1 Network modes (decide at ratify)

| Mode | Phone → engine | Security posture | v1? |
|---|---|---|---|
| **A. LAN bind (recommended)** | Engine advertises `http://<lan-ip>:<port>` (+ optional mDNS later) | Pair token + optional TLS later; only on trusted LAN | **Yes — default proposal** |
| **B. Loopback + device tunnel** | `adb reverse` / SSH `-R` to phone localhost | Stronger isolation; worse UX | Dogfood escape hatch |
| **C. Cloud relay** | Out of scope | — | **No** |

**Proposal:** v1 = **Mode A** with explicit human opt-in (“Allow companion on LAN”), default remain loopback-only for browser-era safety until enabled. Pair UI shows **QR encoding `{ baseUrl, pairCode, protocolVersion }`** so the phone never types IP by hand.

### 5.2 Auth (reuse + small deltas)

| Mechanism | Proposal |
|---|---|
| Pair code | Keep short-lived code from Control / “Pair Companion” |
| Session | Existing companion session token in `Authorization: Bearer` |
| Unpair / revoke | Existing unpair + Control force-unpair; mobile must call unpair on sign-out |
| Multi-device | Today one active session replaces previous — **keep for v1** unless ratify multi-session (phone + browser at once). **Open question:** allow **one browser + one mobile** concurrently? Proposal: **yes if cheap** (registry already multi-row oriented); else document “last pair wins” as temporary |
| Expiry | Keep session TTL; mobile surfaces countdown + re-pair |

### 5.3 ADE surface minimum (not Runtime API epic)

Only if ratify Mode A:

1. Config: `settings.companion.lanAccess: false | true` (name bikeshed OK)
2. When true: bind companion (or whole Bridge — **prefer companion-only path if feasible**) on LAN interface or `0.0.0.0` with firewall docs
3. Pair payload / Control UI includes LAN base URL(s) + QR
4. Optional: serve `apps/mobile` dist from engine static route

**No** need for unified CLI/Bridge service-layer extraction to ship this.

## 6. Capabilities v1 (allowlist)

Phone is high-risk if it can dump terminals or run arbitrary host actions. **Fail closed** outside this table.

| Capability | v1 | Via existing `/companion/v1`? | Notes |
|---|---|---|---|
| Pair / unpair / status | **Yes** | Yes | |
| Live roster (agents + coarse state) | **Yes** | `agents` + SSE `events` | Prefer SSE over poll |
| Attention / needs-input badge | **Yes** | events snapshot fields if present; else derive from agent list | May need small projection enrich — still companion-scoped |
| Send short prompt to named agent | **Yes** | `prompt` | Idle-safe rules as today |
| List + resolve **approvals** (host-authoritative) | **Yes** | `approvals*` | Same as browser companion |
| Read full terminal scrollback / `read_output` | **No (v1)** | — | Secret-rich; defer |
| Arbitrary `write_input` / keystrokes | **No (v1)** | — | Too easy to hijack session; prompt path only |
| Host-action / schedule approve beyond existing approval records | **Only if already approval-shaped** | approvals | Do not invent mobile-only broker |
| Browser tab tools (`user_browser_*`) | **No** | tab channel is browser extension | Different shell |
| Git / worktree / source control UI | **No** | — | Laptop job |
| Multi-engine picker | **No** | — | 414 deferred |

**v1 “done” story:** on the couch, pair once → see agent needs input → send one line or Accept/Deny approval → unpair.

## 7. Risks (LAN)

| Risk | Mitigation (v1) |
|---|---|
| LAN attacker pairs with stolen code | Short TTL; show code only in Control; rate-limit pair; optional confirm dialog on host when pair succeeds |
| Session token theft on LAN | HTTPS later; v1: trusted LAN only + session TTL + unpair; never log token |
| Token in phone screenshots / backups | OS keystore later; v1: memory + private storage, warn in PRIVACY |
| Accidental `0.0.0.0` expose on hostile network | Opt-in LAN; default loopback; doctor warns if LAN on |
| Scrollback / secrets on phone | **Not in v1** read_output |
| Confused deputy (phone drives agents) | Only prompt + approvals; no raw terminal inject |
| SSE snapshot size on mobile radio | Keep payloads small; no full scrollback in events |

## 8. Non-goals (v1)

- Cloud account, multi-user SaaS, Orca parity
- `t-784bc8` Runtime API unificação
- Replacing Control / Mission Control
- Native store apps
- Browser tab automation from phone
- Full terminal multiplex on phone
- Offline engine (phone cannot run fleet alone)

## 9. Decision table — **RATIFIED 2026-07-21**

| # | Topic | Decision | Alternatives rejected |
|---|---|---|---|
| M1 | Form | PWA / local web in `apps/mobile` | RN later |
| M2 | Network | Opt-in LAN bind + QR pair | Tunnel-only only / cloud |
| M3 | Protocol | Extend `/companion/v1` + existing pair; `client.kind=mobile` | New `/mobile/v1` namespace |
| M4 | Concurrent devices | Prefer browser+mobile co-exist if low cost; else last-pair-wins documented | Force single device forever |
| M5 | Caps | Roster + attention + prompt + approvals only | read_output / full terminal |
| M6 | ADE scope | Minimal: LAN flag, QR/baseUrl, static mobile assets | Full Bridge redesign / `t-784bc8` |
| M7 | SDD | `422-companion-mobile-v1` | Fold into 414 |
| M8 | Board | Umbrella `t-af2c9b` + `t-fe52f0` frente 2 | — |

## 10. Suggested implementation order (after ratify)

1. Scaffold SDD `NNN-companion-mobile` (spec/plan/tasks) from this table  
2. ADE: LAN opt-in + pair UI QR/baseUrl (fail closed when off)  
3. `apps/mobile`: pair screen + status + agent list (read-only)  
4. Prompt send + approvals  
5. PWA manifest / “Add to Home Screen” notes  
6. Human dogfood on real phone (same Wi‑Fi)  
7. Hardening: revoke, doctor LAN warning, PRIVACY update  

## 11. Open questions (need human)

1. **LAN default:** opt-in only (recommended) vs always-on for dogfood machines?  
2. **Browser + mobile simultaneous:** required for v1 or can wait?  
3. **TLS on LAN:** defer to v1.1 or require from day one (mkcert / local CA)?  
4. **Serve mobile from engine vs separate `vite preview` for dogfood:** engine static preferred for “one command”; dev may use companion monorepo dev server pointed at LAN base URL.

## Appendix A — External references (non-binding)

Other products (e.g. Orca mobile companion) show that “phone shell + desktop source of truth + pair” is a viable pattern. They are **not** acceptance criteria. Steal ideas only when they match Tachyon constraints above; discard cloud-centric or full-desktop-remote designs.

## Appendix B — Mapping to original `t-619157` ask

| Original deliverable | Where answered |
|---|---|
| v1 as local web/PWA | §4 |
| Pairing/auth LAN, expiry, revoke | §5 |
| Capabilities v1 | §6 |
| LAN secret risks | §7 |
| Bridge vs CLI | §5.3 / §8 — **Bridge/companion HTTP path; no CLI required; no `t-784bc8`** |
