# 455 — claude-canonical-parity — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

First prove the existing canonical home through the real AgentManager launch boundary across fresh,
restart and resume. Make the test mutate settings, skills, MCP, trust, and stale private-home state
between phases. Measure Claude 2.1.220 permission-mode values and the existing graceful-stop sequence
in a disposable TTY session. Only then decide whether a profile-native permission policy is safe; if it
is not, retain the workspace settings projection and document the canonical limitation honestly. Finally
exercise a Soul-enabled canonical Claude launch and update the matrix with precise evidence.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Do not reuse `--permission-mode auto` as canonical policy** — it is intentionally limited to
  ownership-only ad-hoc Claude spawns; rejected widening it to all canonical launches because that
  changes approval authority.
- **Use the real lifecycle boundary** — a direct HarnessManager unit cannot prove AgentManager invokes it
  on restart/resume; rejected separate per-phase helper tests as weaker than one launch-boundary test.
- **Keep Soul proof about delivery, not obedience** — rejected any assertion about provider consumption.

## Files touched

- `src/runtime/runtimeProfile.ts` — measured Claude stop/permission metadata when evidence supports it.
- `src/harness/HarnessManager.ts` and/or `src/agents/AgentManager.ts` — only if the lifecycle audit finds
  a real projection gap.
- `test/unit/agentManager.test.ts`, `test/unit/harness.test.ts`, and Soul lifecycle tests — lifecycle and
  authority regression coverage.
- `docs/runtimes/parity.md` — evidence-backed marks.
- `docs/specs/455-claude-canonical-parity/*` — contract and findings.

## Risks & unknowns

- Claude settings precedence can make a generated policy unexpectedly override or be overridden by a
  workspace setting; measure before projecting it.
- A TTY stop test must not use an account-mutating or billable prompt.
- Soul may be delivered through the startup argument while still not being visible in an inspectable
  transcript; record the offered channel rather than asserting consumption.

## Visual impact

No visual UI change is assumed. If profile readiness copy changes, add a separate Visual QA task.

## Sources consulted

- `src/workspace/Workspace.ts` canonical Claude materialization branch
- `src/harness/HarnessManager.ts` `materializeCanonicalClaudeHome`
- `src/agents/AgentManager.ts` `withSessionOwnership`
- `test/unit/harness.test.ts` canonical Claude fixtures
- `docs/runtimes/parity.md`
