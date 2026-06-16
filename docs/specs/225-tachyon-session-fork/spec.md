# 225 — tachyon-session-fork

_Created 2026-06-16._

**Status:** draft — design locked with the maintainer; **blocked on the fork-primitive verification
(step 1) before the adapter design is final.** (dogfood pin `p-520b27`.)

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
- **Multi-runtime:** use the runtime's **native fork** where it exists (claude `--fork-session`);
  where it does NOT, **inject a summary of the target session's transcript** into a fresh agent
  (seed-context — less faithful, but works for any runtime).
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
5. **Naming/tmux** — `<orig>-fork-N` unique across config/ledger/tmux/worktree. **VERIFY (step 1b):**
   claude accepts a distinct `-n <fork-name>` together with `--resume <uuid> --fork-session` (claude
   rejects some flag combos, e.g. `--session-id` + `--resume`).
6. **Scope** — claude-native + manual action + Tachyon-managed sessions only + new sibling + optional
   new worktree from committed HEAD + dirty warning. No auto-trigger, no seed fallback, no dirty snapshot.

**MVP (locked from the debate, pending maintainer confirm on #2):** fork a claude agent via a manual
"Fork session" action → resolve its current uuid (fail-closed) → spawn a SIBLING `<orig>-fork-N` as
`claude -n <fork-name> --resume <uuid> --fork-session` → if the original has a worktree, a new worktree
branched off its committed HEAD (+ a dirty warning). Defer: seed fallback (codex/gemini), auto-trigger,
dirty snapshot.

## Design sketch (pending step 1)
- A **resume-adapter capability** `forkCommand(cmd, id)` (claude → `--resume <id> --fork-session`;
  others → null = "no native fork, seed instead").
- **AgentManager.fork(name)** → resolve the target's session id (reuse spec 220 capture), then:
  native → spawn a sibling with `forkCommand`; non-native → summarize the target transcript and spawn
  a fresh sibling seeded with that summary (+ the original's instructions). Sibling = a new ledger row,
  NOT under the original's lineage.
- **Worktree:** if the target has a worktree, create a new worktree for the fork (spec 210 `ensure`),
  ideally branched off the original's branch (`git worktree add -b <fork-branch> <path> <orig-branch>`).
- **UI:** "Fork session" inline action; the fork appears as a sibling agent; dismiss removes it (it's
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
