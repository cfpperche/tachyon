# 396 — engine-stable-dev-channels — tasks

_Generated from `plan.md` on 2026-07-17. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add backward-compatible `stable|dev` manifest and live-identity contracts; include the channel in new bundle ids.
- [x] Stamp ordinary builds as dev and stable prepublish builds from the canonical-main source gate.
- [x] Recheck stable manifest/source provenance during package preparation and record it in embedded/audit provenance.
- [x] Require production shells to stage stable and development shells to stage dev.
- [x] Mark Dev Host fixtures, refuse unmarked development workspaces and isolate XDG cache/data/state in F5 and CLI lanes.
- [x] Make stable same-version drift fail and dev same-version drift use controlled upgrade/rollback; preserve legacy migration.
- [x] Update the Dev Host runbook and task `t-415444` relationship/closure evidence.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Temporary Git repositories force every stable source refusal and the exact-main success path.
- [x] Bundle store tests force expected-channel refusal and legacy rollback readability.
- [x] Supervisor tests force stable conflict, dev refresh, cross-channel refusal and legacy-to-stable upgrade.
- [x] Dev Host tests force marker and XDG isolation across portable F5 and CLI configuration.
- [x] Production/development client tests force their expected packaged channel.
- [x] Typecheck, engine boundary, build, diff-check and the complete test suite pass.

**Headless check:** `npm exec vitest run test/unit/packageCleanGate.test.ts test/unit/engineServiceProtocol.test.ts test/unit/engineBundleStore.test.ts test/unit/engineSupervisor.test.ts test/unit/devHostBoundary.test.ts test/unit/devHostPointer.test.ts test/unit/devHostLauncher.test.ts test/unit/controlInspector.test.ts`
**Verify:** `npm exec vitest run test/unit/packageCleanGate.test.ts test/unit/engineServiceProtocol.test.ts test/unit/engineBundleStore.test.ts test/unit/engineSupervisor.test.ts test/unit/devHostBoundary.test.ts test/unit/devHostPointer.test.ts test/unit/devHostLauncher.test.ts test/unit/controlInspector.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run check:engine-boundary`
**Verify:** `npm test`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm run dogfood -- dev-host -- headless`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** after merge only, build the next version from clean current `main`, install its VSIX, Reload Window, and confirm the live identity reports `stable` with the manifest commit while existing agents survive the controlled upgrade.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** no new layout or interaction; the change is a build/runtime boundary with headless diagnostics.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <396>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** the existing Dev Host runbook is the operator surface and will be updated in place.
