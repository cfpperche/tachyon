# 420 — companion-tab-tools-v2

_Created 2026-07-21._  
_Design by grok (`t-a5154a`); probe-adjusted 2026-07-21; awaiting maintainer ratify._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

**Board:** design `t-a5154a` · umbrella `t-ca13aa` · parent product 414 shipped  
**Kind:** product SDD (Companion agent-pull tools v2) — tab targeting, refs, safety, expanded surface  
**Probe:** codex `gpt-5.6-sol` adversarial-review `probe-94a1a975-c98a-4c2d-bed6-7bd8fc19a745` → **block** until identity/confirm/log fixes below.

## Intent

SDD **414** shipped the Companion browser shell: pair, approvals, send-prompt, and a first agent-pull
surface (`user_browser_snapshot|click|type|fill|screenshot|eval|console`) gated by
`settings.companion.tabTools`. That MVP operates on the **active tab** with **CSS selectors**.

When the human and the agent share one browser, “active tab only” races: the human switches tabs and
the agent clicks the wrong page. CSS selectors also break on dynamic UIs.

This spec defines **Companion tab tools v2**: every agent tool targets an **explicit companion tab
handle** (never silent active-tab), scoped to a **document generation** so recycled Chrome tabs
cannot confuse-deputy; prefers **stable element refs (`@eN`)** bound to that document; returns an
**honest result envelope** (including `unknown_outcome` when mutation state is unclear); and ships
**layered safety from day one** (confirm policy, secrets block, redacted mutation audit, optional
domain allowlist). Tool surface expands through **P0** then **P1** — order on board `t-ca13aa`, with
safety/identity prerequisites eligible to land before multi-tab dogfood even if labeled “infra”.

**Done for v2 product** (phased): P0 + foundation + safety + multi-tab dogfood green. P1 is in-scope
of this SDD but gated after P0 dogfood; partial ship is allowed as `shipped-partial`.

**Affected Product Invariants:** none expected. Re-assess if network capture or confirm UX changes a
registered boundary.

## Relation to 414

| | 414 (shipped) | 420 (this) |
|---|---|---|
| Product | Companion shell + first-person MVP | Agent-pull tools contract v2 |
| Tab model | Active tab | **Opaque companion tabId** + document token |
| Element target | CSS selector | **@e refs** scoped to document (+ optional CSS) |
| Safety | Basic trust / agent tab access | Layered confirm, secrets, redacted audit, domain |
| Tools | snapshot, click, type, fill, screenshot, eval, console | + tabs lifecycle, navigate, scroll, keys, wait, then P1 |

414 stays **shipped**. 420 does not reopen 414 status.

## Concept brief

### Product form

| Field | Value |
|---|---|
| Surface | Bridge tools `user_browser_*` + Companion extension fulfillment |
| Audience | Humans running Tachyon locally with paired Companion |
| Primary job | Agent reads/acts on the human’s real browser **without wrong-tab races** |
| Non-job | Replace agent-browser CDP; full RPA; mobile companion |

### Architectural north star (binding)

1. **Explicit companion `tabId` on every tab tool** — never silent “active tab only”.
2. **Document-bound targeting** — tabId alone is not enough; resolve + validate document generation
   (and optional expected URL) immediately before mutate; fail closed on mismatch.
3. **Stable element refs** (`@eN`) scoped to tab + frame + document generation; preferred over CSS.
4. **Honest envelope** including `unknown_outcome` (do not auto-retry unless idempotent).
5. **Layered safety from day one** — not a P1 bolt-on; not heuristic-only.

### Decisions (probe-adjusted — ratify)

| # | Topic | Decision |
|---|---|---|
| 1 | tabId required? | **YES on all mutating/read tools.** Soft active-tab default **rejected**. `tabs_list` has no target. |
| 2 | tabId identity | **Opaque companion tab handle on the wire.** Chrome `tabs.Tab.id` is **internal only**. Handle binds: pair session + browser tab + document generation. Closed/recycled → `stale_tab`. |
| 3 | Stale / wrong document | Before mutate: resolve handle → live Chrome tab; compare document token (and optional `expectedUrl`). Mismatch → `not_applied` / `stale_tab`, never silent retarget. |
| 4 | @e refs | Snapshot assigns `@eN` for interactive/visible nodes. Scope: tabId + frameId + document generation. Prefer `ref` over `selector`; if both, **ref wins** and must match same document. Stale ref → reject (no silent CSS fallthrough). |
| 5 | Selector fallback | Allowed only when caller supplies selector for the **current** document (no auto-fallback from dead ref). Documented as fragile. |
| 6 | Envelope | Shared JSON on all `user_browser_*`. Success/fail include: `requestId`, `protocolVersion`, `tabId` (opaque), `urlBefore`/`urlAfter` when known, `documentTokenBefore`/`documentTokenAfter` when known, `status`: `applied \| not_applied \| timeout \| error \| unknown_outcome`, `code`, `message`. Auto-retry forbidden unless op is proven idempotent. |
| 7 | Confirm policy | **Layered (not heuristic-only, not URL-only):** (a) caller operation class when known; (b) semantic deny/confirm rules for publish / form submit / buy / delete / download (+ dangerous chords); (c) DOM heuristics as **additional signal**; (d) optional `allowedHosts` as boundary. Ambiguous consequential action → human confirm or fail closed. |
| 8 | Secrets | Never return password values, cookie headers, or bearer/token-like attributes in snapshot/read/network. |
| 9 | Mutation audit | Append-only **redacted** log under workspace `.tachyon/companion/mutations.jsonl` (gitignored). Versioned schema; no typed values; hashes/selectors/outcome ok; rotation + retention in plan. |
| 10 | Domain allowlist | Optional `settings.companion.allowedHosts` (globs); empty = all hosts still under confirm rules. |
| 11 | Migration | Existing tools require opaque `tabId` + optional `ref`; breaking under tabTools opt-in is OK. |
| 12 | Protocol | Negotiate `protocolVersion`; bump on wire break; **fail closed** on unknown/missing safety-critical fields. Contract tests for mixed versions. |
| 13 | Delivery order | Board `t-ca13aa` #1–#17. **Gate dogfood on risk prerequisites**, not labels: identity lifecycle, confirm layers, redacted audit, envelope/`unknown_outcome` land with foundation/safety **before** multi-tab dogfood. Product P1 still after dogfood. |

## Phases / board map

### Phase 0 — Design (this task)

- [ ] Ratify decisions table
- [ ] Spec + plan + tasks checked in
- [ ] Board deps unchanged except artifact_refs → this SDD

### Phase 1 — Foundation + safety

- `t-f56a16` tabId + @e + envelope on existing tools  
- `t-5fcbd3` confirm, secrets, audit, domain  

### Phase 2–3 — P0 tools

- `t-e2a48f` tabs_list  
- `t-1994a2` open / activate / close  
- `t-bb2b6d` navigate  
- `t-88d3a8` wait_for  
- `t-161439` scroll  
- `t-44de66` press_key  

### Phase 4 — P0 dogfood

- `t-4ffb40` multi-tab race + P0 happy path  

### Phase 5 — P1 (after dogfood)

- `t-97c49a` directed read  
- `t-1dfdfd` hover / select / checkbox / dnd  
- `t-c5ad8e` full/element screenshot  
- `t-429a08` find text  
- `t-d65e35` upload / download  
- `t-25d335` iframes / shadow / dialogs / windows  
- `t-e7d917` network / HTTP errors  

## Result envelope (contract sketch)

```json
{
  "ok": true,
  "status": "applied",
  "requestId": "…",
  "protocolVersion": 2,
  "tabId": "ctab_…",
  "urlBefore": "https://example.com/a",
  "urlAfter": "https://example.com/b",
  "documentTokenBefore": "…",
  "documentTokenAfter": "…",
  "tool": "user_browser_click",
  "detail": "optional"
}
```

Failure / unknown:

```json
{
  "ok": false,
  "status": "not_applied" | "timeout" | "error" | "unknown_outcome",
  "requestId": "…",
  "protocolVersion": 2,
  "tabId": "ctab_…",
  "urlBefore": "…",
  "code": "stale_tab" | "stale_ref" | "denied" | "restricted" | "not_found" | "needs_confirm" | "…",
  "message": "human-readable",
  "retrySafe": false
}
```

## Acceptance criteria

### Design

- [x] **Scenario: active-tab race is out of contract**
  - **Given** the v2 contract
  - **When** an agent calls a tab tool without companion tabId
  - **Then** the tool is rejected (no active-tab default)
- [x] **Scenario: multi-tab safety (contract)**
  - **Given** tab A and B open, human viewing B
  - **When** agent acts with companion tabId for A (valid document token)
  - **Then** the action must target A only (runtime proof: `t-4ffb40`)
- [x] Decisions table complete after probe (opaque id, layered confirm, redacted audit, unknown_outcome)
- [x] Board umbrella `t-ca13aa` lists full maintainer roadmap
- [x] 414 remains shipped; this is a new SDD
- [ ] Maintainer **ratify** decisions table (blocking)

### Product (implementation — later)

- [ ] **Scenario: tabs_list**
  - **Given** a paired Companion with ≥1 tab
  - **When** agent calls tabs_list
  - **Then** each row has opaque tabId, title, url, active (Chrome id not required on wire)
- [ ] **Scenario: stale target rejected**
  - **Given** a tabId whose document navigated or tab closed
  - **When** agent mutates with that handle
  - **Then** result is not_applied/stale_* with retrySafe false
- [ ] **Scenario: navigate + envelope**
  - **Given** tabId T
  - **When** agent navigates T to a URL
  - **Then** result includes urls/tokens before/after and status applied or unknown_outcome
- [ ] **Scenario: secrets blocked**
  - **Given** a page with a password input
  - **When** snapshot or directed read runs
  - **Then** password values are not present in the payload
- [ ] **Scenario: confirm gate**
  - **Given** an action classified as submit/buy/delete/download
  - **When** agent requests it
  - **Then** host requires human confirm before applied (or returns needs_confirm)

## Non-goals

- Replacing agent-browser / CDP automation  
- Mobile Companion client (`t-fe52f0`)  
- Store packaging / Firefox (may trail)  
- Silent multi-engine multiplexing  
- Returning raw cookies, passwords, or auth headers to agents  
- Making tabTools on by default without human settings  
- Exposing raw Chrome tab ids to agents on the wire  

## Open questions

_Product forks closed in Decisions (probe-adjusted)._ Remaining are implementation details for plan/notes
(confirm UI surface, token format, log rotation bytes, host glob syntax).
