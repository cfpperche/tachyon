# Spec 241 — per-agent continuity (working memory across session boundaries)

**Status:** debated · **Date:** 2026-06-21 · **Follows:** spec 216 (role re-anchor), spec 239 (activity log), spec 192 (notes/pins), spec 209 (session resume), spec 225 (fork) · **Runtime:** claude v1 · **Debate:** see `debate.md` (D3 corrected; D7–D10 added)

## Problem

When an agent's session **compacts** (claude auto-summarizes near the context limit), or the user runs **`/clear`**, or starts a **new session**, the agent loses its *working continuity* — what it was doing, the decisions it made, the next steps, the open threads. The durable activity log (spec 239) still holds the raw history and the role doc (spec 216) still holds the task contract, but neither gives the agent back its **curated working state** in a form that fits into its head on the next turn. The market converges on one shape (Cline/Roo "Memory Bank", Anthropic memory tool, Letta/MemGPT memory blocks): **per-agent, file-backed working memory the agent maintains and that is re-injected at a discontinuity boundary** — "memory persists what matters across the compaction boundary."

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
source_activity_seq: 1842    # freshness anchor — defaults to the current activity seq on write
status: active               # active | paused | blocked | done
---

# Current Goal          # the current EXECUTION objective (not the task contract — that's the role doc)
# Working State
# Decisions
# Next Steps
# Open Threads
# Files / Artifacts In Play
# Staleness Note
```

The agent reads + writes it (its private working memory); Tachyon nudges it to keep it fresh and re-injects a "rebuild context" pointer **only** when continuity is actually at risk. "Checkpoint" is the verb for the save action — the agent *checkpoints* its state into the brief.

## Decisions (ratified in `debate.md`)

- **D1 — a distinct per-agent artifact with section discipline.** `.tachyon/continuity/<agent>.md` is curated, short, lossy working memory. NOT the role doc (216: static "who am I / what contract"), NOT notes/pins (192: shared project coordination), NOT the activity log (239: raw complete history). **"Current Goal" is the current execution objective, not the task contract** (no role-doc overlap). Sections are references-only to notes/pins/specs (no shared project facts duplicated); empty sections are allowed; the hard size cap is **D7**.
- **D2 — agent-authored, minimal Bridge surface, NO LLM auto-summary in v1.** Tools: `get_continuity(agent?)`, `set_continuity(content, source_activity_seq?, status?)`, `continuity_status(agent?)`. **`append_continuity_note` is cut** (it encourages stale accretion / structural drift). `source_activity_seq` defaults to the current seq on write. Tachyon never fabricates the brief in v1 — a stale auto-summary that *looks official* is worse than an honest agent-authored one (auto-derivation is a deferred follow, only ever `updated_by: tachyon`, `confidence: derived`).
- **D3 — inject when continuity is AT RISK, not merely "not a clean resume" (CRITICAL, corrected in debate).** "Same-session resume" ≠ "uncompacted context": a resumed Claude session may already be **post-compaction** (the model holds the lossy summary). So inject the rebuild-context pointer **unless there has been no compaction / `/clear` / discontinuity since the last continuity injection or checkpoint** (tracked by **D9**). Triggers: compaction-detected→idle, `/clear`, session-id change, restart-without-reliable-resume, manual. Injection (reusing the spec-216 `write_input` lane):
  ```
  Continuity available — rebuild context before continuing:
    cat .tachyon/roles/<agent>.md
    cat .tachyon/continuity/<agent>.md
  ```
- **D4 — freshness is a heuristic shown exactly, not a trust signal.** Every write records `source_activity_seq`; lag = current seq − brief seq. Injection states the **exact** lag ("brief is 137 activity records behind"); the threshold only picks wording/cooldown. Never imply "fresh = semantically correct". A `done`/`paused` brief is not injected as active work. **The activity log is always the source of truth for what happened; continuity is the agent's current interpretation.**
- **D5 — the quiet channel is primary; pane nudges are rate-limited.** Primary surfacing is the sidebar badge / Activity UI (quiet). Only the boundary-restoration pointer goes into the pane, at most **one nudge per stale epoch** with a cooldown — idle reminders must not pollute the conversation.
- **D6 — thin artifact, real boundary subsystem.** The brief file is thin, but the **discontinuity classifier is a real subsystem** (state machine + test matrix) — treated with the rigor the spec-240 configHome drift bugs earned. The state model is **D9**.
- **D7 — write contract & size.** YAML frontmatter required; soft cap ≈8 KB / 200 lines (warn, don't truncate — artifact-budget philosophy); atomic writes; reject malformed frontmatter; preserve unknown future fields.
- **D8 — fork (spec 225) behavior.** A fork gets a **snapshot copy** under the child name (separate file) with `forked_from_agent` / `forked_from_session_id` + a staleness note, started **`status: paused`** ("inherited from parent — re-scope to your own task before treating as active"): an off-task fork must not present the parent's goal as its own.
- **D9 — discontinuity state model.** Persist discontinuity state SEPARATELY from sessionId — a `compacted_since_last_restore` flag + `last_discontinuity_seq` — so a same-session post-compaction resume is correctly classified as "needs restore". This is the state machine D3/D6 depend on; it carries the test matrix.
- **D10 — privacy / tracking policy.** `.tachyon/continuity/` is **gitignored by default** (per-agent private working state: transient paths, partial plans, possibly sensitive context). Docs instruct agents to promote durable shared facts to notes/pins/specs.

## Non-goals (v1)
- LLM auto-summarization of the activity log into a brief (deferred; `confidence: derived` only).
- A token-pressure / pre-compaction trigger (no runtime exposes the signal today — see OQ1 resolution; proactive idle checkpointing is the substitute).
- A search/recall memory tier or archival store (Letta-style tiers).
- Cross-agent / shared continuity (strictly per-agent private working memory).
- Semantic dedupe, automatic "truth correction", or rewriting the brief on the agent's behalf.
- Runtime-specific compaction detection beyond spec 216 — codex/other runtimes use the generic session-boundary + clear hooks until they have their own compaction signal.
- A continuity EDITING UI (the Activity panel may show it read-only; no in-app editor).

## Resolved open questions (full reasoning in `debate.md`)
- **OQ1 (checkpoint while context is rich):** no pre-compaction signal exists → proactive **idle checkpoint nudge** when an active brief's lag ≥ `reminderLag` and the agent is idle, once per cooldown (≈15 min).
- **OQ2 (lag read + thresholds):** read current seq from ActivityLogManager's persisted `.state.json` (fallback: tail the activity file). Defaults `reminderLag=25`, `staleLag=100` (configurable).
- **OQ3 (cold start):** badge = **missing**; nudge to read the role and create the first checkpoint once the goal/state are clear (don't pretend continuity exists).
- **OQ4 (UI):** fresh/stale/missing badge on the **sidebar agent row**; Activity panel shows a **read-only** collapsible brief + metadata + exact lag + "Re-inject continuity".
- **OQ5 (git):** gitignore `.tachyon/continuity/` by default → folded into **D10**.
- **OQ6 (pre-teardown):** reuse the `refreshOwnership` pre-teardown hook, **bounded** — if idle, nudge + wait ≤10–15 s for the seq to advance; if busy/unresponsive, proceed and mark the next restore "possibly stale". **Never block Stop/Restart.**

## Risks
- **R1 — stale continuity → wrong work.** Mitigation: D4 (exact lag, stale wording, `done`/`paused`), D3/D9 (inject on real discontinuity incl. post-compaction same-session).
- **R2 — the agent never maintains it.** Mitigation: D5 + OQ1 (boundary + idle nudges), visible stale/missing badge, manual restore. v1 tolerates imperfect discipline.
- **R3 — it becomes a second notes system.** Mitigation: D1 (per-agent, fixed short sections, references-only) + D10 (private, promote shared facts out).
- **R4 — double-context / conflicting injection.** Mitigation: D3/D9 (classify discontinuity precisely; don't inject when context is genuinely intact).
- **R5 — boundary-classifier bugs (the spec-240 drift class).** Mitigation: D9 owns an explicit state machine + test matrix.

## Acceptance criteria
- [ ] `.tachyon/continuity/<agent>.md` is created/updated via `get`/`set`/`status` Bridge tools and persists across compaction / `/clear` / new session / restart / reboot.
- [ ] A same-session resume **after a compaction since the last restore** triggers injection; a resume with **no discontinuity since the last restore** does NOT (D3/D9).
- [ ] Injection states the exact lag and adds a "may be stale" note past `staleLag`; a `done`/`paused` brief is not injected as active work.
- [ ] Idle checkpoint nudge fires at most once per cooldown when lag ≥ `reminderLag` and the agent is idle (no pane spam).
- [ ] Cold start shows a **missing** badge and nudges creation; fresh/stale/missing badge on the sidebar agent row; manual "Re-inject continuity" action exists.
- [ ] A fork starts from a `status: paused` snapshot of the parent brief in its own file (D8).
- [ ] `.tachyon/continuity/` is gitignored by default (D10).
- [ ] No regression to spec 216 re-anchor, 239 activity log, or 209 resume.

## v1 scope (smallest honest version)
**In:** the brief file + write contract (D7), `get`/`set`/`status` Bridge tools (D2), the discontinuity state model + injection (D3/D9), exact-lag + stale wording (D4), idle/boundary nudges with cooldown (D5/OQ1), cold-start missing state (OQ3), sidebar badge + manual re-inject (OQ4), bounded pre-teardown checkpoint (OQ6), fork snapshot (D8), gitignore (D10).
**May cut if tight:** the read-only Activity-panel brief view (keep the badge + re-inject).
**Out:** everything in Non-goals.
