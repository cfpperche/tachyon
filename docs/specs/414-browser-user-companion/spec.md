# 414 — browser-user-companion

_Created 2026-07-19._  
_Design ratified 2026-07-20 (maintainer lean + open-question package)._

**Status:** shipped

**Closure:** Browser Companion MVP landed on ADE main through `c26baecf` (VSIX 0.56.88) + companion monorepo `cfpperche/tachyon-companion` @ 0.4.8. Shipped: loopback pair/unpair + multi-device registry, human send-prompt + approvals, agent-gated `user_browser_*` (snapshot/act/screenshot-to-path), Control Settings (tabTools + Connected devices), Preact side panel without prototype residue. Human dogfood: pair/unpair + tabTools + fixture actuation. Out of this SDD (sibling board, not 414 debt): Firefox/store packaging, mobile client (`t-fe52f0` / `t-619157`), multi-engine picker, Audit trail UI, broader actuation trust policy.

**Verify:** `npm run test:unit -- test/unit/companionPairing` (ADE; extend as surface grows)

<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Board:** design `t-dec8a9` (done) · source pin `p-2112a8` · sibling mobile `t-fe52f0` / `t-619157`  
**Kind:** product SDD (companion external shell) — Phase 0 + browser MVP shipped

## Intent

Tachyon agents and humans collaborate inside the VS Code shell and the engine/Bridge, but most product
work, research, bug repros and operational tools live in the **user's everyday browser**. Today the
only browser path is **agent-owned automation** (`agent-browser`, specs 267/268/271): a headless or
agent-session Chrome driven over CDP. That cannot see the human's real logged-in tabs, cannot surface
approvals where the human already is, and forces copy-paste of URLs, selections and screenshots into
tasks.

This spec defines **Tachyon Companion** (browser app first): a user-installed extension (Chromium
first; Firefox later) that **pairs with the local Tachyon engine** as another thin shell — not a
second orchestrator and not Mission Control in the browser. **v1** turns the browser into a
**sensor + approval surface**: pair, human-push tab context into Tasks, receive and resolve
approvals. Later phases may add agent-pull capture, in-page assist, and tightly scoped actuation.

"Done" for **product v1** means: a human can install the Chromium extension (unpacked dogfood is
enough for first land), pair it to a running workspace engine, send the active tab into the board
without leaving the browser, and Accept/Deny pending approvals there — while agents only ever see
**human-authorized, cookie-free** fields on Tasks/evidence. Cookies, passwords, and raw auth headers
never appear in agent-visible tool results.

**Affected Product Invariants:** none — new external-shell surface; no registered PI promise changes
in v1. Re-assess if a later phase alters a registered boundary.

## Concept brief

### Product form (ratified)

| Field | Value |
|---|---|
| Product name | **Tachyon Companion** |
| First app | Browser (Chromium MV3); subtitle e.g. "for Chrome" |
| Code / SDD slug | `browser-user-companion` / tools namespace `user_browser_*` (agent-pull era) |
| Form | Extension + engine pairing module + optional agent skill |
| Audience | Humans running Tachyon locally (remote engine later) |
| Primary job | Web work context → Tachyon; Tachyon approvals → browser |
| Non-job | Replace Control; replace agent-browser; general RPA |

### Two browser products (must not conflate)

| | **agent-browser (267+)** | **Tachyon Companion (this spec)** |
|---|---|---|
| Who owns the browser | Agent / Tachyon-provisioned session | The human's daily browser |
| Session | Isolated, often headless | User cookies, extensions, SSO as-is |
| Direction | Engine → CDP automation | User browser ↔ engine |
| v1 risk class | Tool + skill provision | Privacy + pairing + shell auth |
| Tool namespace | `agent-browser` launcher | v1: none required (human-push → Task); later `user_browser_*` |

### Repository strategy (ratified)

```text
cfpperche/tachyon                 ← ADE: engine, Bridge, VS Code shell, pairing SERVER, protocolVersion
cfpperche/tachyon-companion       ← classic monorepo of external shells:
                                      apps/browser   (now)
                                      apps/mobile    (next)
                                      packages/protocol, api-client, …
```

- **Hybrid:** engine surface stays in `tachyon`; client UX lives in `tachyon-companion`.
- **Not** a Tachyon runtime plugin (spec 250). **Not** a reason to monorepoize the ADE first
  (`docs/architecture/tachyon-monorepo-assessment.md`, `t-e4348c`).
- **Server owns protocol semantics** (`protocolVersion`); companion monorepo owns client packages that
  mirror it.
- Early engine work for this track uses **one isolated change worktree** for the whole companion
  track (`tachyon/change/companion-track`), not ad-hoc main edits.

### Value for agents assisting projects

1. **Context without paste** — URL, title, selection (+ later screenshot) become Task body/evidence.
2. **Approvals where the human is** — same host-authoritative approval records as Control.
3. **Project loop** — dogfood webapp → rich task → agents fix → verify in the same browser.
4. **Later automation** (v3) — consented fills/clicks on user sessions under scopes + confirm.

### Architecture sketch (v1)

```text
[apps/browser MV3]  --pair token / loopback-->  [Engine pairing + companion endpoints]
        |                                              |
   Send tab / Approvals UI                    create_task · approvals resolve
        |                                              |
   (no cookies)  ---- agents read Tasks/board ---->  (human-push only in v1)
```

v1 does **not** require Bridge tools for capture. Agents consume Task artifacts already on the board.
Agent-pull (`user_browser_*`) is **v1.1+**.

### Security posture (v1 principles)

- **Least privilege:** default `activeTab` + user gesture; avoid always-on `<all_urls>`.
- **No credential exfil:** agents never receive cookies, passwords, or raw auth headers.
- **Pairing:** short-lived codes / local loopback; hardened token storage; one-click unpair.
- **No self-approval:** extension UI is presentation + human gesture; resolution is host-recorded;
  agents confirm via `get_approval_status` (or equivalent), never the UI string alone.
- **Engine offline:** clear error or local draft queue — no orchestration inside the extension.
- **Fail closed** on unknown host, expired pair, or missing scope.
- **One active pair** in v1 (single engine); multi-engine picker later.

### Phased delivery (ratified)

| Phase | Scope | Ship gate (sketch) |
|---|---|---|
| **v1 — Companion** | Pair; connection badge; send tab → task; list + resolve approvals | Chromium unpacked dogfood |
| **v1.1** | Agent-pull capture; screenshot evidence quality; Firefox | Optional store packaging |
| **v2 — In-page assist** | Overlay/side panel; suggestions without write | Visual QA + consent copy |
| **v3 — Actuation** | Scoped click/fill on allowlisted hosts + per-action confirm | Trust policy sibling to 271 |

## Acceptance criteria

### Design (Phase 0)

- [x] **Scenario: design distinguishes user companion from agent-browser**
  - **Given** a reader of this seed and specs 267/268/271
  - **When** they compare ownership, session model and tool namespaces
  - **Then** the two products are explicitly non-substitutable and non-merged in intent
- [x] **Scenario: v1 MVP is bounded**
  - **Given** the ratified concept
  - **When** implementation is scoped
  - **Then** v1 is limited to pair + human-push capture + approval surface (no form-driving, no full Control clone)
- [x] **Scenario: agent-visible context is human-authorized and cookie-free**
  - **Given** the ratified security posture
  - **When** a human sends a tab capture
  - **Then** agents only ever observe authorized capture fields on Tasks/evidence; cookies/credentials are out of band
- [x] **Scenario: approval resolution stays host-authoritative**
  - **Given** an approval shown in the companion UI
  - **When** the human accepts or denies
  - **Then** the engine records the resolution; agents must use the host status path, not the UI string alone
- [x] Concept brief, security, phases, non-goals, and **decided** open questions are present
- [x] Board design task `t-dec8a9` links this SDD and pin `p-2112a8`
- [x] Repo strategy (ADE + `tachyon-companion` monorepo) is recorded
- [x] Related work (`t-fe52f0`, agent-browser, ADE monorepo assessment) is named

### Product v1 (implementation)

- [x] **Scenario: pair extension to local engine**
  - **Given** a running Tachyon engine for a workspace and an installed Chromium extension
  - **When** the human completes pairing with a short-lived code from Control (or equivalent)
  - **Then** the extension shows connected state for that workspace and can call authorized companion endpoints
- [x] **Scenario: send active tab into a Task**
  - **Given** a paired extension on an ordinary page and a user gesture
  - **When** the human chooses "Send to Tachyon"
  - **Then** a Task appears with URL and title (selection optional); no cookies in the task payload
  - **Note (evolution):** also ships idle-safe **send prompt → active agent** (`t-523405`) and agent-pull tab tools under `settings.companion.tabTools`
- [x] **Scenario: receive and resolve an approval in the browser**
  - **Given** a pending human approval in the engine
  - **When** the extension is paired and online
  - **Then** the human can Accept/Deny from the extension and host approval status reflects the record
- [x] **Scenario: single active pair**
  - **Given** an extension already paired to engine A
  - **When** the human pairs to engine B (or re-pairs)
  - **Then** at most one active pair remains; the UI does not silently multiplex engines in v1
  - **Note (evolution):** Control **Connected devices** lists paired devices and supports force-unpair; still one live session model per engine, not multi-engine picker
- [x] Unpacked Chromium dogfood checklist recorded in `notes.md` or `tasks.md` Human dogfood section

## Non-goals

- Replacing or forking Mission Control / Control as a full browser app in v1
- Merging with `agent-browser` CDP automation or reusing its session store as the user session
- Agent-initiated arbitrary DOM/JS execution or always-on full-history scraping
- Agent-pull Bridge tools in v1 (`user_browser_*` is v1.1+)
- Safari first-class support in v1 (Chromium first; Firefox next)
- Multi-engine picker in v1
- Mobile companion UX in this SDD's v1 ship (reserved in `tachyon-companion` monorepo; product sibling of `t-fe52f0` frente 2)
- Marketplace monetization or multi-tenant SaaS hosting of engines
- Monorepoizing the ADE as a prerequisite (`t-e4348c` is independent)
- Changing PI-001 or any registered product invariant without separate governance

## Open questions → Decisions (2026-07-20)

| # | Question | Decision |
|---|---|---|
| 1 | Umbrella vs standalone | **Standalone product line**, sibling of `t-fe52f0` (shared pairing protocol later; separate task tree) |
| 2 | MVP depth | **Pair + send-tab + approvals** together in v1 (not capture-only) |
| 3 | External client substrate | **Loopback spike now**; do not block on full `t-784bc8`; extract durable client contract from what works |
| 4 | Tool surface v1 | **Human-push only**; agent-pull in v1.1 |
| 5 | Multi-workspace | **One active pair** in v1; multi-engine later |
| 6 | Evidence store | **Task / evidence (273–274 lineage)**; not pins; no new evidence kind in v1. Screenshot may trail URL+title |
| 7 | Name | **Product:** Tachyon Companion · **Repo clients:** `tachyon-companion` · **Code/SDD:** browser-user-companion / `user_browser_*` |

_No open product forks remain for Phase 0. Implementation unknowns go to `plan.md` / `notes.md`._
