# Spec 245 — Project Handoff (shared per-workspace work-state, two-lane)

**Status:** shipped (0.32.0) · **Date:** 2026-06-22 · **Follows:** spec 241 (per-agent continuity), 236 (Bridge tools), 239/243 (.tachyon/activity + atomic-append discipline) · **Surface:** new `src/handoff/` engine module + `bridge/tools.ts` (3 tools) + sidebar panel + `AgentManager` stop-nudge + `loadConfig` (`handoff.path`) · **Review:** codex (design debate done — two-lane model; impl review) · **EDH:** pending (sidebar panel + nudges are UI — user gate)

> **Origin:** first concrete step of the "migrate Agent0's harness into Tachyon, minimal pollution" thesis. Agent0 has a single per-project `HANDOFF.md`; Tachyon has only per-agent continuity (241). This adds the missing **project-level** work-state to Tachyon — Tachyon owns the ORCHESTRATION (read/write/surface/nudge); the PROJECT owns the artifact (a git-tracked markdown). Codex design debate (2026-06-22) converged on a **two-lane** model.

## Problem

Tachyon has no notion of "where the WORK stands" at the project level. Per-agent continuity (241) recovers an
individual agent's thread but is fragmented across N agents — no shared, curated state of the project that a human
or a freshly-(re)started agent can read to know what's done / active / next / decided. In a multi-agent workspace,
no single agent has the whole-project picture, so "whoever stops rewrites the handoff" produces fragmented,
conflicting edits.

## Goal

A **Project Handoff**: one shared, curated, git-tracked markdown per workspace root — distinct from and coexisting
with per-agent continuity — kept fresh without N-agent write conflicts or context-polluting injection.

## Decisions (locked; D4 via codex debate)

- **D1 — name + scope.** "Project Handoff", workspace-root-scoped (1 per folder). NOT "continuity" (per-agent;
  conflating confuses). Does NOT aggregate continuity — different purpose.
- **D2 — artifact = project domain, git-tracked.** Canonical file `.tachyon/HANDOFF.md`, path overridable via
  `tachyon.yml` (`handoff.path`). Tachyon ensures it's tracked (gitignore exception `!HANDOFF.md` under `.tachyon/`,
  or honor the override). Default template = 4 sections (Current State / Active Work / Next Actions / Decisions &
  Gotchas); free markdown, recommended not forced.
- **D3 — anti-pollution surfacing.** NO full-content injection into agent context (Agent0's abandoned mistake). A
  Bridge tool for on-demand read/write + a ONE-LINE SessionStart pointer ("a project handoff exists; read it via
  `get_project_handoff` if resuming") + a human sidebar panel.
- **D4 — two-lane authorship (the crux, codex-debated).**
  - **Canonical lane** `.tachyon/HANDOFF.md`: human/owner-curated; full rewrite only; **CAS** (compare-and-swap on
    a content hash) so a rewrite can't clobber a concurrent one.
  - **Pending lane** `.tachyon/handoff-notes.jsonl`: append-only, atomic (the spec-243 atomic-write discipline);
    EVERY agent may append a structured delta `{ts, agent, kind: completed|blocked|decision|gotcha|next, summary,
    evidence[]}`. Agents NEVER rewrite the canonical file → zero markdown-merge conflict.
  - Human/owner distills pending notes into the canonical handoff (manual in v1).
- **D5 — trigger = stop/milestone, DOWNGRADED action, workspace cooldown.** When an agent stops, nudge it to
  *append a note IF its work changed project state* — NOT to "update the handoff". Throttle per-workspace (not
  per-agent) so N stops don't spam. Narrow prompt.
- **D6 — staleness ≠ mtime; track against activity.** Panel states: `Fresh` (no project activity/notes since last
  canonical rewrite) · `Needs distill` (pending notes exist) · `Possibly stale` (activity after last rewrite, no
  notes) · `Old` (age threshold). The signal is "work happened after the last curated state", not file age.
- **D7 — conflict model.** `append_project_handoff_note` (all agents; atomic append; no markdown merge) ·
  `get_project_handoff` (canonical + pending count + staleness) · `set_project_handoff` (full rewrite; CAS on
  expected hash; rejects on mismatch). No N-agent read-modify-write of the markdown.

## v1 scope (everything above) · explicitly DEFERRED to v1.1
- **DEFERRED:** `mark_handoff_notes_distilled(ids)` + assisted distill (an agent drafts the canonical update from
  pending notes for human approval). v1 ships the spine; the distill is manual and the "Needs distill (N)" panel
  state makes the debt visible. (Mitigates the codex riskiest assumption — "will the human distill often enough" —
  by surfacing it, not automating it, in v1.)

## Engine / boundary
- New `src/handoff/ProjectHandoffStore.ts` — PURE helpers (path resolution, note parse, staleness compute, CAS
  hash) + thin fs (read canonical, append note, CAS write). No `vscode` import (engine-boundary, spec 233).
- Bridge tools in `bridge/tools.ts` bind engine capabilities (spec 236 shape).
- Sidebar panel in the webview (host/UI layer); the engine exposes a snapshot (canonical text + pending count +
  staleness state), the UI renders it (spec 237 "host owns state, UI renders").

## Increments
- **A — pure store + tests.** Paths, note schema + parse (skip bad lines), CAS write (hash compare), atomic append
  (temp+rename / O_APPEND), staleness compute from (last-rewrite, activity-since, pending-count). Unit-tested in node.
- **B — Bridge tools + tests.** `get`/`append`/`set_project_handoff` wired; CAS rejection path; append atomicity.
- **C — nudges.** SessionStart one-line pointer (only when a non-trivial handoff exists) + stop append-nudge with
  workspace cooldown. Reuses the spec-243 `--settings` injection channel for the pointer (additive).
- **D — sidebar panel + staleness.** Read-only panel: canonical render + pending-note count + staleness badge.
- **E — config + gitignore + finalize.** `handoff.path` in tachyon.yml (+ schema), gitignore exception, default
  template seed-on-first-write, codex impl review, publish.
- **F — smarter append-nudge (0.32.1, post-dogfood refinement).** The inc-C nudge fired on idle + a per-workspace
  cooldown ALONE → an agent that already logged (or judged its work not note-worthy) got re-nudged every cooldown
  (real dogfood fatigue). Add a per-agent **activity-lag gate** (mirrors continuity's lag idea, spec 241): nudge
  only when the agent did ≥ `HANDOFF_NUDGE_LAG` (25) new activity records since its anchor, where the anchor
  advances on BOTH a nudge AND an append — so the same work never re-fires. Pure `shouldRemindHandoff` (unit-tested);
  cooldown stays the per-workspace anti-spam outer throttle. Codex review: SHIP (no findings). Motivated by the
  📌 pinned dogfood observation below.

## Non-goals
- Aggregating/auto-composing the canonical handoff from continuity or activity (rejected — launders partial
  agent-local context into fake project truth).
- Replacing per-agent continuity (241) — they coexist.
- v1.1 assisted distill / `mark_distilled` (deferred above).
- Non-markdown formats; multi-file handoffs.

## Risks
- **R1 — distill habit doesn't form** (codex's riskiest assumption) → canonical goes stale, notes pile up.
  Mitigation v1: make the debt loud (`Needs distill (N)` panel state + stop-nudge to append). v1.1: assisted distill.
- **R2 — markdown write conflicts.** Mitigation: D7 — agents only append (atomic JSONL); canonical rewrite is CAS.
- **R3 — context pollution** (the Agent0 mistake). Mitigation: D3 — one-line pointer + on-demand tool, never a dump.
- **R4 — `.tachyon/HANDOFF.md` born untracked** (if `.tachyon/` is gitignored). Mitigation: D2 gitignore exception.

## Acceptance criteria
- [x] `ProjectHandoffStore` pure helpers unit-tested: note parse (skip bad lines), CAS write (accept/reject on hash), atomic append, staleness across the 4 states. (`test/unit/projectHandoff.test.ts`)
- [x] `get_project_handoff` returns canonical + pending count + staleness; `append_project_handoff_note` appends one note atomically; `set_project_handoff` rewrites only on a matching CAS hash, rejects otherwise — MCP round-trip tested. (`test/unit/bridge.test.ts`)
- [x] Agents only append; the canonical is never rewritten except via CAS (no N-agent markdown merge).
- [x] Stop/idle nudge fires at most once per workspace cooldown (`settings.handoff.nudgeEvery`, default 30m, `off`) and asks to APPEND; SessionStart pointer is a one-line additionalContext, only when a non-trivial handoff exists (rides the spec-243 `--settings` channel).
- [x] Sidebar button+badge (per-folder: top single-root / folder header multi-root) opens a read-only editor webview panel rendering the canonical (via the SANITIZED `MarkdownView`) + pending notes + staleness badge. (`test/unit/handoffViewModel.test.ts` + harness/config tests)
- [x] `handoff.path` config override works; default `.tachyon/HANDOFF.md` git-tracked (only the transient notes lane is gitignored); first write/Open seeds the 4-section template.
- [x] Full suite green (929); tsc + build + engine-boundary clean.
- [ ] **Live (user gate):** open the panel; an agent `append_project_handoff_note` shows as a pending note; a human rewrite (Open → edit, or `set_project_handoff`) advances the canonical + resets staleness; the per-folder button works multi-root. Ships in 0.32.0.

## Closure
**Closure:** Shipped in 0.32.0. First migration of an Agent0 harness mechanism into the Tachyon product (the "minimal pollution / Tachyon-as-harness" thesis). Two-lane model (codex-debated): canonical `.tachyon/HANDOFF.md` (human-curated, CAS) + `handoff-notes.jsonl` (append-only, any agent). Increments A–E: pure store, 3 Bridge tools, SessionStart pointer + per-workspace idle append-nudge (`settings.handoff.nudgeEvery`), config, and a read-only editor webview panel opened by a per-folder sidebar button (built via `/frontend-designer`, reusing the Activity panel's sanitized `MarkdownView` + `--vscode-*` tokens). Codex: design debate (two-lane) → impl review SHIP-WITH-CHANGES on the engine (atomic write + cwd guard, folded into 243-era infra) and on the panel (P1 use sanitized MarkdownView not raw renderMarkdownHtml; P2 reuse engine `pendingNotes` — both folded). 30 new tests (929 total). **Increment F (0.32.1, post-dogfood):** the append-nudge gained a per-agent activity-lag gate (`shouldRemindHandoff`, anchor advances on nudge+append) so an already-logged/idle agent isn't re-nudged for the same work — codex SHIP, +1 test (930). Deferred to v1.1: `mark_handoff_notes_distilled` + assisted distill; nudge R2 (state-targeted: nudge the owner to distill vs agents to append). **Live panel/append/multi-root + nudge behavior is the user's EDH gate.**

## Follow-up (handoff-scoped)

**Nudge R2 (open, not built) — state-targeted nudge.** Inc C+F fixed nudge fatigue (per-agent activity-lag gate).
A further option: when staleness is `needs_distill` (pending notes exist), nudge the OWNER to distill instead of
nudging agents to append more. More opinionated; revisit if dogfood shows distill-lag. (The *activity-log viewing
flow for ephemeral agents* is an Activity-subsystem question (spec 239), NOT handoff — tracked as a Tachyon pin,
not here.)

## Open questions (resolve in plan/impl)
- **OQ1** — Does the SessionStart pointer ride the existing spec-243 `--settings` hook (a second command emitting
  `additionalContext`) or a separate mechanism? (Lean: extend the injected settings — one channel.)
- **OQ2** — "Project activity since last rewrite" signal source: the spec-243 ownership/activity ledgers, or a
  dedicated handoff-revision timestamp vs `.tachyon/activity` mtime? (Lean: a stored last-rewrite hash/time + a
  cheap activity check.)
- **OQ3** — Cooldown duration + where the stop-nudge surfaces (bridge `notify` to the agent vs a host toast).
