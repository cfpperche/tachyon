# 213 — tachyon-worktree-diff-review — notes

## Origin
Roadmap item **C2** (Agent0 memory `project_tachyon_overclock_re_roadmap`): the review
step of the parallel-work loop. Greenlit to spec after C1 (210, shipped v0.13.0) which
explicitly exposed the worktree path/branch/baseRef (`WorktreeRecord` + `pathForAgent`) for
C2 to consume. NOT the dogfood pin "C2" (`p-b1149d` = screenshots in pins/notes — unrelated,
a naming collision).

## Why native diff, self-contained
- The built-in `vscode.git` extension *could* serve git content via its `git:` URI provider,
  but depending on it is fragile (it can be disabled / its API is not contract-stable). A
  tiny `TextDocumentContentProvider` of our own (`tachyon-worktree`) backed by `git show
  <ref>:<file>` in the worktree is self-contained and testable, and `vscode.diff` gives the
  real native side-by-side editor for free.
- Diffing **baseRef ↔ working tree** (not just HEAD) captures committed + uncommitted in one
  view — the agent's whole contribution since the worktree was born.

## Scope guard
C2 only READS the worktree. Merge/PR stay human + plain git (C1 decision). C3 (verify-gate,
which merges with the parked Overclock "validated handoff" item) is a separate spec. No
webview, no "open all", no review checklist in v1 — a quick-pick → native diff is the loop-closer.

## Edges (carried into plan)
added/untracked → empty base; deleted → empty current; renames → post-image path + old-path
base; binary → marked/skipped (git show returns bytes); worktree removed or baseRef gone →
notice / treat base as empty, never crash.

## Status
**Shipped v0.13.3.**

## Closure
**Closure:** shipped as **v0.13.3**. Tasks 1-6 done; codex dueto **2 rounds** (2 findings,
both fixed + tested): R1 — git path parsing was newline/tab (broke on C-quoted non-ASCII/
space paths) → now `-z` NUL-delimited everywhere; reviewWorktreeItem (and removeWorktreeItem,
same latent bug) weren't hidden from the Command Palette → both now `when:false`. R2 — **SHIP**
(codex empirically verified the URI round-trip for `?`/`#`/space/`%`). 366 tests (incl. a
real-git integration test that validates the `-z` parse) + typecheck. Task 6's interactive EDH
portion (quick-pick → native diff) is a maintainer smoke recipe; the pure parse + the
changed-set computation are unit/integration-tested. No open follow-ups; C3 (verify-gate) stays
a separate spec. The parallel-work loop (run → review → merge) is now complete in-editor.
