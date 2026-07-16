# 387 — canonical verifier hermeticity — plan

## Approach

1. Add `verify:prepare` as the tracked, lockfile-backed install-and-build adapter.
2. Keep the verifier's private temp lifecycle unchanged and route only Linux filesystem-socket fixtures
   through a short test-owned temp helper, independent of an ambient verifier `TMPDIR`.
3. Replace first-line persistence with capped output tails, and carry timeout/signal metadata from the
   process runner into records and blocker summaries.
4. Prove the failure modes in focused `verifyTask` tests, then reproduce the affected Vitest command in
   a clean tracked-only clone prepared through the new script.

## Failure behavior

Preparation remains fail-closed. Unknown or unsafe clone parents are never removed. Cleanup failure
remains an error. Diagnostics are capped per stream and favor the tail where test runners report failures;
termination metadata remains structured even when the child emits no useful output.

## Files

- `package.json`
- `src/bridge/verifyTask.ts`
- `test/helpers/socketTemp.ts`
- `test/unit/{engineControlClient,engineControlServer,engineProcessBoundary,engineService,engineSupervisor,workspaceClient}.test.ts`
- `test/unit/verifyTask.test.ts`
- `docs/specs/387-canonical-verifier-hermeticity/**`
