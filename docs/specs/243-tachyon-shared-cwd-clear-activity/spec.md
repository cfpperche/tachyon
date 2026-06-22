# Spec 243 — activity logging survives `/clear` (and in-TUI `/resume`) on a shared cwd

**Status:** shipped (0.31.1) · **Date:** 2026-06-21 · **Follows:** spec 239 (agent activity log), 240 (transcript isolation), 220 (claude session mint by title), 226 (isolated harness home) · **Surface:** `src/agents/AgentManager.ts` (`transcriptPathOf` + spawn wiring), `src/resume/resolvers.ts`, a new session-ownership recorder + ledger · **Review:** see `debate.md` (codex plan debate — Option B chosen, probe green) · **EDH:** pending (live dogfood — give `/clear` and watch Activity resume)

> **Approach decided (codex debate, 2026-06-21):** **Option B — ownership marker via a per-spawn `--settings` SessionStart hook.** Option A (elimination) is **disqualified** (misattributes in the sibling-cleared length-1 case — no per-agent disk signal exists). Option C (isolated home) is the guaranteed fallback when hooks are unavailable. Option D (open-fd) is too brittle (FD-lifetime is an unproven claude implementation detail). **Live probe GREEN:** `claude --settings <json>` (claude 2.1.185) honors an injected `SessionStart` hook that fires (incl. `source:"clear"`, disk-proven) and receives `{session_id, transcript_path, cwd, source}` — without mutating `~/.claude` or the repo's `.claude/`.

## Problem

When a claude agent that shares its cwd with other claude agents issues `/clear` (or an in-TUI `/resume` to a
different session), **its Activity feed stops registering anything** — the agent keeps working and the new
conversation is durably on disk, but the durable per-agent activity log (spec 239) silently stops appending.
Nothing is lost (the transcript exists), but live observability dies until the agent is restarted.

**Reproduced live (2026-06-21):** the `claude-tachyon` agent runs in `/home/goat/Agent0`, a cwd shared with
`claude-ag`, `claude-ag0`, `claude-papo`, … After `/clear`, Activity froze at the pre-`/clear` message; the
entire post-`/clear` session went unlogged while the agent was visibly `working`.

### Root cause (disk-verified)

`ActivityLogManager` re-resolves the agent's current transcript via `AgentManager.transcriptPathOf(name, {live:true})`
on a slow cadence, then the `ActivityLogWriter` tails whatever path it returns. The writer itself handles rotation
correctly (it emits a `session.boundary` on uuid change and follows the new path) — **the defect is upstream, in
`transcriptPathOf`’s resolution on a shared cwd.** `src/agents/AgentManager.ts:858-872`:

```
id = record.resume.sessionId            // the CAPTURED uuid of the pre-/clear session
if (id && !isUuid(id))            → false  // already a uuid
else if (opts.live && !shared)    → false  // shared === true, so the "follow newest session" escape is GATED OFF
// → id stays the OLD captured uuid → returns the OLD transcript path (exists, but frozen)
```

The `else if (opts.live && !shared)` branch is exactly the escape that follows a session rotation to the newest
transcript — but it is disabled on a shared cwd because a bare newest-by-cwd scan could grab **another** agent's
session. The title-based disambiguator (`resolveClaudeIdByTitle`, spec 220) only runs when the id is **not yet a
uuid** (pre-capture), so once the uuid is captured the resolver is **permanently pinned** to the pre-`/clear` file.

### Why the title escape also fails for the new session (the hard part)

The shared-cwd-safe disambiguation (spec 220) assumes the Tachyon-minted `-n <title>` (`tachyon-<ws>-<name>`,
e.g. `tachyon-Agent0-claude-tachyon`) persists as the jsonl `customTitle` for the session's life. **`/clear`
breaks that invariant.** Disk evidence from the live repro (post-`/clear` session `db3f3453…jsonl`):

- `customTitle: "tachyon"` — **claude AUTO-GENERATED it from the conversation topic**, NOT the minted
  `tachyon-Agent0-claude-tachyon`.
- **No `agent-name` record** in the header.
- A `{"hookName":"SessionStart:clear"}` record IS present (the SessionStart hook fired with source `clear`).

So the post-`/clear` session carries **no disk-derivable Tachyon attribution marker**. On a shared cwd, the new
transcript cannot be attributed to the right agent by `customTitle` alone. (The same auto-retitle likely also
happens on long-running sessions, where claude rewrites `customTitle` to a summary.)

## Goal

Activity logging **follows a session rotation** (`/clear`, in-TUI `/resume`, fresh start within the cwd) on a
**shared cwd**, attributing the new transcript to the correct agent **without ever grabbing another agent's
session** — preserving the spec-240 ambiguity safety (never guess wrong on a shared cwd; a genuinely ambiguous
case stays a GAP, never a misattribution).

## Approach options (resolve in `debate.md`)

- **Option A — attribution by elimination (recommended v1).** On `live` + shared, follow the **newest** transcript
  in the cwd that is **NOT the captured uuid of any OTHER agent in the ledger**. The resolving agent owns the
  newest unclaimed session. Pure `resolvers` + `AgentManager` change; no hook injection, no new claude coupling
  (keeps Tachyon runtime-neutral). Failure mode: two agents on the same cwd both rotate within one resolve window
  → elimination can't tell the two new sessions apart → fall back to GAP (no misattribution; self-heals once one
  is captured). Acceptable boundary, same spirit as the spec-240 "ambiguous → gap" rule.
- **Option B — ownership marker via a SessionStart hook (robustness reinforcement).** Tachyon writes `uuid → agent`
  to an ownership map from a `SessionStart` hook (which already fires on `/clear`, per the disk evidence). Race-free
  and exact across `/clear` + `/resume`, but couples the activity path to a claude-specific hook (must live in the
  claude adapter, gated by runtime). Candidate as a follow-up or a belt-and-suspenders layer over A.
- **Option C — isolated config home (workaround available NOW, no code).** Run shared-cwd agents with their own
  `CLAUDE_CONFIG_DIR` (spec 226/240) → distinct transcript namespace → `shared === false` → the existing
  `opts.live && !shared` escape follows `/clear` unaided. Document as the immediate mitigation; not the fix.

## Decisions (provisional — to confirm in debate)

- **D1 — fix lives in `transcriptPathOf` + a new shared-cwd-safe resolver, NOT in the writer.** The writer's
  rotation handling (spec 239) is correct and unit-tested; do not touch it. Feed it the right `cur`.
- **D2 — the new resolver is PURE + unit-tested in node** (the "logic in the vscode layer escapes CI" lesson,
  spec 240): given (cwd, configHome, set-of-other-agents'-owned-uuids), return the newest transcript uuid not
  owned by another agent, or null. No vscode imports.
- **D3 — never misattribute on a shared cwd.** Ambiguity (≥2 candidate new sessions, or the newest is another
  agent's owned uuid) resolves to GAP (undefined), exactly as today — correctness over coverage.
- **D4 — the ledger is the source of "other agents' owned uuids."** Only uuids already captured by OTHER agents
  sharing this cwd+configHome are exclusions; the resolving agent's own (now-stale) uuid is NOT an exclusion (it
  must be allowed to move off it).
- **D5 — emit the `session.boundary` correctly.** Once `cur` advances to the new uuid, the existing writer path
  emits the boundary; verify the inferred reason is sane (`/clear` with no Tachyon-labeled lifecycle → `new`).
- **D6 — staleness is not required but is a safety check.** Consider only treating the captured uuid as "left"
  when a newer candidate transcript exists; do not abandon a still-growing captured session.

## Non-goals
- Changing claude's `/clear` behavior or its auto-`customTitle` (not ours to change).
- Re-architecting the activity log or the writer (spec 239 stands).
- Non-claude runtimes (codex/opencode already resolve newest-by-cwd via capture resolvers; gemini/qwen unaffected).
- Backfilling the activity already missed during a gap (the deep history stays in the runtime transcript, reachable
  via "Open transcript"; lineage resumes from the rotation forward — consistent with spec 239's "lineage starts now").

## Risks
- **R1 — elimination grabs the wrong session when two same-cwd agents rotate together.** Mitigation: D3 — ≥2
  candidates ⇒ GAP, never a guess; self-heals on capture. Add a regression test for the two-agents-rotate case.
- **R2 — the captured-uuid file lingers and looks "current."** Mitigation: D6 — only move when a strictly-newer
  candidate exists; the writer keeps tailing the captured session until then.
- **R3 — perf: the elimination scan runs on the slow resolve cadence (spec-221 lesson).** Mitigation: it reuses
  the existing newest-by-cwd dir scan that already runs there; the exclusion set is a cheap ledger read. No new
  per-tick cost.

## Acceptance criteria
> Approach pivoted from elimination (A) to ownership-hook (B) in debate — criteria updated accordingly.
- [x] After `/clear` on a **shared cwd**, the resolver follows the agent's NEW session via the ownership ledger (`transcriptPathOf` consults `ownedSession` first, live-only, authoritative when the transcript exists) — unit-tested.
- [x] **Never misattributes:** `latestOwnerFor` is per-agent + requires a canonical cwd match, so it can only ever return THIS agent's row (an agent with no row → gap; a sibling's row is never returned) — unit-tested.
- [x] Ownership is authoritative only when its transcript exists; else falls through to the existing title/captured-uuid logic (no regression to spec-238/240 paths) — unit-tested.
- [x] Per-spawn `--settings` ownership hook injected for claude only, at spawn/restart/resume; skips self-managed (`--resume`) + a user `--settings` (with advisory); additive (no `~/.claude`/repo `.claude/` mutation) — unit-tested.
- [x] Recorder + settings are materialized atomically (temp + rename) so concurrent spawns can't truncate a recorder mid-read (codex HIGH fold) — integration-tested.
- [x] Pure module (`sessionOwners`) unit-tested: parse (skip bad lines), latest-per-agent, cwd guard, settings shape, recorder is valid JS.
- [x] Full suite green (903, +17), tsc (both configs) + build + engine-boundary clean.
- [x] **Live dogfood (user gate) — VALIDATED 2026-06-21 (0.31.1):** in `/home/goat/Agent0` (shared cwd), the `claude-tachyon` agent's Activity feed resumed registering its post-`/clear` session (`db3f3453`) after a stop→resume, following the ownership ledger (two `source:"resume"` rows recorded; resolver returns the live session). Confirmed on screen.

## Closure
**Closure:** Shipped in 0.31.1. Approach = Option B (per-spawn `--settings` SessionStart ownership hook → `.tachyon/activity/session-owners.jsonl`; resolver follows the positive per-agent signal). Codex: plan debate (A disqualified, B chosen, probe green) → impl review SHIP-WITH-CHANGES (HIGH atomic-write race + MEDIUM empty-cwd guard folded; LOW `--settings` regex left consistent with the established `withRuntimeBridge` idiom). New code: `src/activity/sessionOwners.ts` + `HarnessManager.materializeOwnershipSettings` (atomic) + `AgentManager.withSessionOwnership` + ownership lookup in `transcriptPathOf` + Workspace wiring. 17 new tests. **Live `/clear` dogfood is the user's gate** (pure runtime behavior; the per-agent durable log + atomic write are CI-covered) — **VALIDATED 2026-06-21 on 0.31.1** (Activity resumed registering `db3f3453` after stop→resume on the shared Agent0 cwd). Deferred: ledger compaction (not needed until activity-resolve is hot); isolated-home (Option C) remains the documented stronger guarantee when hooks are unavailable.

**Follow-up surfaced during dogfood (separate concern, NOT this spec):** the ownership ledger fixes Activity *attribution* (which session a feed FOLLOWS), but the *resume target* (which session claude REOPENS on stop→resume) still comes from the ledger's `resume.sessionId`, which a shared-cwd `/clear` never updates (it stayed `ee308fa6`, the pre-`/clear` uuid). So resume reopened the old session. The ownership ledger is the reliable per-agent current-session signal that could ALSO drive `refreshOwnership`/resume — a short follow-up spec.

## Open questions (for `debate.md`)
- **OQ1** — Ship A alone for v1, or A + B (hook ownership marker) together? (Lean: A now; B as a follow-up only if A's two-agents-rotate gap bites in practice.)
- **OQ2** — Should the resolver also exclude uuids owned by the agent's OWN ledger when stale, or trust newest-unclaimed? (Lean: own stale uuid is allowed, per D4.)
- **OQ3** — Is "strictly newer than the captured uuid's mtime" (D6) the right staleness guard, or is "newest-unclaimed" sufficient on its own?
- **OQ4** — Do we surface a one-time hint that shared-cwd agents can use isolated homes (Option C) as a stronger guarantee, or keep that purely in docs?
