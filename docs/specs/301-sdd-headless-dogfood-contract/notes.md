# 301 — sdd-headless-dogfood-contract — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Spec number is 301 because an interrupted earlier scaffold allocated 300 and was removed before commit; the SDD allocator ledger correctly avoided reusing it.
- External reference summary: Claude Code hooks can enforce Stop/SubagentStop behavior inside Claude, and Codex CLI supports headless execution, but the SDD plugin should not depend on either runtime-specific surface. The contract stays markdown + shell.
- Claude probe `probe-31453057-ffc9-42ef-af08-d1479d2d8226` returned NEEDS-REVISION on the draft. Accepted changes: close must require a passing Dogfood log, not just a declaration; opt-out must require a non-empty reason and remain visible; `shipped-partial` enum drift must be resolved; 301's dogfood must be a representative fixture smoke, not just running the helper on itself.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- Materialization proof is covered by `test/unit/sddDogfoodMaterialization.test.ts` instead of a spec-local Vitest file because Tachyon's Vitest config only includes `test/unit/**/*.test.ts`. The first attempt in `docs/specs/.../materialization.test.ts` was ignored by Vitest, so the test was moved into the configured test tree and the Verify command was corrected.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- `sdd-close` treats a valid `Dogfood-Opt-Out` as a warning, not a finding. This keeps historical or non-headless specs closable without hiding the debt.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None for this slice. Freshness enforcement against the exact commit that changed the feature is intentionally deferred; v1 records the commit SHA in the log but does not fail close on mismatch.

## Validation log

- 2026-06-30 — `bash -n sdd/skills/sdd/scripts/sdd-dogfood.sh sdd/skills/sdd/scripts/sdd-close.sh sdd/skills/sdd/scripts/spec-verify.sh` from `/home/goat/tachyon-plugins` passed.
- 2026-06-30 — `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify` passed, covering preview no-write, run+log, missing dogfood failure, declared-but-unrun failure, valid opt-out warning/pass, empty opt-out failure, and insertion into `## Dogfood log` before later sections.
- 2026-06-30 — `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh dogfood` passed with the same fixture coverage.
- 2026-06-30 — `npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts` passed: 3 files, 186 tests.
- 2026-06-30 — `npm run -s typecheck` passed as part of the declared Verify command.
- 2026-06-30 — Materialization proof: `test/unit/sddDogfoodMaterialization.test.ts` installed `/home/goat/tachyon-plugins/sdd` through Tachyon's real plugin engine into a temp workspace and verified byte-identical `sdd-dogfood.sh` plus `Dogfood-Opt-Out` docs in both `.claude/skills/sdd` and `.agents/skills/sdd`.

## Dogfood log

### 2026-06-30T17:03:55Z — pass (1/1) — source: tasks.md — commit: cdc50591223d6d736554205ae0e06110b80766bb
- `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh dogfood` — pass


### 2026-06-30T17:07:30Z — pass (1/1) — source: tasks.md — commit: cdc50591223d6d736554205ae0e06110b80766bb
- `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh dogfood` — pass

## Verification log

### 2026-06-30T17:05:10Z — pass (1/1) — source: tasks.md
- `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify && npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts && npm run -s typecheck` — pass

### 2026-06-30T17:06:16Z — pass (1/1) — source: tasks.md
- `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify && npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts && npm run -s typecheck` — pass

### 2026-06-30T17:07:30Z — pass (1/1) — source: tasks.md
- `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify && npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts && npm run -s typecheck` — pass
