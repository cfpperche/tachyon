# 469 — runtime-config-dropdown — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Replace only the runtime segmented control with `KitDropdown`.
- [x] Render canonical runtime icons in the trigger and every item.
- [x] Add scoped trigger/menu/item/focus/selected styles.
- [x] Add focused regression coverage.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Runtime selection still resets to the chosen runtime's first document.
- [x] Dropdown and icons are pinned by the focused test.
- [x] Typecheck and full repository verification pass.

**Headless check:** `npx vitest run test/unit/runtimeConfigDropdown.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Opening and operating this VS Code webview menu has no representative headless product route; use the rendered preview/Visual QA evidence below.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Install the local VSIX, open Control → Runtime Config, open the runtime dropdown,
switch Claude/Codex with mouse and keyboard, and confirm the document/editor follows the choice.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: The official `cockpit:runtime-config` preview route was captured but remains on
  `Loading runtime configuration…`; bug `t-80d367` records the missing snapshot injection.
- [x] Verdict: `unable_to_judge` in headless preview, not a visual failure. Human validation
  `v-45d903` is queued against the installed VSIX.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <469>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** This changes an existing selector and introduces no operator API or workflow.

**Verify:** `npx vitest run test/unit/runtimeConfigDropdown.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
