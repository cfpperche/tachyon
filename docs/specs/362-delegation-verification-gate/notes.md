# 362 — delegation-verification-gate — notes

_Created 2026-07-07. In-flight design memory — decisions, deviations, findings from the build + the T4 live
dogfood. Append-only by convention._

## Build history (T1-T3, triad-reviewed)

Every T was implemented by a codex ad-hoc, deterministically verified by the coordinator (full suite +
typecheck + suppression scan + tree state), and semantically reviewed by the declared `reviewer` (Sonnet 5,
spec 352 subagent) — full writeups in `.tachyon/reviews/<sha>.md`. Findings that reshaped the implementation:

- **T1 (348d725 + ec24ec7 + 509ef92)** — reviewer HIGH: `DelegationRecord.baseSha` trusted the worktree
  record's carried-forward `baseRef`, unsound on worktree REUSE. First fix attempt resolved the SOURCE tree's
  HEAD (wrong tree — diverges from the task branch on reuse) and fell back open; final fix resolves the TASK
  WORKTREE's tip after `ensure()`, fails closed, real-git X/Y/Z regression.
- **T2 (e1b3e0b + c641a77 + bdc0692)** — reviewer CRITICAL: the behavior pair ran in a bare temp worktree with
  no `node_modules` (measured the environment, not the test; invisible to unit tests that stubbed the runner).
  Fix moved the checkout dance into the agent's worktree. Reviewer HIGH on the fix itself: destructive
  checkout/clean on a LIVE agent's worktree — liveness check (`agent_still_running`) + WorktreeManager
  per-agent lock + atomic dirty re-check added. Plus: owns made optional-by-design, argv arrays (no shell).
- **T3 (a6a0c2e, amended thrice)** — reviewer MEDIUM: no short-circuit (expensive behavior pair ran on
  already-blocked verdicts, against the tiering rationale) + double checkout; fixed with one `runAtSha`
  critical section + `behavior_not_run` honesty entry. `{files}` existence filter was silently dropped twice
  before landing (F3 by the gate's own builder). Good call found in review: `loadVerifySettings` reads the
  SOURCE tree's tachyon.yml — an agent cannot weaken its own gate from inside its worktree.

## T4 live dogfood — first two gated delegations (faadLogos → t-faad51, menuFix → t-71b920)

Six verify_task runs, five TRUE blocks, two earned ACCEPTs. Every block was correct:

1. **`agent_still_running`** — the liveness HIGH working in production 20 minutes after landing.
2. **`full_tests_failed` (missing dist/)** — a fresh worktree has no build output; the plugin-ui e2e needs
   bundles. → `settings.verify.full = npm run verify:full` (build + suite) was born.
3. **`full_tests_failed` (missing script)** — BOOTSTRAP GAP: the canonical command referenced a package.json
   script committed to main AFTER the delegation's baseSha; the verified tree is the delivered tree. Phase-2
   item: a delegation re-base ceremony (rebasing breaks the frozen-baseSha scope check) or full-verify runs
   only post-merge on the integration tree (the current, documented posture).
4. **`behavior_already_passed` (vacuous toolchain)** — REAL Phase-1 defect: vitest `-t <name>` with zero
   matches exits 0, so fail-at-base was vacuous for plain names. Fixed in dd0b723: the default runner appends
   `--reporter=json`, parses the summary, and normalizes `executed==0` to synthetic exit 86 — direction-correct
   by construction (nonzero at base = expected fail; nonzero at head = blocker). The codex DEVIATED from the
   contracted file::name mandate with this strictly better design (reviewer-verified on the merits; deviation
   arrived unexplained — the norm stays "argue deviations, never silently").
5. **`behavior_failed` (contract violation) ×2** — BOTH gated deliveries named the behavior test differently
   from the contract's EXACT name ("named EXACTLY" reads as advisory to a codex). The gate blocked both;
   one-line rename fixes; ACCEPTs followed. Contract-pattern rule: **the behavior-test name is a protocol
   identifier, not a description** — quote it, keep it short, state that the gate greps it literally.

Post-ACCEPT flow exercised: merge --no-ff into main → `npm run verify:full` on the INTEGRATED tree (Decision 4
full-before-merge, adapted: full-after-merge-before-ship while the bootstrap gap stands) → visual pass →
task closed. Worktrees + task branches removed after merge.

## Known limitations / Phase-2 backlog (from reviews + dogfood)

- Vitest JSON reporter field names are an internal contract; vitest is unpinned (`^3`) and the unit test
  simulates the JSON — a real-vitest canary test or a pin would catch a breaking upgrade (reviewer MEDIUM,
  accepted non-blocking).
- Record diagnostics keep only firstLine(stdout/stderr) per command — misleading when the first stderr line is
  fixture noise (the 'sneaky' incident); keep failing test names / tails instead.
- Delegation re-base ceremony (see dogfood #3).
- `delegatedBy` in the DelegationRecord + sidebar nesting (t-1b6ab0) — gated spawns are top-level and render
  loose; the relationship exists only in the record today.
- Gated spawns cannot have a runtime parent (gate requires an isolated worktree; sub-agents inherit the
  parent's tree). Two maintainer double-takes in one day — t-1b6ab0 covers the display half; a gate+parent
  worktree mode would be the deeper fix.
- Empty-changed-list edge: `vitest related --run` with zero surviving files still runs (pure-deletion
  deliveries); behavior unverified — flagged in the T3 review as an open empirical question.
- A long-lived coordinator session's MCP tool list does not refresh when the Bridge gains tools (verify_task
  invoked via a direct MCP client this session) — feeds the frozen onboarding/orient discussion (t-0cfbd6).
- Session-suite flake seen once (unidentified, not verifyTask's 16) — watch.
- **Portability (maintainer question, 2026-07-07):** the architecture is stack-agnostic (pure git checks +
  config-declared commands + `cmd:` behavior escape — a Python/Rust/Go project can use the whole gate today
  via `settings.verify` + `cmd:pytest -k ...`), but the DEFAULTS are Node/vitest (behavior runner + JSON
  no-match normalization, `vitest related` affected, JS-leaning suppression patterns). Phase-2 item: per-stack
  behavior-runner adapters (vitest/pytest/cargo/go) behind one interface, and suppression pattern packs per
  test framework. Domain boundary: the gate verifies TESTED CODE deliveries; non-testable deliverables (docs,
  design) are Tier-2 `deliverables[]` territory.

## Deviations

- T3 gave `affected` a default (`npx vitest related --run {files}`) where the plan said skip-when-unconfigured
  — kept: a default affected run is aligned with the tiering intent.
- dd0b723's no-match normalization replaced the contracted file::name format — kept (better; see dogfood #4).
