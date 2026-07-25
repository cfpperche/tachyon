# 449 — canonical-codex-native-policy-authoring — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add shared constructors for the exact supported Codex scalar policies and defaults.
- [x] Seed canonical New Agent fields and strip Codex defaults from non-Codex creation payloads.
- [x] Add localized per-family Exclude / Global / Workspace controls to Agent Studio.
- [x] Add focused default, round-trip, adapter-switch and projection tests.
- [x] Capture Dev Host visual/behavior evidence and close the spec.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] New canonical Codex payload authors global permissions/interface/featureFlags.
- [x] Exclude/global/workspace choices round-trip; non-Codex payloads omit Codex policy.
- [x] Global `approval_policy = "never"` reaches the generated typed projection without unrelated keys.

**Headless check:** `npx vitest run test/unit/agentStudioAdapter.test.ts test/unit/codexNativeConfigProjection.test.ts`
**Verify:** `npx vitest run test/unit/agentStudioAdapter.test.ts test/unit/codexNativeConfigProjection.test.ts`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood:dev-host -- headless`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** In the installed build, create a new canonical Codex, confirm the three families
default to Global, enable/start it, and verify `get_project_handoff` does not prompt when the global
approval policy is `never`.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `.tachyon/dev-host/interactive-out/canonical-native-policy.png`, reproduced by
  `scripts/dev-host/scenarios/t-f03ae5-canonical-native-policy.mjs`.
- [x] Verdict: all four assertions passed; the card rendered at 745/745 px, with readable in-flow rows
  clearly distinct from legacy harness configuration.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <449>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** existing Agent Studio is the operator surface; no new CLI or API is introduced.
