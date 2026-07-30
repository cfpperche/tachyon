# 476 — codex-effective-model-proof — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Record the codex-cli 0.145.0 measurements in `notes.md` (stream records, rollout layout,
      `turn_context.payload.model`, private-home auth requirement, footprint with and without the
      disable flags) so every decision below is traceable to something observed.
- [x] Add `ProbeModelProof.evidence` to `src/probe/taxonomy.ts` and carry it through
      `resolveModelProof` in `src/probe/modelProof.ts` without changing any verdict rule.
- [x] Widen the adapter contract in `src/probe/adapters/types.ts`: promise-tolerant
      `buildInvocation`/`interpret`, `interpret(raw, spec, inv)`, optional `cleanup(inv)`, and a
      `modelEvidence` declaration alongside `reportsEffectiveModel`.
- [x] Await the new seams in `src/probe/ProbeRunner.ts`, and call `adapter.cleanup` in a `finally` so
      it runs on success, timeout, cancel, spawn failure and interpretation failure alike.
- [x] Create `src/probe/adapters/codexSessionEvidence.ts`: private-home preparation (mkdir + auth
      symlink) and teardown, plus the correlation chain — single `thread.started` → single matching
      `rollout-*-<thread_id>.jsonl` → `session_meta` re-check → every `turn_context.payload.model`.
      Export the pure parsers separately from the fs walk.
- [x] Rewrite `src/probe/adapters/codex.ts` onto it: private `CODEX_HOME`, `--ephemeral` removed,
      the disable flags, async `interpret` that attaches `sessionId` + `reportedNativeModels`,
      `cleanup`, `reportsEffectiveModel: true`, `modelEvidence: "session-record"`.
- [x] Declare `modelEvidence: "provider-usage"` on the Claude and Grok adapters.
- [x] Persist and surface the evidence source: `ProbeRunMeta`/`ProbeRunRecord` in
      `src/probe/ProbeStore.ts`, the pass-through in `src/probe/ProbeService.ts`, and the model
      tooltip in `src/probe/probeView.ts`.
- [x] Add `test/unit/probeAdapterCodex.test.ts` covering: proven, mismatch, multi-model turn set,
      no `thread.started`, two distinct `thread_id`s, no rollout, two matching rollouts, a rollout
      whose `session_meta` disagrees with its filename, an unparseable rollout, cleanup removing the
      private home, and the invocation carrying a private `CODEX_HOME` with no `--ephemeral`.
- [x] Update `test/unit/probeRunner.test.ts` (async seams, cleanup on timeout/cancel/crash) and
      `test/unit/probeProvenanceParity.test.ts` (Codex is now a capable runtime).
- [x] Add `scripts/dogfood/probe-codex-model-proof.ts` driving the real `codex` CLI end to end, and
      wire `dogfood:probe-codex-model-proof` in `package.json`.
- [x] Update `scripts/dogfood/probe-provenance-parity.ts` and `docs/runtimes/parity.md` to the new
      fleet state, and update the stale "Codex/Grok today" label in
      `scripts/dogfood/probe-model-proof.ts`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] A Codex run whose correlated rollout names the requested model completes `proven` with the
      identifier and evidence source persisted.
- [x] A Codex run whose correlated rollout names a different model fails `model_mismatch` naming both.
- [x] Missing, duplicated, or self-inconsistent correlation yields `unproven` with no effective model.
- [x] Timeout and cancel keep their own reason and still tear down the private Codex home.
- [x] No probe writes anything under the human's `CODEX_HOME`.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood -- probe-codex-model-proof`
**Dogfood:** `npm run dogfood -- probe-provenance-parity`

**Human dogfood:** optional — open the probe inspector after a Codex probe with an explicit model and
confirm the model cell reads the proven identifier with a tooltip naming the session record.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** no layout or component change — the probe model cell's states are unchanged
(SDD 475); only the hover title text gains a clause, which the unit tests assert directly.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface — the probe tools, flags and payloads are unchanged;
this alters what a Codex probe can prove about itself, not how anyone invokes one.
