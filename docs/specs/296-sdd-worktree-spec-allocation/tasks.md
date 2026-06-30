# 296 — sdd-worktree-spec-allocation — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Update `new.sh` to resolve workspace root, Git common dir, and sibling worktrees when Git is available.
- [x] Add a portable `mkdir` lock under the Git common dir with stale-lock metadata handling; do not call `flock`.
- [x] Add local ledger reservation under the Git common dir and include ledger numbers in next-ID selection.
- [x] Scan sibling worktrees' `docs/specs/NNN-*` dirs while holding the lock.
- [x] Preserve the non-Git fallback behavior.
- [x] Add `check-ids.sh` to detect duplicate `docs/specs/NNN-*` prefixes.
- [x] Update `SKILL.md` and bump the `sdd` plugin patch version.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Concurrent two-worktree smoke creates distinct IDs.
- [x] Duplicate checker exits nonzero for duplicate prefixes and zero for unique prefixes.
- [x] Non-Git fallback still scaffolds a spec.
- [x] No `flock` reference exists in the shipped `sdd` script path.

**Headless check:** `bash docs/specs/296-sdd-worktree-spec-allocation/smoke.sh`
**Verify:** `bash docs/specs/296-sdd-worktree-spec-allocation/smoke.sh`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Human approval:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     things to eyeball). Name the steps here when human sign-off matters. -->
