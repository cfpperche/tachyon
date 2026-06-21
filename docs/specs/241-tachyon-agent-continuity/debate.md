# Debate 241 — per-agent continuity

**Phase:** debate · **Date:** 2026-06-21 · **Participants:** Claude (author) + Codex (adversary) · **Verdict:** SPEC-READY-WITH-CHANGES → changes folded into `spec.md`

Codex reviewed `spec.md` adversarially. Critical finding: **D3 was wrong** for the central case (same-session post-compaction resume). All changes below are folded into `spec.md` (D1–D6 revised, D7–D10 added, OQs resolved, v1 trimmed).

## Decision attacks → resolutions

- **D1 — CHANGE (kept artifact).** "Current Goal" overlaps the role doc; "Working State" can swallow everything. → Scope "Current Goal" to *execution objective, not task contract*; add section discipline (references-only to notes/pins/specs, empty sections allowed); hard size cap moves to **D7**. *Claude: agreed — this is the anti-over-prescription tightening.*
- **D2 — CHANGE.** Bridge surface too big; `append_continuity_note` encourages accretion/structural drift. → v1 tools = `get_continuity` / `set_continuity` / `continuity_status` (cut `append`). `source_activity_seq` defaults to current seq on write (not loosely optional). *Claude: agreed.*
- **D3 — CHANGE (CRITICAL).** "Clean same-session resume" ≠ "uncompacted context": a resumed same Claude session may already be post-compaction (the model holds the lossy summary, thinks it has context). "Never inject on clean resume" then fails exactly when continuity is most needed. → Inject unless there has been **no compaction/clear/discontinuity since the last continuity injection/checkpoint**. Requires persisting discontinuity state (`compacted_since_last_restore` / `last_discontinuity_seq`) — see **D9**. *Claude: agreed — this is the central correctness fix; it gates planning.*
- **D4 — CHANGE.** Activity-seq lag is a cheap heuristic, NOT a trust signal (200 trivial records vs a 2-record strategy change). → Show the **exact** lag ("brief is 137 activity records behind"); use the threshold only to pick wording/cooldown; never imply "fresh = semantically correct". *Claude: agreed.*
- **D5 — CHANGE.** Pane nudges pollute the conversation; idle reminders are intrusive. → Primary channel is the **quiet** one (sidebar badge / toast / Activity UI); at most **one pane nudge per stale epoch** with a cooldown, and only the boundary-restoration nudge goes to the pane. *Claude: agreed — pane pollution is a real cost.*
- **D6 — CHANGE (wording).** Not "thin": the artifact is thin but the **boundary classifier is a real subsystem** with its own state machine + test matrix (cf. the spec-240 configHome drift class of bugs). → Spec owns the discontinuity state model (**D9**) and a test matrix. *Claude: agreed — honest about complexity.*

## Open questions → resolutions

- **OQ1 (pre-compaction checkpoint):** accept there is **no** pre-compaction signal. → Proactive **idle checkpoint nudge**: when an active brief's lag reaches `reminderLag` and the agent is idle, nudge once per cooldown (≈15 min). No token-threshold feature until a runtime exposes token pressure.
- **OQ2 (lag read + thresholds):** read current seq from ActivityLogManager's persisted `.state.json` (fallback: tail the activity file). Defaults `reminderLag=25`, `staleLag=100` (configurable); injection states the exact lag.
- **OQ3 (cold start):** don't pretend continuity exists. Badge = **missing**; nudge "No continuity brief yet — read your role, then create a checkpoint once the goal/current state are clear."
- **OQ4 (UI):** fresh/stale/missing **badge on the sidebar agent row** (continuity is per-agent); Activity panel shows a **read-only** collapsible brief + metadata + exact lag + "Re-inject continuity". No editing UI in v1.
- **OQ5 (git):** **gitignore `.tachyon/continuity/`** by default — per-agent private working state (transient paths, partial plans, possibly sensitive). Durable shared facts belong in notes/pins/specs. → **D10**.
- **OQ6 (pre-teardown checkpoint):** **yes**, reuse the existing `refreshOwnership` pre-teardown hook, **bounded**: if idle, nudge checkpoint and wait ≤10–15 s for `source_activity_seq` to advance; if busy/unresponsive, proceed and mark the next restore "possibly stale". **Never block Stop/Restart.**

## New decisions added

- **D7 — write contract / size.** YAML frontmatter required; max ≈8 KB / 200 lines (soft cap, warn not truncate per the artifact-budget philosophy); atomic writes; reject malformed frontmatter; preserve unknown future fields.
- **D8 — fork (spec 225) behavior.** A fork gets a **snapshot copy** under the child name (separate file) with `forked_from_agent` / `forked_from_session_id` + a staleness note, **and `status: paused`** ("inherited from parent — re-scope to your own task before treating as active"). *Claude refinement over codex: a fork is often an off-task tangent, so inheriting the parent's goal as `active` would mislead — start `paused`.*
- **D9 — discontinuity state model.** Persist discontinuity state SEPARATELY from sessionId (a `compacted_since_last_restore` bit + `last_discontinuity_seq`), so a same-session post-compaction resume is classified as "needs restore". This is the state machine D3/D6 depend on; it gets the test matrix.
- **D10 — privacy / tracking policy.** Gitignored by default (D10 ⊇ OQ5); docs instruct agents to promote durable shared facts to notes/pins/specs.

## v1 cut (smallest honest v1)
- **Cut** `append_continuity_note` (D2).
- **Keep** CRUD/status, discontinuity injection (D3/D9), exact-lag + stale wording (D4), cold-start "missing" (OQ3), sidebar badge + manual re-inject (OQ4), bounded pre-teardown checkpoint (OQ6).
- **May cut if tight:** the read-only Activity-panel brief view (keep badge + re-inject).

## Claude dissents / refinements
- **D8 fork:** start the inherited brief `status: paused`, not `active` (above) — codex proposed a plain snapshot; an off-task fork shouldn't present the parent's goal as its own.
- **Multi-root:** no new decision needed — `.tachyon/` is already per-workspace-folder, so per-agent-per-folder continuity falls out for free. Noted, not a D.
- **Brief template/nudge wording:** the seeded template + the exact nudge copy are **plan/implementation** detail, not spec decisions — deferred to `plan`.

## Status
D3 corrected (was the blocking change) → spec moves to **debated**; ready for `plan`.
