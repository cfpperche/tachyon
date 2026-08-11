# 213 — tachyon-worktree-diff-review

_Created 2026-06-14._

**Status:** shipped
**Closure:** Shipped as v0.13.3; commit `0b589cc9` records tasks 1–6 done and the two-round SHIP review.

**UI impact:** interaction
<!-- A "Review changes" action on a worktree agent → a quick-pick of changed files,
each opening VS Code's native diff editor (base ↔ current). Verified by driving a
real worktree with committed + uncommitted edits and opening the diff. -->

## Intent

**C2 — close the parallel-work loop: run (C1/210) → REVIEW → merge.**

Spec 210 gives each opt-in agent an isolated git worktree on its own branch. The
missing step is **seeing what it did** without leaving the editor. C2 adds a one-click
**Review changes** on a worktree agent that opens its diff — everything the agent changed
since the worktree was created (`baseRef` → current working tree, committed + uncommitted)
— in VS Code's **native diff editors**. It only *reads* the worktree (210 persisted the
path/branch/baseRef); merging stays human and out of scope (C3 is the verify-gate).

## Decisions

1. **Source of truth is the persisted `WorktreeRecord`** (210), read from the ledger:
   `path` + `baseRef`. Never recompute the branch/base from current config (it may have
   drifted) — review the worktree that actually ran.
2. **Diff = `baseRef` ↔ current working tree.** That's the agent's whole contribution:
   commits on its branch AND any uncommitted edits, in one view. Changed set =
   `git diff --name-status <baseRef>` (tracked) ∪ untracked
   (`git ls-files --others --exclude-standard`, shown as added). Renames/copies are
   surfaced as their post-image path.
3. **Native diff, self-contained — no dependency on the built-in git extension.** A
   `TextDocumentContentProvider` (scheme `tachyon-worktree`) serves the **base** side via
   `git show <baseRef>:<file>` run in the worktree; the **current** side is the on-disk
   file (`file://<path>/<file>`). `vscode.diff(base, current, "<file> (<base> ↔ worktree)")`
   opens the native side-by-side editor. Added → empty base; deleted → empty current.
4. **Quick-pick, not N editors.** Review opens a quick-pick listing changed files with their
   status (A/M/D) and a `+adds/-dels` stat; picking one opens its diff. Scales to a big diff
   without flooding the editor; ESC closes. (A future "open all" is out of scope.)
5. **Graceful empties / failures.** No changes → an info notice ("nothing to review"). The
   worktree path gone (record stale) or git unusable → a notice, no crash. The action only
   appears on worktree agents (the `-worktree` contextValue from 210).

## Behavior

- **Review changes** (tree context action on a worktree agent) → read the ledger
  `WorktreeRecord` → compute the changed-file set (base ↔ working tree + untracked) → show a
  quick-pick (status + path + stat) → selection opens `vscode.diff` for that file. Empty set
  or unusable worktree → notice.
- **MCP:** none here (review is a human action). C1 already exposes `pathForAgent` for any
  programmatic consumer.

## Non-goals

- Merge / PR / branch ops — human + plain git, unchanged (C1 spec); C3 is the verify-gate.
- A custom multi-file diff *webview* — native diff editors via quick-pick are enough; no
  bespoke UI.
- Diffing non-worktree agents — there's nothing isolated to review (they share the main tree,
  which the user reviews with normal SCM).
- "Open all diffs at once" / a review checklist — out of scope (quick-pick is the v1).

## Acceptance

- A worktree agent with committed + uncommitted edits → **Review changes** lists exactly the
  changed files (tracked + untracked), each opening a correct native diff (base ↔ current);
  added files show an empty base, deleted an empty current — verified live.
- The diff is computed against the **persisted baseRef**, not current config.
- No changes → a clear "nothing to review" notice; stale/removed worktree or unusable git →
  a notice, never a crash.
- The action shows only on worktree agents.
- Pure parsing (name-status + untracked → a typed changed-file list) and the diff-input
  construction (URIs/titles, add/delete empties) are unit-tested; a real-git integration test
  covers the changed-set computation on a tmp worktree.
