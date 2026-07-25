# 458 — parity-readiness — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Define the readiness contract, evidence sources, and UI placement.
- [x] Project stable readiness limitation codes from runtime profile and adapter capabilities.
- [x] Render localized readiness beside canonical lifecycle controls and provide a limited preview fixture.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Run focused Studio projection and shell tests.
- [x] Run configured typecheck and full verification.

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Headless check:** `npm run typecheck && npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The visual lifecycle surface requires browser capture; the provisioned browser launcher is unavailable in this worktree. Focused Studio tests were run as verification instead.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Open Agent Studio's canonical-disabled preview and confirm readiness appears before lifecycle buttons.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `npm run build` produced the Agent Studio preview bundle; browser capture was unavailable because the worktree lacks the provisioned agent-browser launcher (`BROWSER_RUNTIME_MISSING`).
- [x] Verdict: unable_to_judge — no visual pass is claimed; the narrow-layout CSS rule is covered by source review only.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <458>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** UI-only projection; no new operator workflow or API.
