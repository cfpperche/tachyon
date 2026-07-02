# 326 — sdd-visual-qa-light-contract — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Update SDD skill guidance with a visual-review discipline for UI/interface changes.
- [x] Add optional `Visual impact` prose prompt to the plan template.
- [x] Add optional `Visual QA` evidence prompt and opt-out convention to the tasks template.
- [x] Extend `sdd-close.sh` with warning-only detection for likely visual shipped specs lacking evidence.
- [x] Add/record focused verification fixtures for clean, warning, opt-out, and JSON output paths.
- [x] Update this spec's acceptance boxes and closure evidence.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] SDD guidance tells agents to perform visual review for UI/interface changes without requiring a fixed enum.
- [x] Templates include optional visual prompts that remain prose-based.
- [x] `sdd-close.sh` warns but exits 0 for a shipped visual spec with otherwise clean closure and missing visual proof.
- [x] `sdd-close.sh --json` reports visual warnings under `warnings`, not `findings`.
- [x] A shipped visual spec with `Visual QA` evidence or `Visual QA Opt-Out` does not warn.
- [x] Existing close checks still fail on real findings.

**Verify:** `bash /home/goat/tachyon-plugins/sdd/skills/sdd/scripts/test-visual-close.sh && bash /home/goat/tachyon-plugins/sdd/skills/sdd/scripts/sdd-close.sh docs/specs/326-sdd-visual-qa-light-contract --json`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `bash /home/goat/tachyon-plugins/sdd/skills/sdd/scripts/sdd-close.sh docs/specs/326-sdd-visual-qa-light-contract --json`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Use the updated SDD templates on the next UI-facing spec and confirm the agent records visual proof before delivery.

**Visual QA Opt-Out:** This spec changes SDD documentation/templates/scripts, not a product UI surface; the representative proof is the close-script fixture plus template review.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
