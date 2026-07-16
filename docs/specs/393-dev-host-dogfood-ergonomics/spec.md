# 393 — dev-host-dogfood-ergonomics

_Created 2026-07-16._

**Status:** shipped

**Branch:** `grok/dev-host-dogfood-ergonomics` → main  
**Worktree:** `/home/goat/tachyon-worktrees/dev-host-dogfood-ergonomics`

**Closure:** 2026-07-16 — Dev Host dogfood ergonomics (P0–P3): mirror `.tachyon` copy locked by test, `point-status` doctor, `--fixture` / `fixture-new`, worktree tool resolve + stale pointer, fixture drift warn, runbook preferred F5 path. Commits `08443142` / `c87ac17a` on branch; landed via merge to main.

## Intent

Dev Host is the right isolation model (pointer F5, fixture workspace, never monorepo root), but **arming and diagnosing it still costs dogfood time**. Spec 390 hit real friction: SoulError when fixture `.tachyon` was only a symlink out of the mirror; “missing metrics” when the fixture was Live 0; long manual `point` paths; worktree pre-commit hooks looking for `.tachyon/bin/_tachyon-tool` relative to the worktree cwd; pointer left armed after worktree remove.

**Done** means a small, ordered hardening of the **mount / diagnose / fixture / lifecycle** path (P0→P3 below) so the next feature dogfood spends time on product, not re-learning the lane.

## Priority bands (in scope)

| Band | Theme | Outcome |
|------|--------|---------|
| **P0** | No silent regress on mirror + docs + status | `.tachyon` copy is tested; runbook states symlink vs copy; `point-status` fails closed / warns loudly |
| **P1** | Predictable fixtures + one-shot arm | Fixture scaffold + intent presets; `point --fixture <slug>` |
| **P2** | Worktree + lifecycle less sticky | Hooks resolve tool from monorepo/common dir; stale pointer warn / clear on remove guidance |
| **P3** | Optional polish | Re-materialize when fixture drifts; prefer F5 vs headless in one runbook path; auto-lease for F5 deferred if costly |

## Acceptance criteria

### P0 — harden what we already fixed

- [x] **Scenario: mirror `.tachyon` is a real directory**
  - **Given** a fixture with `.tachyon/…` seed content
  - **When** `point` materializes the workspace mirror
  - **Then** mirror `.tachyon` is a real directory (not a symlink), content is readable, and a unit test locks this
- [x] **Scenario: point-status reports health**
  - **Given** an armed pointer
  - **When** `point-status` (or equivalent doctor flags) runs
  - **Then** it reports extension target, workspace mirror path, whether mirror `.tachyon` is real, and warns if worktree or `dist/` is missing
- [x] Runbook `docs/runbooks/dev-host.md` documents symlink-vs-copy table and SoulError → rematerialize/repoint

### P1 — fixture contract + ergonomic arm

- [x] **Scenario: fixture-new scaffolds a dogfood fixture**
  - **Given** `npm run dogfood:dev-host -- fixture-new --slug <s> --spec <NNN>` (or equivalent)
  - **When** the command completes
  - **Then** `test/fixtures/<s>-dogfood/` has `tachyon.yml`, README checklist, and seeded `.tachyon/` layout; README notes `git add -f` for ignored `.tachyon/`
- [x] **Scenario: intent presets are documented**
  - **Given** a scaffolded or existing fixture README
  - **When** a human reads “intent”
  - **Then** at least two presets are named: **focus** (stopped OK) and **metrics** (autostart/running for CPU/MEM peek)
- [x] **Scenario: point --fixture**
  - **Given** a fixture under `test/fixtures/<slug>` (or `*-dogfood`)
  - **When** `point --worktree <wt> --fixture <slug>` (or short form)
  - **Then** workspace resolves without a long absolute path and pointer arms successfully

### P2 — worktree hooks + lifecycle

- [x] **Scenario: pre-commit works from an isolated worktree**
  - **Given** a git worktree without its own populated `.tachyon/bin`
  - **When** pre-commit leaf runs `_tachyon-tool`
  - **Then** the tool resolves via monorepo / git common dir (no manual symlink required)
- [x] **Scenario: stale pointer is visible**
  - **Given** pointer meta points at a removed worktree path
  - **When** `point-status` runs
  - **Then** it reports unarmed/broken (nonzero or clear warning), not a silent “armed”

### P3 — polish (may ship-partial)

- [x] **Scenario (optional): fixture drift note or re-point**
  - **Given** fixture `.tachyon` changed after last `point`
  - **When** status/doctor runs or re-point is invoked
  - **Then** either re-materialize is automatic or status warns that mirror may be stale
- [x] Runbook has one **preferred** human path (F5 pointer) and marks CLI `seed`/`launch` / headless as secondary without deleting them

## Non-goals

- Redesign of isolation rules (still never open monorepo root as EDH workspace).
- Merging Dev Host into the live fleet window or installing VSIX for this path.
- Auto-lease for every F5 (P3 only if cheap; otherwise document manual lease for delegated GUI).
- New product UI surfaces (sidebar, Activity) — this is scripts + runbook + tests only.
- Fixing all historical `DOGFOOD.md` files outside the runbook pointer section.

## Open questions

- Exact CLI names: `fixture-new` vs `scaffold-fixture`; keep under `dogfood:dev-host` subcommands.
- Hook fix: change leaf wrappers only vs regenerate managed hook path resolution in core (prefer minimal leaf/common-dir resolve).
- Whether P3 re-materialize is in v1 or **shipped-partial** after P0–P2.
