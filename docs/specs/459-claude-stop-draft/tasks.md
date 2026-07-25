# 459 — claude-stop-draft — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Measure draft clearing and exit in a real no-prompt Claude 2.1.220 TTY.
- [x] Add conditional local-text graceful-stop support and update Claude's sequence.
- [x] Cover draft and active-pattern emitted input in unit tests.
- [x] Measure one authorized active Claude turn using Escape, Ctrl+C, and `/exit`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Run focused AgentManager and runtime-profile tests.
- [x] Run configured typecheck and full verification.

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Headless check:** `npx vitest run test/unit/agentManager.test.ts test/unit/runtimeProfile.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** In an authorized Claude Code 2.1.220 session, submit one no-tools prompt, apply Escape,
Ctrl+C, then `/exit`, and verify the pane exits with status 0.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Start Claude without submitting a prompt, type a draft, invoke Stop, and verify the
draft clears then `/exit` closes the pane.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: Real Claude Code 2.1.220 TTY: Ctrl+C cleared a draft; Ctrl+D retries left the pane
  alive; `/exit` ended it cleanly without a model prompt.
- [x] Evidence: Authorized Claude Code 2.1.220 active turn stopped by Escape, Ctrl+C, then `/exit`;
  tmux reported `Pane is dead (status 0)`.
- [x] Verdict: draft and active-turn graceful stop verified.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <459>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** Internal runtime lifecycle behavior; no new operator surface.
