# 363 — agent-onboarding

_Created 2026-07-07._

**Status:** draft

_Debated with the maintainer 2026-07-07 (t-0cfbd6 unfrozen by that debate). The load-bearing architectural
decision was made there; the MAINTAINER DECISIONS section below holds only the remaining calls._

## Intent

Every spawned or restarted agent pays a cold-start tax: it must learn what Tachyon is, discover the Bridge
tools, infer the etiquette (notify on done, never poll, continuity), and absorb the repo's discipline
(canonical verify commands, pathspec commits, `npm ci` in a fresh worktree). Today ALL of that arrives through
one channel: whatever the spawner hand-writes into the delegation contract — repeated per spawn, forgotten
sometimes, ignored often. The coordinator pays the mirror cost: giant contracts restating the same catechism.

Evidence from a single day (2026-07-07):
- 3 of 3 gated deliveries violated the contract's EXACT behavior-test name — the third with the contract
  explicitly warning about the previous two blocks. Prose does not survive contact with a codex.
- 1 of 3 finished without ringing the completion doorbell (`notify_agent`) at all — the work sat idle,
  discovered only because the maintainer looked.
- The notify 500-char truncation ate review verdicts 4× before the "file = deliverable, notify = doorbell"
  pattern was instituted — by hand, agent by agent.
- A fresh gated worktree has no `node_modules`/`dist` — every contract must remember to say `npm ci`.

**The principle (maintainer, from the debate): the container owns onboarding through ITS OWN channels.** No
dependency on per-runtime context-file conventions (`AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`CONVENTIONS.md`…):
those make Tachyon hostage to each runtime's file name, read timing, and size limits — a runtime×convention
maintenance matrix we don't control, broken by any runtime update. Tachyon already talks to every runtime
uniformly through two channels it owns; onboarding uses exactly those two:

- **PUSH — the pane/brief compositor** (spec 246 contract delivery, instructions re-delivery, re-anchor):
  a generated PRIMER section prepended at container-controlled moments.
- **PULL — the Bridge** (MCP): an `orient` tool for self-serve re-orientation mid-session.

Context files on disk are demoted to human-facing documentation, OUT of the agent-onboarding mechanism.

## Design

### 1. The generated primer (push)

A short, fixed-format, delimited section the brief compositor prepends at the four EXISTING injection moments
— spawn, restart, resume, re-anchor (no new channels, no event detection in v1). Content is hybrid: a curated
skeleton with generated slots, so it is never stale and never generic:

- **Identity:** agent name, delegator/parent, gated? (behavior test + owns, with the PROTOCOL-IDENTIFIER
  warning), worktree path + bootstrap facts (fresh worktree ⇒ `npm ci`; no dist/).
- **Protocol:** done ⇒ `notify_agent(to:<spawner>)` — the doorbell is mandatory; NEVER poll; long findings ⇒
  file + one-line notify; durable state ⇒ `set_continuity`.
- **Repo discipline (generated from config):** `settings.verify` commands, commit-by-pathspec, add/commit
  separate, l10n rule.
- **Pointer:** "self-serve re-orientation: call `orient`".

Dose per moment: spawn = full; restart/resume = identity + delta; re-anchor = refresh. HARD budget ~30 lines
(the deep/static knowledge lives behind `orient` — push-minimal, pull-complete). Runtime-aware flavoring
(claude vs codex) only in phrasing, never in content.

**Format is a design requirement, not styling:** fixed delimiters and ordering so agents learn to RECOGNIZE
the section; never long prose (prose is exactly what gets ignored — see the 3/3 evidence). Honest expectation:
the primer lowers the F1/F2/F3 rate; the 362 gate remains the enforcement. Success metric: blocker rate on
gated landings before/after (the gate's records already count this for free).

### 2. The `orient` Bridge tool (pull)

One call returns the full orientation for the CALLER: identity (name, delegator, gate status), the complete
protocol, `settings.verify` commands, tasks assigned to the caller, continuity pointer. v1 does NOT include
fleet state (`list_agents` already owns that — no second source of truth). Target consumer: the agent that
wakes up confused mid-session (post-compaction, hours in).

### 3. Explicitly out / documented limits

- No context files as mechanism (human-facing docs may exist; any file mirror of primer content is a derived
  artifact, never the primary channel).
- No event-driven injection in v1 (compaction detection etc. is per-runtime — the same maintenance trap the
  file conventions are; revisit after v1 data).
- **Known limit — stale tool schemas:** a long-lived session's MCP tool list is a startup snapshot; neither
  the primer nor `orient` can make a NEW Bridge tool callable by an OLD session (harness limitation). The
  direct-MCP-client workaround is documented operator knowledge, not product mechanism.
- Companion (registered here, solved elsewhere): structured/attachment payload for `notify_agent` (the
  500-char cap) — natural Phase 2, possibly its own task.
- The 3/3 behavior-test-name evidence also feeds a 362 backlog item (container-generated test STUB with the
  exact name on the task branch — the agent fills the body, the name cannot drift). Out of 363's scope.

## Phasing

- **Phase 1** — the primer: brief-compositor extension + the four moments + generated slots from config +
  tests (fixed format snapshot per moment/agent-kind; gated vs plain; fresh-worktree facts). Dogfood on the
  next wave of delegations, measure gate-blocker rate.
- **Phase 2** — `orient` (pull) + notify payload companion if ratified.

## MAINTAINER DECISIONS NEEDED

1. **Primer in v1 scope only, or primer + `orient` together?** (Recommendation: primer first — it hits every
   spawn automatically; `orient` needs the agent to know to call it, and the primer's pointer is how they
   learn — natural sequencing.)
2. **Budget confirmation:** hard ~30 lines push / rest behind pull. (Recommendation: yes; revisit only with
   before/after data.)
3. **Does the primer also go to DECLARED agents' spawns** (they already carry curated `instructions:`) or only
   ad-hoc? (Recommendation: everyone — identity/bootstrap facts are per-spawn and can't live in static
   instructions; the primer is short enough to coexist.)
