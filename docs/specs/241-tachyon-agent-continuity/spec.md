# Spec 241 — per-agent continuity (working memory across session boundaries)

**Status:** draft · **Date:** 2026-06-21 · **Follows:** spec 216 (role re-anchor), spec 239 (activity log), spec 192 (notes/pins), spec 209 (session resume) · **Runtime:** claude v1

## Problem

When an agent's session **compacts** (claude auto-summarizes near the context limit), or the user runs **`/clear`**, or starts a **new session**, the agent loses its *working continuity* — what it was doing, the decisions it made, the next steps, the open threads. The durable activity log (spec 239) still holds the raw history and the role doc (spec 216) still holds the task contract, but neither gives the agent back its **curated working state** in a form that fits into its head on the next turn. The market converges on one shape for this (Cline/Roo "Memory Bank", Anthropic memory tool, Letta/MemGPT memory blocks): **per-agent, file-backed working memory the agent maintains and that is re-injected at a discontinuity boundary** — "memory persists what matters across the compaction boundary."

## Goal

Each agent keeps its own evolving **continuity brief** that survives compaction / `/clear` / new session / restart / reboot, and is back in the agent's head when it crosses a discontinuity. One per-agent file:

`.tachyon/continuity/<agent>.md`

```md
---
version: 1
agent: claude-1
updated_at: 2026-06-21T14:22:10Z
updated_by: agent            # agent | tachyon (v1: agent only)
source_session_id: abc123
source_activity_seq: 1842    # freshness anchor — the activity seq this brief reflects
status: active               # active | paused | blocked | done
---

# Current Goal
# Working State
# Decisions
# Next Steps
# Open Threads
# Files / Artifacts In Play
# Staleness Note
```

The agent reads + writes it (it's the agent's private working memory); Tachyon nudges it to keep it fresh and re-injects a "rebuild context" pointer **only** when continuity is actually at risk. "Checkpoint" is the verb for the save action — the agent *checkpoints* its state into the brief.

## Decisions (Claude + Codex design pass — to be ratified in `debate`)

- **D1 — a distinct per-agent artifact, not an overload of an existing one.** `.tachyon/continuity/<agent>.md` is curated, short, lossy working memory. It is NOT the role doc (216: "who am I / what contract" — static), NOT notes/pins (192: shared human↔agent project coordination), NOT the activity log (239: raw, complete, append-only history). Continuity may *reference* pins/specs but never replaces them. Fixed, short sections (above) keep it from drifting into a second notes file.
- **D2 — agent-authored is the primary path; NO LLM auto-summary in v1.** Bridge tools: `get_continuity(agent?)`, `set_continuity(content, source_activity_seq?, status?)`, `append_continuity_note(section, text)`, `continuity_status(agent?)`. Tachyon never fabricates the brief in v1. Rationale: a stale agent-authored brief is bad; a stale auto-summary that *looks official* is worse (false authority + cost + model choice + failure modes). Auto-derivation is a deferred follow, and only ever as `updated_by: tachyon`, `confidence: derived`, with an explicit source range.
- **D3 — inject ONLY at a discontinuity boundary, reusing the spec-216 re-anchor lane (`write_input`).** Triggers: compaction-detected→idle, `/clear` detected, session-id change, restart without a reliable resume, or an explicit manual action. The injected text points the agent to rebuild context:
  ```
  Continuity available — rebuild context before continuing:
    cat .tachyon/roles/<agent>.md
    cat .tachyon/continuity/<agent>.md
  ```
  **Do NOT inject on a clean same-session resume** (the model likely still has its context; double-injection creates conflicting context). The session ledger (209) decides whether a resume was "clean".
- **D4 — freshness & trust are first-class; the brief carries its own trust boundary.** Every write records `source_activity_seq`; Tachyon computes lag = current activity seq − brief seq. Past a threshold, injection says **"continuity may be stale — reconcile with recent activity"** instead of presenting it as truth. A `done`/`paused` brief is never injected as active work. **The activity log is always the source of truth for what happened; continuity is the agent's current interpretation.**
- **D5 — the "agent forgets to update it" failure mode is designed for, not assumed away.** v1 does not depend on perfect discipline: (a) boundary nudge ("update then re-read continuity"), (b) soft reminder on idle after significant activity since the last continuity write, (c) a visible **fresh / stale / missing** status (badge), (d) a manual "Re-inject continuity" / `restore_continuity` action. Forgetting is made visible and cheap to repair, never silently hidden behind fake confidence.
- **D6 — thin layer over existing primitives + one new owned artifact.** Reuse: the re-anchor trigger/injection (216), activity for provenance + freshness (239), the session ledger to decide if injection is needed (209), notes/pins by reference only (192). Add only: the durable curated brief + the Bridge CRUD surface + the freshness/injection logic. Storage in `.tachyon/continuity/` (project chooses whether to git-track).

## Non-goals (v1)
- LLM auto-summarization of the activity log into a brief (deferred; `confidence: derived` only).
- A search/recall memory tier or archival store (Letta-style tiers).
- Cross-agent / shared continuity (this is strictly per-agent private working memory).
- Semantic dedupe, automatic "truth correction", or rewriting the brief on the agent's behalf.
- Runtime-specific compaction detection beyond what 216 already does — codex/other runtimes use the generic session-boundary + clear hooks until they have their own compaction signal.
- UI beyond a small status indicator (fresh/stale/missing) + the manual re-inject action.

## Risks
- **R1 — stale continuity causes wrong work.** Mitigation: D4 (freshness metadata, lag warning, `done`/`paused` statuses, activity-seq provenance) + D3 (no injection on clean resume).
- **R2 — the agent never maintains it.** Mitigation: D5 (boundary nudge, idle reminder, visible stale state, manual restore). v1 tolerates imperfect discipline.
- **R3 — it becomes a second notes system.** Mitigation: D1 (strict per-agent file, fixed short sections; shared facts stay in notes/pins/specs).
- **R4 — double-context / conflicting injection.** Mitigation: D3 (inject only at genuine discontinuity; ledger gates clean-resume).

## Acceptance criteria
- [ ] `.tachyon/continuity/<agent>.md` is created/updated via the Bridge CRUD tools and persists across compaction / `/clear` / new session / restart / reboot.
- [ ] On a discontinuity boundary (compaction→idle, `/clear`, session-id change, restart-without-resume, manual), Tachyon injects the "rebuild context" pointer; it does NOT inject on a clean same-session resume.
- [ ] When lag exceeds the threshold, the injected text carries a "may be stale" warning; a `done`/`paused` brief is not injected as active work.
- [ ] A fresh / stale / missing status is visible (badge), and a manual "Re-inject continuity" action exists.
- [ ] No regression to spec 216 re-anchor, 239 activity log, or 209 resume.

## Open questions (for `debate`)
- **OQ1** — exact trigger set + per-runtime: does claude expose a *pre*-compaction warning (so the agent can checkpoint while context is still rich), or only the post-boundary signal? codex has no compaction detection — confirm the generic boundary hooks suffice.
- **OQ2** — the lag threshold default + how the "current activity seq" is read cheaply at injection time (reuse ActivityLogManager's offset/seq?).
- **OQ3** — cold start: there is no brief on the first session. What does Tachyon inject/nudge then (just the role + "start a continuity brief"?).
- **OQ4** — UI placement of the fresh/stale/missing badge (Activity header vs sidebar agent row) and whether to surface the brief read-only in the Activity panel.
- **OQ5** — git-tracking default for `.tachyon/continuity/` (gitignore like harness homes, or trackable like notes/pins?).
- **OQ6** — should a Tachyon-initiated Stop/Restart first nudge the agent to checkpoint (mirror `refreshOwnership`'s "capture before teardown")?
