# 312 — silent-persistence-hooks — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Initial scope is persisted agents only. Ad-hoc agents remain off by default to preserve spec 307's opt-in persistence
  policy.
- Preferred event split before review: `SessionStart` for continuity rehydrate, `Stop` for handoff bookkeeping,
  `PreCompact/PostCompact` as follow-pass unless review identifies a correctness gap.
- `Stop` does not author project handoff notes. It records deterministic lifecycle evidence only; semantic handoff content
  remains explicit through `append_project_handoff_note` or human handoff editing.
- Pane-nudge suppression is gated on actual spawn-time hook injection, not on config eligibility alone. A declared agent
  whose hooks are skipped (for example Claude with user `--settings`) falls back to the old visible reminder path.
- `settings.persistence.silentHooks: false` is the workspace kill switch and restores the legacy visible reminders.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The original plan said "disable or bypass visible nudges when silent hooks are available" but did not define the
  proof of availability. Implementation records the actual `withSessionOwnership` injection result and suppresses only
  for the current spawn when the silent persistence hook bundle was injected.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Codex hook invisibility still needs human/live dogfood in VS Code after installing the VSIX. Unit tests prove generated
  config shape; real UI dogfood should confirm no pane-visible hook output.

## Review log

- 2026-07-01: Requested Claude adversarial review via `probe_agent` (ad-hoc/headless, not persistent agent). First run
  `probe-5b71d5cb-2048-4176-ba75-72b2ac2c239b` timed out after 120s with no artifact. Second run
  `probe-842ff454-a993-43cc-b499-382fb7815c58` completed but failed schema parsing (`missing findings[]`), so it did
  not provide actionable structured review.
- 2026-07-01: Third Claude `probe_agent` freeform run (`probe-be0ea624-2c9d-4f69-81c0-d7915d06a2f4`) completed but
  returned only a partial startup/tool-use message, not a review. Direct `claude -p` attempts with `$0.20` and `$0.60`
  budgets both exited with `Exceeded USD budget` before producing review text. Claude review remains blocked by
  probe/CLI execution behavior, not by spec ambiguity.
- 2026-07-01: After spec 313 / Tachyon 0.54.13, Claude structured review succeeded with `probe-24fd4d46-52c4-4e37-a91e-7222bb22c50e` (`reason: ok`, cost `$0.2158152`). Blockers folded before final verification:
  actual hook injection must gate nudge suppression; Claude `--settings` skip must not silently lose persistence; add an explicit kill switch.

## Verification log

### 2026-07-01T15:50:57Z — pass — focused implementation checks
- `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/continuityWiring.test.ts test/unit/config.test.ts` — pass, 139 tests.
- `npm run typecheck` — pass.

### 2026-07-01T15:52:23Z — pass — full regression suite
- `npm test` — pass, 141 files, 1922 tests passed, 3 skipped.
- `npm run build` — pass.

### 2026-07-01T15:52:01Z — pass (1/1) — source: tasks.md
- `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/continuityWiring.test.ts test/unit/config.test.ts && npm run typecheck` — pass

## Dogfood log

### 2026-07-01T15:52:14Z — pass (1/1) — source: tasks.md — commit: 69d30e9b376208fa4b0212572096f0fb0c667a48
- `npm test -- test/unit/continuityWiring.test.ts -t "spec 312"` — pass
