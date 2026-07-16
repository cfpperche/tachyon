# 390 — agent-focus-line — plan

_POC approved 2026-07-16 (`docs/prototypes/agent-focus-line.html` + screenshot)._

## Approach

Project a single **focus line** onto each agent row in the sidebar: truncated text + optional source pill, no new agent-facing protocol required for v1. Resolve text from existing durable stores in fixed priority, render under L2 badges (not in the badge chip row), and add two fleet filters (**On task** / **Has focus**).

Green live-dot already means “alive”; do **not** reintroduce a `working` badge. Parent/child is shown by **tree indent only** — no “delegated by / spawned by” text.

```
priority:  task (MC assignee, open)  →  spawn brief / taskBrief  →  continuity “Current Goal”  →  omit
```

## Key decisions

| Decision | Choice | Rejected |
|----------|--------|----------|
| Surface | One L3 focus line under badges | Extra L2 badge (pollution); separate panel first |
| Source priority | task → brief → continuity goal → omit | Last tool call / activity scrape (noisy) |
| Live-dot vs working | Live-dot only; no `working` chip | Duplicate activity chip |
| Lineage text | Hierarchy indent only | “delegated by X” on row |
| Source pill | Show compact `task` / `brief` / `goal` (POC default on) | Text-only (optional toggle later if dense) |
| Click | Focus line → open MC task if source=task; else Activity or no-op v1 | Always open terminal |
| Filters | All / Live / Needs you + **On task** + **Has focus** | Replace existing chips |
| Authoring | Reuse task assignee + existing continuity/brief | New `set_focus` tool in v1 |
| Terminals | No focus line (AI agents only) | Same line on shells |

## Implementation slices

### 1. Model + resolver (pure)

- Add `FocusSource = "task" | "brief" | "continuity"` and  
  `focus?: { text: string; source: FocusSource; taskId?: string; ageLabel?: string }` on `AgentVM` / projection types.
- Pure function `resolveAgentFocus({ tasks, ledgerDef, continuityContent })` with unit tests (priority, omit, truncate).
- Parse continuity: first non-empty line after `# Current Goal` (or equivalent heading); cap ~60 chars for display, full in tooltip.

### 2. Projection wire (engine / sidebarFleetService)

- When building fleet rows for running AI agents:
  - Query open tasks where `assignee === name` and status ∈ open set (`triaged`/`active` — align with `OPEN_TASK_STATUSES` minus pure `inbox` if desired; prefer **active** first, else latest open assigned).
  - Read ledger `def.contract` / `taskBrief` for brief text (`contract.task` preferred).
  - Read continuity store content for goal line (best-effort; missing → skip).
- Attach `focus` only when resolved; never invent placeholder work.

### 3. Sidebar UI

- Render focus under L2 (match POC: `↳` optional, source pill, task id mono, ellipsis text).
- Tooltip = full text + source + age.
- Click focus (task): navigate Mission Control / open task detail if existing command; else no-op with tooltip only in v1.
- Filters: extend existing chip bar with **On task** / **Has focus** (count badges).
- Do not render `working` attention badge (product choice from POC; live-dot stays). Confirm product: hide only when focus is shown, or always hide `working` — **recommend always hide `working` on AI rows** if live-dot remains (separate small UX if contested).

### 4. Verify + dogfood

- Unit: resolver priority + truncation + multi-task assignee (pick one deterministic rule: prefer `active`, then newest `updatedAt`).
- Unit/UI pure filter tests if filter logic is extracted.
- Dogfood: Dev Host or fleet with ≥1 assigned task, 1 child with brief, 1 continuity-only, 1 empty → visual match POC.
- Spec 390 close after maintainer glance on live sidebar.

## Files (expected)

| Area | Files |
|------|--------|
| Types | `src/sidebar/types.ts`, `agentModel.ts` |
| Resolve | new `src/sidebar/agentFocus.ts` (or under `src/tasks/`) |
| Project | `src/sidebar/sidebarFleetService.ts`, engine projection if needed |
| Continuity read | existing ContinuityStore read path used by badges |
| Tasks | TaskStore list/filter by assignee |
| UI | `src/webview/sidebar/App.tsx` (+ CSS), filter chips |
| Tests | `test/unit/agentFocus.test.ts`, filter/sidebar tests |
| Spec | `docs/specs/390-agent-focus-line/*`, prototype kept as contract |

## Risks

| Risk | Mitigation |
|------|------------|
| Continuity parse fragile | Strict heading match; omit on failure |
| Multiple open tasks per agent | Deterministic pick: `active` then newest |
| Stale goal while task is truth | Priority already prefers task |
| Row height / density | Single line + ellipsis; no wrap |
| Engine vs shell projection split | Resolve on engine side with task+continuity access (same as other badges) |
| Always-hide `working` may surprise | Ship focus first; hide `working` only if still redundant in dogfood |

## Visual impact

- Each AI row may grow ~14–16px when focus present.
- New filter chips.
- Proof: screenshot live sidebar vs POC; EDH or monorepo fleet.

## Sources

- POC `docs/prototypes/agent-focus-line.html` (approved)
- Screenshot 2026-07-16 fleet + POC
- `inferKind` / Agents vs Terminals
- Tasks: `OPEN_TASK_STATUSES`, assignee
- Continuity brief format (`# Current Goal`)
- Ledger `contract` / `taskBrief`
