# 225 — tachyon-session-fork

_Created 2026-06-16._

**Status:** shipped
**Closure:** Shipped as v0.21.0 in commit `0ee33983`; all implementation and review tasks are checked and dogfood is recorded in `notes.md`.
**Status detail:** SHIPPED v0.21.0 (2026-06-16) — see notes.md. (dogfood pin `p-520b27`.)

**UI impact:** ui (a "Fork session" action + a new sibling agent in the tree).

## Intent

Ask a busy agent something **off the current task** without making it wait or derailing it: **fork the
agent's session at this instant** into a NEW sibling agent that carries the context so far, and let it
answer / do the parallel work while the original keeps going. The fork shows in the tree; the human
keeps or removes it. (Pin `p-520b27`.)

## Decisions (maintainer-locked 2026-06-16)
- **Context fidelity — accepted tradeoff:** the fork carries the target session's context **up to the
  fork instant only**. If the original has work in progress, the fork does NOT see anything that
  happens after the fork. The user owns this tradeoff.
- **Multi-runtime — native-fork ONLY (confirmed 2026-06-16, seed DEFERRED).** Fork is a **runtime
  capability**: an agent is forkable iff its adapter has a native fork primitive. v1 = **claude only**
  (`--fork-session`; glm inherits it via the claude CLI). Runtimes without native fork (codex/gemini)
  simply **don't offer fork** — NO degraded transcript-summary seed in v1 (it's lossy/misleading; add
  per-runtime only when that runtime gains a real fork). **Document per-runtime support clearly** so
  users know fork is claude-only for now.
- **The fork is a SIBLING**, not a lineage child (it's a peer agent, not a sub-agent of the original).
- **Worktree:** if the original has a worktree, the fork gets a **NEW worktree** (decoupled — never
  pollutes the original's). **Bonus if feasible:** fork the worktree's git state too (branch off the
  original's branch so the fork starts from the same working tree).
- **Trigger (proposed, confirm):** **manual** — a "Fork session" action on the agent (+ optionally a
  Bridge tool so the agent itself can request a fork). Auto-detecting an "off-task question" is
  AI-judgment-heavy/risky (the attention-heuristic class) → defer auto to a later pass.

## Step 1 — fork-primitive verification — DONE (live, 2026-06-16)
Tested in a throwaway `/tmp` cwd (isolated claude project dir, cleaned up after):
- **claude `--fork-session` — WORKS exactly as needed.** `claude -n <name> -p "remember ABC123XY"`
  (1 transcript) → `claude --resume <name> --fork-session -p "what was the secret?"` → **returned
  `ABC123XY`** (context carried) AND created a SECOND transcript (1→2) — i.e. the fork is a NEW session,
  the **original transcript untouched**. Ideal for a sibling fork that doesn't pollute the original.
- **codex — no native fork.** `codex resume --help` has no fork/branch/copy/clone flag → codex (and
  `gpt` via codex) use the **transcript-summary seed** fallback.
- **glm** (claude with a swapped base URL) inherits claude's `--fork-session`; **gemini** untested →
  assume seed unless a fork flag is found.
**Conclusion:** the locked design holds — native `--fork-session` for claude, transcript-summary seed
for the rest. `forkCommand(cmd, id)` → `--resume <id> --fork-session` for claude, null elsewhere.

## Design debate (codex, 2026-06-16) — RECOMMENDATION: BUILD-MVP (claude-native, manual)
Viable after narrowing; the draft overclaimed filesystem fidelity + non-native quality.
1. **Worktree fidelity** — V1 branches from the original worktree's **committed HEAD** and **warns when
   dirty state isn't copied**. Dirty snapshot (stash/copy) is NOT MVP.
2. **Seed-summary fallback — DEFER.** Needs another model call + transcript plumbing + cost/latency,
   and the result is lossy enough to mislead; don't ship it as "resume". → **v1 is claude-only.**
   _(Tension with the earlier "seed for non-native" decision — see the note below; maintainer to
   confirm defer-vs-keep.)_
3. **LIVE session id — fail-closed.** Newest-by-customTitle is a heuristic for a RUNNING agent; require
   a resolvable current claude UUID, else surface **"not forkable yet"** (never guess).
4. **Sibling ledger** — own persistent sibling row, NO parent lineage; the fork row must persist until
   explicit dismiss (ad-hoc kill can drop ledger state — guard that).
5. **Naming/tmux** — `<orig>-fork-N` unique across config/ledger/tmux/worktree. **Step 1b VERIFIED
   (live):** `claude -n forkB --resume forkA --fork-session` works as a combo → a NEW session whose
   jsonl `customTitle == forkB` (new uuid, original intact), and it carries the original's context. So
   the fork is itself a named session Tachyon resolves via the spec-220 customTitle capture.
6. **Scope** — claude-native + manual action + Tachyon-managed sessions only + new sibling + optional
   new worktree from committed HEAD + dirty warning. No auto-trigger, no seed fallback, no dirty snapshot.

**MVP (locked 2026-06-16; seed DEFERRED — maintainer confirmed):** fork a claude agent via a manual
"Fork session" action → resolve its current uuid (fail-closed) → spawn a SIBLING `<orig>-fork-N` as
`claude -n <fork-name> --resume <uuid> --fork-session` → if the original has a worktree, a new worktree
branched off its committed HEAD (+ a dirty warning). The action is shown ONLY for runtimes with native
fork (claude); others don't offer it. Defer: seed fallback, auto-trigger, dirty snapshot.

## Design sketch
- A **resume-adapter capability** `forkCommand(cmd, id) → string | null` — claude returns
  `--resume <id> --fork-session`; every other adapter returns **null = not forkable** (no seed in v1).
  Fork is offered iff the adapter's `forkCommand` is non-null → **native-fork-only is enforced by the
  capability**, not a special-case.
- **AgentManager.fork(name)** → fail-closed resolve the target's current uuid (spec-220 customTitle
  capture; if unresolved → throw "not forkable yet", never guess) → spawn a SIBLING `<orig>-fork-N`
  (unique across config/ledger/tmux/worktree) with `forkCommand`. The sibling gets its OWN persistent
  ledger row (resume block, `-n <fork-name>`), **NO parent lineage**, and must survive ad-hoc kill
  until explicit dismiss.
- **Worktree:** if the target has a worktree, create a new worktree for the fork branched off the
  original's **committed HEAD** (`git worktree add -b <fork-branch> <path> <orig-branch>`), and **warn**
  that uncommitted changes aren't carried. No worktree → the fork shares the workspace root.
- **Docs:** a clear per-runtime fork-support note (README + spec) — fork is **claude-only** today,
  extensible when a runtime gains a native fork primitive.
- **UI:** "Fork session" inline action gated on `forkCommand` (a `-forkable` contextValue, like
  `-verifiable`); the fork appears as a sibling agent; dismiss removes it (it's
  a normal ad-hoc agent in the ledger).

## Non-goals (v1)
- No auto "off-task" detection (manual trigger). No live in-memory fork (transcript-up-to-fork only).
- Not a merge-back of the fork's work into the original (it's a separate agent; the human reconciles).

## Acceptance
- Forking a claude agent mid-task spawns a sibling that resumes WITH the context up to the fork
  (native `--fork-session`), the original untouched and still running; a non-native runtime spawns a
  sibling seeded with a transcript summary. A worktree agent's fork gets its own worktree.
- Runtime-agnostic via the adapter (native where available, seed elsewhere); per-runtime support
  documented. codex dueto → SHIP.
