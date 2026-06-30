# 301 — sdd-headless-dogfood-contract — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Run `probe_agent` with Claude to review the contract and fold accepted feedback into spec/plan/tasks.
- [x] Implement `sdd-dogfood.sh` in `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/`.
- [x] Extend `sdd-close.sh` with `dogfood-missing`, `dogfood-unrun`, invalid opt-out, and visible opt-out support.
- [x] Update `SKILL.md` with the dogfood subcommand and contract definitions.
- [x] Update templates to include headless dogfood, optional human dogfood sections, and a consistent status enum.
- [x] Update plugin manifest/version and tachyon-plugins README.
- [x] Dogfood the new helper in temp fixture specs, including preview, run+log, missing dogfood close failure, and opt-out close pass.
- [x] Materialize/install dogfood through Tachyon plugin engine or equivalent real plugin install path.
- [x] Mark pin `p-2c37de` done only after implementation, validation, and materialization proof.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] `sdd-dogfood.sh` previews without running/writing.
- [x] `sdd-dogfood.sh --run` executes and logs under `## Dogfood log`.
- [x] `sdd-close.sh` flags shipped specs with no Dogfood/Opt-Out.
- [x] `sdd-close.sh` flags shipped specs with Dogfood declared but no passing Dogfood log.
- [x] `sdd-close.sh` accepts shipped specs with a passing Dogfood log.
- [x] `sdd-close.sh` accepts shipped specs with a non-empty Dogfood-Opt-Out while surfacing the opt-out in output.
- [x] Shell syntax checks pass for all SDD scripts.
- [x] Tachyon plugin materialization includes the new script and docs in both runtime skill dirs.

**Headless check:** `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify && npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts && npm run -s typecheck`
**Verify:** `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify && npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts && npm run -s typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Dogfood:** `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh dogfood`

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     things to eyeball). Name the steps here when human sign-off matters. -->
