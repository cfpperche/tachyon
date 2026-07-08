# 363 — agent-onboarding

_Created 2026-07-07._

**Status:** shipped — Phase 1 live and dogfooded (0.55.58–0.55.64); Phase 2 backlog in notes.md

_Ratified 2026-07-07 — all 3 maintainer decisions resolved (see the ratified section at the end)._

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

_Reforged by the adversarial dueto (probe-023dd556, 2 blockers + 5 majors) and same-day statistics: by end of
day the count was **4/4 gated deliveries violating the exact test-name clause and 2/4 skipping the completion
doorbell** — with escalating warnings in every contract. The dueto's verdict, now empirical: "recognition is
not obedience; enforcement must live outside the model." 363's center of gravity moves accordingly: the primer
is ORIENTATION (advisory), and a machine-checkable **protocol gate** is the control._

### 0. The protocol gate (enforcement — the core; dueto blockers #1/#5)

Protocol compliance is asserted by the container, never hoped for. The Bridge WITNESSES protocol events (it
served the calls), so the gate checks observables:

- **doorbell** — did the agent call `notify_agent(to:<spawner>)` before being collected? The Bridge saw it or
  it didn't happen. Surfaced as a `protocol_doorbell_missed` finding on collection/verify.
- **canonical behavior-test name** — the exact-name clause moves from prose to STRUCTURE: the container
  generates the canonical name/stub/command (362 backlog item "container-generated test stub"; 363 DEPENDS on
  it for this point and must not claim to solve exact-name with warnings), and `verify_task` compares
  observed vs canonical.
- **long-findings artifact** — when the contract requires a findings file, its existence is a check, not a
  request.

These land as findings in the 362 verification record (the machinery exists); 363 adds the protocol checks
and the Bridge-side event witness, not a second gate.

### 1. The generated primer (push — advisory orientation)

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

Dose per moment: **always the full compact primer** at all four moments (dueto major #3: delta-dosing needs
the container to model what the agent retained — hidden state that under-informs exactly when recovery is
needed; a ~30-line resend costs less than the ambiguity). A short generated delta section may APPEND changed
facts, never replace the canon. HARD budget ~30 lines (deep/static knowledge lives behind `orient` —
push-minimal, pull-complete). Runtime-aware flavoring (claude vs codex) only in phrasing, never in content.

**Placement (dueto major #2 — recency beats tidiness):** the opening primer orients, but action-time
obligations go in a **final `Before finishing:` block at the END of the composed brief** — doorbell, canonical
test name/command, findings-file rule, verify commands — the items that must survive to execution. Both
sections are rendered by the same compositor from the same source.

**Format is a design requirement, not styling:** fixed delimiters and ordering so agents learn to RECOGNIZE
the section; never long prose. Honest expectation (dueto blocker #1): the primer improves awareness, NOT
obedience — the protocol gate (§0) is the control; the primer's success metric is the blocker rate on gated
landings before/after (the gate's records already count this for free).

**Single source of truth (dueto major #7):** protocol rules + verify metadata live in ONE place; the primer,
the `Before finishing:` block, and the delegation-contract boilerplate are all RENDERED from it. Precedence is
mechanical: the task contract wins for task-specific requirements, the primer canon wins for global protocol,
and the gate enforces both.

### 2. The `orient` Bridge tool (pull — convenience, never authority)

One call returns the full orientation for the CALLER: identity (name, delegator, gate status), the complete
protocol, `settings.verify` commands, the CANONICAL behavior-test name/command for the caller's delegation
(copyable without interpretation — dueto major #6), tasks assigned to the caller, continuity pointer. v1 does
NOT include fleet state (`list_agents` owns that). Dueto major #4 accepted: caller identity on the Bridge is
self-declared (provenance, not authentication) — `orient` is a CONVENIENCE tool and never an authority
boundary; nothing security-relevant keys off its caller claim. Discoverability: the pointer lives in the
primer AND the final `Before finishing:` block ("call orient if unsure").

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

## Phasing (post-dueto)

- **Phase 1** — enforcement + orientation together (the dueto's order): the protocol gate's doorbell check
  (Bridge-witnessed `notify_agent`) + container-generated canonical behavior-test name/stub (with the 362
  backlog item) + the primer + the final `Before finishing:` block, all rendered from the single source.
  Dogfood on the next delegation wave; measure blocker + doorbell-miss rates before/after.
- **Phase 2** — `orient` (pull) + the findings-file protocol check + notify payload companion if ratified.

## MAINTAINER DECISIONS — RATIFIED (2026-07-07, all three)

1. **Enforcement-first.** 363 ships the protocol gate + container-generated canonical test name FIRST; the
   primer is advisory orientation. (The 4/4 exact-name + 2/4 doorbell statistics were the argument.)
2. **Doorbell miss = FINDING, non-blocking.** `protocol_doorbell_missed` surfaces in the verification record
   and the parent decides; harden to blocker only if data shows findings don't move behavior.
3. **Primer goes to EVERYONE** — declared and ad-hoc: per-spawn facts (who called you, fresh-worktree
   bootstrap) can't live in static instructions; ~30 lines coexists with curated charters.
