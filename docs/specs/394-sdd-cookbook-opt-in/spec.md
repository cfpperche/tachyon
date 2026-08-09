# 394 — sdd-cookbook-opt-in

_Created 2026-07-16._

**Status:** shipped
**Closure:** 2026-07-16 — SDD plugin **1.5.0** published as `github:cfpperche/tachyon-plugins@v0.32.0#path=sdd` (commit `9f7b76e`). Opt-in `cookbook.md` + `sdd-cookbook.sh` + warning-only `close` hygiene. Installed in this workspace; dogfood on 392 showed no `cookbook-missing` with cookbook present; counterfactual surface without cookbook still warns. Tests: `test-cookbook-close.sh` + `test-visual-close.sh` green.

**Verify:** `bash /home/goat/tachyon-plugins/sdd/skills/sdd/scripts/test-cookbook-close.sh && bash /home/goat/tachyon-plugins/sdd/skills/sdd/scripts/test-visual-close.sh`

## Intent

SDD proves intent (`spec.md`), approach (`plan.md`), steps (`tasks.md`), and mechanical
proof (Verify / Dogfood / Visual QA). It still has no first-class place for **how a human or
sibling agent operates a newly shipped surface** (Bridge tools, registry lifecycle, CLI).

That gap showed up on spec 392 (managed worktree registry): the contract and review were solid,
but explaining "how it works now" required an ad-hoc conversation because no cookbook artifact
existed.

Add an **opt-in cookbook** contract to the SDD plugin (source: `tachyon-plugins/sdd`):
`cookbook.md` is not scaffolded by `new`; agents opt in at ship time via `sdd-cookbook.sh`
and `**Cookbook:** yes`, or opt out with a non-empty reason. `close` warns (does not hard-fail)
when a likely operator surface ships without either — same warning-only posture as Visual QA
(spec 326).

## Acceptance criteria

- [x] **Scenario: new does not force a cookbook**
  - **Given** an agent runs `sdd new <slug>`
  - **When** the scaffold completes
  - **Then** only the four core files exist; no empty `cookbook.md` is created
- [x] **Scenario: opt-in scaffold**
  - **Given** an existing spec dir under `docs/specs/`
  - **When** `sdd-cookbook.sh <spec|NNN>` runs
  - **Then** `cookbook.md` is written from the template and a second run refuses to overwrite
- [x] **Scenario: close warns missing cookbook on operator surface**
  - **Given** a shipped spec whose `spec.md` names a concrete surface tool (e.g. `create_worktree`)
  - **When** `sdd close` audits it and there is no `cookbook.md` and no valid opt-out
  - **Then** it emits warning `cookbook-missing` without treating that alone as a hard finding
- [x] **Scenario: cookbook file or opt-out clears the warning**
  - **Given** the same shipped surface spec
  - **When** `cookbook.md` exists, or `**Cookbook-Opt-Out:** <reason>` is present
  - **Then** `cookbook-missing` is not emitted (opt-out is printed as an informational warning)
- [x] **Scenario: explicit Cookbook flag without file still warns**
  - **Given** a shipped spec declares `**Cookbook:** yes` but has no `cookbook.md`
  - **When** `sdd close` runs
  - **Then** it warns `cookbook-missing` even if the body has no tool-name heuristic hit
- [x] Empty `**Cookbook-Opt-Out:**` yields `cookbook-opt-out-empty` (warning).
- [x] Existing verify/dogfood/visual-qa close behavior is preserved.
- [x] Plugin version is bumped to **1.5.0** in `tachyon-plugin.json`.

## Non-goals

- No hard close failure for missing cookbooks in v1.
- No auto-generation of cookbook content from code.
- No change to Tachyon engine plugin format (pure skill payload).
- Cookbook is not a substitute for Dogfood or Verify.

## Open questions

- None for v1; widen heuristic later if false negatives appear in the wild.
