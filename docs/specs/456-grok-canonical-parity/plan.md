# 456 — grok-canonical-parity — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Establish the existing real launch boundary first: `Workspace` chooses `materializeBridgeMcpGrok` for
canonical profiles and the current AgentManager test already proves fresh/restart/resume exact trust,
Bridge config, auth and private-home reuse. Upgrade the profile isolation only with that evidence.
Measure the installed Grok 0.2.112 help and bundled user guide for permission modes, config sources,
and precedence. If there is no profile-authorized source/value, retain the explicit no-injection
contract rather than creating an implicit mode. Update the runtime matrix precisely and lock behavior
with focused tests.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Private `GROK_HOME` is the canonical isolation boundary** — it owns config, transcript state,
  Bridge config and exact trust on every lifecycle path; rejected retaining `project-scoped` because
  it contradicts the materializer and blocks parented canonical launches unnecessarily.
- **No generic permission default** — the CLI's mode list and docs prove support, not authority to select
  a mode. Rejected reusing ad-hoc `auto` or automation-only `bypassPermissions` for canonical agents.

## Files touched

- `src/runtime/runtimeProfile.ts` — correct Grok isolation evidence and permission notes.
- `test/unit/runtimeProfile.test.ts` — pin the profile contract and verified isolation behavior.
- `test/unit/agentManager.test.ts` — strengthen lifecycle state proof only if a real gap remains.
- `docs/runtimes/parity.md` — update marks solely from the measured/covered evidence.
- `docs/specs/456-grok-canonical-parity/*` — decision log and verification record.

## Risks & unknowns

- The CLI help may list Claude-compatible aliases that do not correspond to Grok's internal policy;
  retain only values/docs confirmed by the installed release.
- `[permission]` rules merge across sources with deny precedence. Do not project them without a typed
  source boundary and lifecycle test.

## Visual impact

No visual UI change.

## Sources consulted

- `src/workspace/Workspace.ts` canonical Grok materializer branch
- `src/harness/HarnessManager.ts` `materializeBridgeMcpGrok`
- `test/unit/agentManager.test.ts` canonical Grok lifecycle coverage
- installed `grok --help` and `~/.grok/docs/user-guide/05-configuration.md`, `22-permissions-and-safety.md`
- `docs/runtimes/parity.md`
