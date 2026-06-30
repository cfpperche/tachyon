# 296 — sdd-worktree-spec-allocation — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Change the `sdd` plugin's scaffold path, not Tachyon core. `new.sh` remains a bundled shell script and keeps the
existing local fallback, but when it can identify a Git common directory it will coordinate all sibling worktrees of the
same clone:

1. Resolve the current workspace root and Git common dir with `git rev-parse`.
2. Take a portable lock by atomically creating a directory under the common dir.
3. While holding the lock, scan `docs/specs` in the current worktree, every sibling worktree from `git worktree list
   --porcelain`, and a local ledger of prior reservations.
4. Reserve the next free `NNN` in the ledger, create `docs/specs/NNN-slug`, and write templates exactly as today.
5. Add a `check-ids.sh` script that detects duplicate `NNN` prefixes in one workspace, covering branch merges and
   separate clones where no same-clone lock could have coordinated.

## Key decisions

- **Portable `mkdir` lock, no `flock` dependency** — chosen because the skill is runtime-neutral and already targets
  POSIX shell. `flock` is useful on Linux but not needed for the contract.
- **Use Git common dir for same-clone coordination** — chosen because all worktrees of one clone share it, while their
  working trees do not share `docs/specs`.
- **Ledger is local/untracked** — chosen because it coordinates in-flight local reservations without creating repo
  churn or merge conflicts. It is not a source of truth; `docs/specs` remains the durable source.
- **Duplicate checker for remote/multi-clone cases** — chosen because no local lock can serialize two different clones
  or machines. The correct boundary is detect-and-repair at merge/rebase time.
- **No Tachyon core allocator** — rejected because the current SDD behavior lives entirely in the plugin and can be
  fixed there without a Bridge/core dependency.

## Files touched

- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/new.sh` — add common-dir lock, ledger, sibling-worktree scan.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/check-ids.sh` — new duplicate-ID checker.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/SKILL.md` — document the improved `new` contract and checker.
- `/home/goat/tachyon-plugins/sdd/tachyon-plugin.json` — bump plugin patch version.
- `docs/specs/296-sdd-worktree-spec-allocation/*` — this delivery record.

## Risks & unknowns

- A stale lock directory after a killed process could block future scaffolds. Mitigation: record lock metadata and allow
  a conservative stale timeout.
- `git worktree list --porcelain` paths can contain spaces. The parser must read whole `worktree <path>` lines, not
  split on whitespace after the path has been captured.
- The ledger can contain stale reservations from abandoned scaffolds. That is acceptable: it may skip numbers but must
  not reuse them in a way that causes collision.
- `new.sh` is POSIX `sh`; avoid arrays, process substitution, or Bash-only syntax.

## Sources consulted

- Pin `p-7ea86e` via Tachyon Bridge `get_pin`.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/new.sh` current allocator.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/SKILL.md` current `new` contract.
- `docs/specs/295-sdd-verify-close/spec.md` for the SDD plugin's current lifecycle and verification style.
- Git `rev-parse --git-common-dir` and `git worktree list --porcelain` docs.
