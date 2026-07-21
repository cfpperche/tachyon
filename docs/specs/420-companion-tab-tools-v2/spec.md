# 420 — companion-tab-tools-v2

_Created 2026-07-21._  
_Design draft by grok (`t-a5154a`); awaiting maintainer ratify._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

**Board:** design `t-a5154a` · umbrella `t-ca13aa` · parent product 414 shipped  
**Kind:** product SDD (Companion agent-pull tools v2) — tab targeting, refs, safety, expanded surface

## Intent

SDD **414** shipped the Companion browser shell: pair, approvals, send-prompt, and a first agent-pull
surface (`user_browser_snapshot|click|type|fill|screenshot|eval|console`) gated by
`settings.companion.tabTools`. That MVP operates on the **active tab** with **CSS selectors**.

When the human and the agent share one browser, “active tab only” races: the human switches tabs and
the agent clicks the wrong page. CSS selectors also break on dynamic UIs.

This spec defines **Companion tab tools v2**: every agent tool targets an **explicit tabId**, prefers
**stable element refs (`@eN`)** from a snapshot, returns an **honest result envelope**, and ships
**safety controls from day one** (confirm, secrets block, mutation audit, optional domain allowlist).
It also expands the tool surface through **P0** (tabs, navigate, scroll, keys, wait) then **P1**
(hover/forms extras, upload/download, full/element screenshot, directed read, frames/dialogs,
find text, network) — order fixed on board `t-ca13aa`.

**Done for v2 product** (phased): P0 + foundation + safety + multi-tab dogfood green. P1 is in-scope
of this SDD but gated after P0 dogfood; partial ship is allowed as `shipped-partial`.

**Affected Product Invariants:** none expected. Re-assess if network capture or confirm UX changes a
registered boundary.

## Relation to 414

| | 414 (shipped) | 420 (this) |
|---|---|---|
| Product | Companion shell + first-person MVP | Agent-pull tools contract v2 |
| Tab model | Active tab | **Explicit tabId** |
| Element target | CSS selector | **@e refs** (+ selector fallback) |
| Safety | Basic trust / agent tab access | Confirm matrix, secrets, audit, domain |
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

1. **Explicit `tabId` on every tab tool** — never silent “active tab only” as the sole path in v2.
2. **Stable element refs** from snapshot (`@e1` …) preferred over fragile CSS.
3. **Honest envelope**: target tabId, URL before/after when relevant, status
   `applied | not_applied | timeout | error` (+ code/message).
4. **Safety from day one** — not a P1 bolt-on.

### Decisions (proposed — ratify with design task)

| # | Question | Proposal |
|---|---|---|
| 1 | tabId identity | **Chrome `tabs.Tab.id` as string** when available; extension maps session. Closed tab → fail `stale_tab`. |
| 2 | tabId required? | **Required on all mutating/read tools in v2.** `tabs_list` has no target tab. Soft default to active tab is **rejected** (reintroduces race). |
| 3 | @e refs | Snapshot assigns `@eN` for interactive/visible nodes; refs valid until next snapshot **or** navigation on that tabId. Prefer `ref` over `selector`; if both, **ref wins**. |
| 4 | Selector fallback | Allowed when no ref; documented as fragile. |
| 5 | Envelope | Shared JSON shape on all `user_browser_*` results (success and fail). |
| 6 | Confirm matrix | Human confirm for: publish, form submit, buy, delete, download (+ optional dangerous key chords). Exact matchers in plan (URL patterns + action kinds + heuristic labels). |
| 7 | Secrets | Never return password field values, cookie headers, or bearer/token-like attributes in snapshot/read/network. |
| 8 | Audit log | Append-only under workspace `.tachyon/companion/mutations.jsonl` (agent-visible summary ok; no secrets). |
| 9 | Domain allowlist | Optional `settings.companion.allowedHosts` (globs); empty = all hosts subject to confirm rules only. |
| 10 | Migration | Existing tools gain required `tabId` + optional `ref`; breaking change acceptable under tabTools opt-in. |
| 11 | Protocol | Bump companion protocolVersion when wire shape breaks (tabId on commands); keep fail-closed version check. |
| 12 | Delivery order | Board `t-ca13aa` #1–#17 (design → foundation → safety → P0 tools → dogfood → P1). |

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
  "tabId": "123456789",
  "urlBefore": "https://example.com/a",
  "urlAfter": "https://example.com/b",
  "tool": "user_browser_click",
  "detail": optional
}
```

Failure:

```json
{
  "ok": false,
  "status": "not_applied" | "timeout" | "error",
  "tabId": "123456789",
  "urlBefore": "…",
  "code": "stale_tab" | "denied" | "restricted" | "not_found" | "needs_confirm" | "…",
  "message": "human-readable"
}
```

## Acceptance criteria

### Design

- [ ] **Scenario: active-tab race is out of contract**
  - **Given** the v2 contract
  - **When** an agent calls a tab tool without tabId
  - **Then** the tool is rejected (or is not registered as active-tab-only)
- [ ] **Scenario: multi-tab safety**
  - **Given** tab A and B open, human viewing B
  - **When** agent acts with tabId=A
  - **Then** the action applies to A (dogfood scenario owned by `t-4ffb40`)
- [ ] Decisions table is complete (no open product forks for P0)
- [ ] Board umbrella `t-ca13aa` lists all maintainer roadmap items
- [ ] 414 remains shipped; this is a new SDD

### Product (implementation — later)

- [ ] **Scenario: tabs_list**
  - **Given** a paired Companion with ≥1 tab
  - **When** agent calls tabs_list
  - **Then** each row has tabId, title, url, active
- [ ] **Scenario: navigate + envelope**
  - **Given** tabId T
  - **When** agent navigates T to a URL
  - **Then** result includes urlBefore/urlAfter and status applied
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

## Open questions → for ratify

All product forks listed under **Decisions (proposed)**. Implementation details (exact confirm UI,
mutation log rotation size, host glob syntax) land in `plan.md` / `notes.md` during build.
