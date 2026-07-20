# 414 — browser-user-companion — plan

_Drafted 2026-07-20 after design ratify. Approach for v1; not the checkbox steps (see `tasks.md`)._

## Approach

Deliver Tachyon Companion **v1** as two coordinated codebases with one protocol:

1. **`cfpperche/tachyon` (this repo, track worktree `tachyon/change/companion-track`)**  
   Engine owns: `protocolVersion`, short-lived pair codes, loopback companion endpoints, create-task from
   capture payload, approval list + resolve (host-authoritative), Control affordance to show pair code.

2. **`cfpperche/tachyon-companion` (new classic monorepo)**  
   Clients own: `apps/browser` (MV3), reserved `apps/mobile`, shared `packages/protocol` + `api-client`.

v1 path: human pairs → sends tab → Task on board → agents use normal board tools. Approvals appear in
the extension and resolve through the same host records as Control. No agent-pull tools in v1.

Implementation order: **scaffold monorepo → protocol + pairing → send-tab → approvals → dogfood**.

All ADE-side work for this track stays on **one isolated worktree/branch** (`companion-track`) until
landing slices are reviewed.

## Key decisions

- **Hybrid repos** — ADE single-package stays; companion monorepo multi-app. Rejected putting browser/mobile
  inside `tachyon` (store cadence, privacy CI, verify:full pollution). See
  `docs/architecture/tachyon-monorepo-assessment.md`.
- **Sibling of `t-fe52f0`, not child** — avoids blocking on mobile umbrella; share protocol later.
- **Loopback first** — dogfood value without waiting for full external-client program (`t-784bc8`).
- **Human-push only in v1** — consent is obvious; agents read Tasks; `user_browser_*` deferred.
- **One active pair** — cuts multi-engine edge cases for dogfood.
- **Task evidence, not pins** — captures are work items (bugs/repros), not durable knowledge pins.
- **Approval anti-laundering unchanged** — companion UI is never proof; host status is.

## Protocol sketch (v1, non-normative detail until spike)

| Concern | Direction | Notes |
|---|---|---|
| `protocolVersion` | both | Fail closed on mismatch with clear upgrade copy |
| Pair / unpair | client ↔ engine | Short-lived code from Control (or equivalent); one active pair |
| Session token | client → engine | Not the agent Bridge token; companion-scoped |
| `sendCapture` | client → engine | URL, title, optional selection; no cookies |
| `listApprovals` / `resolveApproval` | client ↔ engine | Same records as Control → Approvals |
| Status / badge | client → engine | Connected / offline / expired |

Exact transport (HTTP loopback vs control-channel extension) is chosen in the pairing spike; must remain
local-first and fail closed when the engine is down.

## Module map

### ADE (`tachyon`) — expected touch classes

| Area | Role |
|---|---|
| Engine pairing module (new) | Codes, token lifecycle, active pair registry |
| Companion HTTP/control handlers | Endpoints for pair, capture, approvals |
| Task creation path | Map capture → `create_task` fields + optional evidence |
| Approvals projection | List pending + resolve for companion principal |
| Control UI | “Show pair code” / unpair / companion status |
| Tests | Unit + focused integration for pairing and capture |
| Docs / skill (optional v1.1) | How agents should treat companion-originated tasks |

### Companion monorepo — expected layout

```text
tachyon-companion/
  apps/browser/           # MV3: background, popup, pair, send-tab, approvals
  apps/mobile/            # reserved README until mobile slice
  packages/protocol/      # types + protocolVersion
  packages/api-client/    # pair, sendCapture, approvals
  docs/PRIVACY.md
  package.json            # workspaces
```

## Delivery slices (board)

| Order | Slice | Primary repo | Depends on |
|---|---|---|---|
| 1 | Scaffold `tachyon-companion` monorepo (browser stub + packages) | companion | — |
| 2 | Engine protocol + loopback pairing + Control pair code | ADE track WT | protocol shapes |
| 3 | Send tab → create_task (URL + title) | both | pairing |
| 4 | Approvals list + resolve in browser | both | pairing |
| 5 | Unpacked Chromium dogfood + notes | both | 2–4 |

Screenshot evidence, agent-pull tools, Firefox, multi-engine, mobile app = post-v1.

## Risks & unknowns

| Risk | Mitigation |
|---|---|
| Pairing token mishandled like agent Bridge token | Distinct companion credential; short TTL; unpair |
| Extension over-permission (`<all_urls>`) | v1 `activeTab` + gesture only |
| Approval UI treated as proof by agents | Same anti-laundering docs/tests as Control |
| Conflated with agent-browser | Namespaces, docs, skill copy |
| Loopback blocked by browser CORS/mixed rules | Spike early; adjust transport in slice 2 |
| Store review later | Unpacked dogfood first; PRIVACY.md from day one in companion repo |
| ADE monorepo distraction | Explicit non-goal; `t-e4348c` separate |

## Visual impact

v1: extension popup (connection badge, Send tab, approvals list). Dense, Control-adjacent copy.
Visual QA on popup after UI exists (screenshots under track evidence or companion repo).
ADE Control: small “pair companion” affordance — follow existing Control DS.

## Sources consulted

- `docs/system-design.md` — engine/shell split
- `docs/architecture/tachyon-monorepo-assessment.md` — why ADE stays single-package
- `docs/specs/267-plugin-agent-browser` (+ 268, 271) — different product
- Spec 382 — persistent engine/shell boundary
- Approval tools / Control Approvals — host authority model
- Spec 273/274 — evidence channel for later screenshots
- `t-fe52f0`, pin `p-2112a8`, design task `t-dec8a9`
