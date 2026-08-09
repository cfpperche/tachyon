# 307 — adhoc-nudge-policy

_Created 2026-06-30._

**Status:** shipped
**Closure:** Shipped local implementation on 2026-06-30. Automatic persistence nudges now use a single runtime-neutral Workspace policy: declared agents in `tachyon.yml` remain eligible; all ad-hoc rows, including fork/worktree ad-hoc rows, are default-off. Continuity restore/checkpoint and project-handoff automatic reminders are gated by that policy. The UI reinject-continuity command passes explicit UI origin so human manual reinjection still works for ad-hoc sessions, while generic/programmatic `transition:"manual"` calls no longer bypass suppression. Verification: `/sdd verify` passed (`npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`, `npm run typecheck`); `/sdd dogfood` passed (`npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`). Commit pending.
**Verify:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Bridge-spawned ad-hoc agents are currently eligible for the same automatic persistence nudges as durable agents. In practice this means a short-lived review/probe child can receive a proactive continuity reminder such as `[Tachyon] You have no continuity brief yet... set_continuity(...)`, even though the child was intentionally ephemeral and should not pollute the persistent handoff/continuity lane by default.

Done means Tachyon distinguishes automatic persistence nudges from explicit human/tool actions. Declared and durable work sessions keep their continuity and project-handoff nudges. Plain ad-hoc children are quiet by default across Codex, Claude, and future agent runtimes, while explicit manual reinjection and Bridge-authored continuity/handoff writes still work.

## Acceptance criteria

Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan.

- [x] **Scenario: ephemeral Codex child stays quiet**
  - **Given** an ad-hoc Codex agent spawned by another agent, not declared in `tachyon.yml`, with no fork/worktree durability and no continuity brief
  - **When** idle recovery or checkpoint reminder logic runs
  - **Then** Tachyon does not type a `set_continuity(...)` cold-start/stale reminder into that session.
- [x] **Scenario: ephemeral Claude child stays quiet**
  - **Given** an ad-hoc Claude agent spawned by another agent, not declared in `tachyon.yml`, with no fork/worktree durability and no continuity brief
  - **When** idle recovery or checkpoint reminder logic runs
  - **Then** Tachyon does not type a `set_continuity(...)` cold-start/stale reminder into that session.
- [x] **Scenario: ephemeral child does not receive project-handoff nag**
  - **Given** a plain ad-hoc AI child with recent activity and a stale or absent project handoff
  - **When** the automatic project-handoff reminder path runs
  - **Then** Tachyon does not type a project-handoff reminder into that session.
- [x] **Scenario: durable agents keep the existing behavior**
  - **Given** a declared Codex or Claude agent, or another durable Tachyon-owned agent session
  - **When** the existing continuity or handoff reminder thresholds are met
  - **Then** Tachyon still sends the same automatic nudges it sends today.
- [x] **Scenario: explicit UI actions remain explicit**
  - **Given** a plain ad-hoc AI child
  - **When** a human uses the manual reinject-continuity UI action, or a Bridge tool explicitly writes continuity/handoff content
  - **Then** Tachyon honors that explicit action; the new policy only suppresses proactive automatic reminders and non-UI manual reinject calls.
- [x] The policy is runtime-neutral: no branch keys on `"codex"` or `"claude"` except in tests that prove both current runtimes are covered.
- [x] The default for every ad-hoc session is off, including fork/worktree ad-hoc rows. Any future opt-in must be explicit and localized behind the same policy helper.

## Non-goals

- This spec does not remove Activity storage for ad-hoc sessions while the ad-hoc row exists.
- This spec does not change the Bridge tools that let an agent or user explicitly append project handoff notes or set continuity.
- This spec does not redesign role re-anchor behavior. Re-anchor may be revisited separately if ad-hoc role prompts should also be quiet by default.
- This spec does not add new public config/schema unless implementation proves a minimal internal hook is not enough.

## Open questions

- Answered by Claude plan review: no. Fork/worktree are isolation/durability mechanics, not user intent to receive automatic persistence nudges. V1 keeps every ad-hoc row default-off; a future opt-in must use an explicit policy field.
