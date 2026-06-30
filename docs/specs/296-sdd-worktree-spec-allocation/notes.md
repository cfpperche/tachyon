# 296 — sdd-worktree-spec-allocation — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- `flock` is not used. The lock is a directory created atomically under `<git-common-dir>/tachyon-sdd/`.
- The ledger is advisory local state: it prevents same-clone sibling worktrees from reusing in-flight numbers, but the
  durable source remains `docs/specs`.
- `check-ids.sh` is the merge/multi-clone safety net. It intentionally fails on duplicate prefixes rather than trying
  to renumber automatically.

## Deviations

- While dogfooding `check-ids.sh`, the current repo already failed with duplicate `255-*` specs:
  `255-panel-workspace-picker` and `255-tachyon-pin-studio-rich-pins`. Rich pins has many later references, so the panel
  picker spec was renumbered to `297-panel-workspace-picker` and its local references were updated.

## Tradeoffs

- The stale lock cleanup removes only the known lock directory after a conservative timeout. This favors recovering from
  killed agents over perfect ownership detection; the lock metadata is human-readable for diagnosis.
- The allocator may skip numbers when a ledger reservation is left behind. Skipping is acceptable; reusing a number is
  not.

## Open questions

- None.

## Verification log

- `bash docs/specs/296-sdd-worktree-spec-allocation/smoke.sh` passed. It creates two Git worktrees and scaffolds specs
  concurrently; observed distinct ids in both runs (`003/002`, then `002/003`).
- `sh /home/goat/tachyon-plugins/sdd/skills/sdd/scripts/check-ids.sh` now passes in `/home/goat/tachyon`.
- `sh -n` passes for `new.sh` and `check-ids.sh`.
- `npm test` passed: 138 files, 1838 tests passed, 3 skipped.
- `npm run -s typecheck` passed.
- Headless install dogfood passed through the real Tachyon plugin engine: `loadPlugin("/home/goat/tachyon-plugins/sdd")`
  → `previewInstall` → `applyInstall` into a temp Git workspace with both `.claude` and `.codex`. The updated skill
  materialized to `.claude/skills/sdd` and `.agents/skills/sdd`; the materialized `.agents/skills/sdd/scripts/new.sh`
  allocated `002` and `003` across two worktrees, and the materialized `.claude/skills/sdd/scripts/check-ids.sh` passed.
