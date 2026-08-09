# 296 — sdd-worktree-spec-allocation

_Created 2026-06-30._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes / placeholders). -->

**Closure:** Shipped locally 2026-06-30 in `tachyon-plugins/sdd` v1.3.0. `new.sh` now coordinates same-clone sibling
worktrees through a portable `mkdir` lock + local ledger under Git's common dir, scans sibling worktrees before choosing
the next `NNN`, and keeps the non-Git/local atomic `mkdir` fallback. Added `scripts/check-ids.sh` to detect duplicate
`docs/specs/NNN-*` prefixes for merge/multi-clone cases. Documented the guarantee and limitation in `SKILL.md` and the
plugins catalog. While dogfooding the checker, an existing duplicate `255-*` in this repo was found and cleaned by
renumbering the panel-workspace-picker spec to `297-panel-workspace-picker`, leaving rich pins as spec 255 because later
specs reference it. Verified by `bash docs/specs/296-sdd-worktree-spec-allocation/smoke.sh`, `sh .../check-ids.sh`,
`npm test`, `npm run -s typecheck`, and a headless install dogfood through the real plugin engine
(`loadPlugin → previewInstall → applyInstall`) materializing the updated `sdd` skill into `.claude/skills/sdd` and
`.agents/skills/sdd`, then running the materialized scripts.

**Verify:** `bash docs/specs/296-sdd-worktree-spec-allocation/smoke.sh`

## Intent

The `sdd` plugin's `new.sh` allocates the next `docs/specs/NNN-*` number by scanning only the current worktree, then
creating the target directory with atomic `mkdir`. That is safe for two agents racing inside the same worktree, but it
does not protect local multi-worktree development: two agents in sibling worktrees can both see `295` as the current max
and independently create `296-*`.

Done means the `sdd new` scaffold remains shell-portable and does not depend on `flock`, while coordinating same-clone
worktrees through Git's shared common directory. It also ships a duplicate-ID checker for the cases no local lock can
solve, such as separate clones, separate machines, or a merge that brings in another branch's same `NNN`.

## Acceptance criteria

- [x] **Scenario: concurrent local worktrees allocate distinct numbers**
  - **Given** one Git clone with two worktrees that share the same `git-common-dir`
  - **When** `sdd` scaffolds a new spec from both worktrees concurrently
  - **Then** the created spec directories use different `NNN` prefixes.
- [x] **Scenario: no `flock` dependency**
  - **Given** a POSIX shell with no usable `flock`
  - **When** the allocator needs to serialize another local allocator
  - **Then** it uses an atomic `mkdir` lock under the shared Git common dir and still succeeds.
- [x] **Scenario: non-Git or single-worktree fallback stays usable**
  - **Given** a workspace without a Git common dir
  - **When** `new.sh <slug>` runs
  - **Then** it keeps the previous local `docs/specs` scan + atomic target-directory creation behavior.
- [x] **Scenario: duplicate IDs are mechanically detected**
  - **Given** `docs/specs/300-a` and `docs/specs/300-b` exist in one workspace
  - **When** the duplicate checker runs
  - **Then** it exits nonzero and names the duplicated `NNN`.
- [x] The allocation ledger is local machine state under the Git common dir, not a tracked repo file.
- [x] The `sdd` skill text documents the same-clone guarantee and the multi-clone/merge limitation plainly.

## Non-goals

- Global coordination across different clones, machines, or remotes.
- A `sdd renumber` command. Manual renumbering is acceptable for v1 duplicate repair.
- A Tachyon core service or Bridge-backed allocator. This stays inside the `sdd` plugin payload.
- Dependence on Linux-only `flock`.

## Open questions

- None. Owner asked whether this can be done without `flock`; answer is yes via `mkdir` locking.
