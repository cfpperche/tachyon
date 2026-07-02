# 326 — sdd-visual-qa-light-contract

_Created 2026-07-02._

**Status:** shipped
**Closure:** Shipped 2026-07-02 in the SDD skill/plugin. Added prose-based Visual QA discipline to `SKILL.md`, optional `Visual impact` / `Visual QA` prompts to templates, warning-only `visual-qa-missing` detection in `sdd-close.sh`, and focused regression script `test-visual-close.sh`. Verification and dogfood passed and are logged in `notes.md`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The SDD flow currently proves functional claims with `Verify` and `Dogfood`, but it does not explicitly make an
agent stop and look at UI changes before calling them done. That gap showed up in spec 324: tests passed, but
the first visual placement of Activity share controls was obviously poor once the user installed the VSIX.

Done means SDD carries a lightweight visual-review contract for any spec that changes what a human sees or
clicks. The contract must stay flexible: no fixed `UI impact` enum, no mandatory browser/Playwright tool, and no
hard close failure by default. It should nudge agents to declare the changed visual surface, think through visual
risks, and record visual proof before closing.

## Acceptance criteria

- [x] **Scenario: SDD guidance stays non-rigid**
  - **Given** a spec changes UI, layout, icons, menus, webviews, visible text, screenshots, or user interaction
  - **When** an agent drafts the plan and tasks
  - **Then** the SDD skill tells the agent to describe visual impact and expected visual proof in plain prose, not choose from a fixed enum
- [x] **Scenario: templates invite visual review without forcing it**
  - **Given** a new SDD spec is scaffolded
  - **When** the agent fills `plan.md` and `tasks.md`
  - **Then** the templates include optional visual-impact / Visual QA prompts that can be removed or marked not applicable for non-visual work
- [x] **Scenario: close warns, not blocks, missing visual proof**
  - **Given** a shipped spec appears to affect UI
  - **When** `sdd close` audits it and no visual evidence or visual opt-out is recorded
  - **Then** the script emits a warning without changing the exit code from success to failure by itself
- [x] **Scenario: visual proof remains tool-agnostic**
  - **Given** a visual spec was reviewed with screenshot, browser, preview, Visual QA, or human dogfood
  - **When** the evidence is recorded in `notes.md` or `tasks.md`
  - **Then** `sdd close` recognizes that visual proof exists without requiring one specific tool
- [x] Existing SDD verify/dogfood/close behavior is preserved for non-visual specs.

## Non-goals

- No mandatory Playwright/browser/Visual QA dependency.
- No fixed `UI impact: none | web | vscode-webview | native` enum.
- No hard close failure for visual evidence in this pass.
- No screenshot storage system or evidence attachment workflow.

## Open questions

- Should missing visual proof become a hard close finding later for specs that explicitly make visual quality an acceptance criterion? Deferred until the warning path has real usage.
