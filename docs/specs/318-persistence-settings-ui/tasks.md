# 318 — persistence-settings-ui — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Draft plan.md after diagnostics/control integration is clear.
- [x] Add pure YAML mutation for `settings.persistence.silentHooks`.
- [x] Register a host command that shows the current effective mode and writes the workspace config.
- [x] Add sidebar affordances: header action and hook-health badge routing.
- [x] Explicitly defer per-agent override in the spec/plan.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit tests cover YAML preservation and canonical re-enable.
- [x] Typecheck passes.

**Headless check:** `npm test -- test/unit/yamlEditor.test.ts && npm run typecheck`
**Verify:** `npm test -- test/unit/yamlEditor.test.ts`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** QuickPick/sidebar click behavior needs the installed VS Code extension; headless coverage verifies the canonical config mutation and type wiring. Human dogfood should open Agents, click "Persistence hooks settings", switch modes, and inspect `tachyon.yml`.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** In VS Code, open Tachyon sidebar > Agents, click the Persistence hooks settings gear, choose "Visible legacy reminders", confirm `tachyon.yml` contains `settings.persistence.silentHooks: false`, then choose "Silent persistence hooks" and confirm the override is removed.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
