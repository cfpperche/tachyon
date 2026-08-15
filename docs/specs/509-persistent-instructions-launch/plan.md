# 509 — persistent-instructions-launch — plan

_Drafted from `spec.md` on 2026-08-15. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add one pure runtime projector that returns the exact launch suffix for Claude/Codex/Grok and validates its byte representation. AgentManager calls it after the existing profile projection and before all spawn/restart mutation. Claude materializes the resolved text into a per-agent generated file; inline runtimes use shell-safe values. Keep startup-brief composition intact for compatibility in this slice, while making compact survival independent of it.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Common 131,000-byte source ceiling plus exact encoded-argument check** — chosen because it stays below every measured single-argument boundary and remains honest about the unmeasured semantic limit; rejected silent truncation and the raw 131,071 boundary because Codex serialization may expand.
- **Generated Claude file from resolved text** — chosen because projection already resolved and verified the profile pin; rejected re-reading `instructions.md` in AgentManager because that duplicates authority resolution.
- **Profile-owned only** — chosen because temporary role/task instructions are not persistent profile instructions; rejected applying the channel to every `AgentEntry.instructions` value.
- **No secrecy claim** — inline argv and runtime artifacts remain same-user-readable, as measured.

## Files touched

- `packages/engine/src/agents/persistentInstructionsLaunch.ts` — runtime projection, serialization and ceiling.
- `packages/engine/src/agents/AgentManager.ts` — materialize/apply projection on spawn and restart.
- `packages/engine/src/runtime/parity.ts` and `test/unit/runtimeParity.test.ts` — verifiable dimension.
- `test/unit/agentManager.test.ts` and a focused projector test — behavior and red paths.
- `docs/runtimes/parity.md` and the research document — human-visible capability, exposure and Claude `cannot`.

## Risks & unknowns

Shell quoting and TOML escaping can expand representations, so tests cover quotes, newlines and multibyte UTF-8. Resume launches a fresh runtime process around an existing session and therefore receives the same profile layer; this does not substitute for the evidence that the runtime layer itself survives compact. Fork behavior is preserved unless it carries canonical profile provenance.

## Visual impact

No graphical surface changes. Launch-refusal text is the only human-visible output.

_Prototypes and durable evidence are opt-in. When this spec needs them, keep them inside `docs/specs/509-persistent-instructions-launch/` (for example `prototypes/` or `evidence/`) unless a non-empty `**Artifact-Location-Opt-Out:** <reason>` documents why the artifact has a different owner._

## Sources consulted

- `docs/research/t-a68138-system-prompt-compact.md`
- `packages/engine/src/config/agentProfileProjection.ts`
- `packages/engine/src/agents/AgentManager.ts`
- `packages/engine/src/config/loadConfig.ts`
- `docs/specs/508-paridade-verificavel/`
