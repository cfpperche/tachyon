# 355 — adhoc-transcript-isolation — tasks

_Generated from `plan.md` on 2026-07-04. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Update ad-hoc AI spawn construction so Claude/Codex definitions default to `isolate: "transcript"`.
- [x] Preserve ownership-only hook behavior for ad-hoc agents after isolation is applied.
- [x] Update Activity shared-cwd warning logic to consider config-home isolation and valid ownership rows.
- [x] Add/update unit tests for ad-hoc Codex and Claude config-home isolation.
- [x] Add/update unit tests for Activity warning false-positive/true-positive cases.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Codex ad-hoc gets private `CODEX_HOME`, ownership-only hook, and ledger `resume.configHome`.
- [x] Claude ad-hoc gets private `CLAUDE_CONFIG_DIR`, ownership-only hook, and ledger `resume.configHome`.
- [x] Activity warning does not render when ownership/config-home isolation makes the transcript attributable.
- [x] Activity warning still renders for truly ambiguous shared `cwd + configHome` sessions without ownership.

**Headless check:** `npm test -- test/unit/agentManager.test.ts test/unit/activityView.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Headless tests cover the spawn and banner predicate; visible Activity confirmation requires the installed VS Code extension and human screenshot after VSIX install.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Install the VSIX, reload VS Code, spawn one ad-hoc Codex and one ad-hoc Claude from the same cwd as the parent, open each Activity panel, and confirm messages render without the `history unavailable` banner and without continuity/handoff pills.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [ ] Evidence: pending human screenshot after VSIX install.
- [ ] Verdict: pending.

**Verify:** `npm test -- test/unit/agentManager.test.ts test/unit/activityView.test.ts`
**Verify:** `npm run typecheck`
