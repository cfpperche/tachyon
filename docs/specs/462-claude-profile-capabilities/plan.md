# 462 — claude-profile-capabilities — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Extend the authority and resolver discriminants to admit Claude and a skill grant. Keep Codex's
existing skill behavior stable, while Claude requires exact grants for skills, hooks and MCP. Parse
hooks with the Claude adapter rather than Codex's rules. Add a combined Claude profile materializer
that writes closed settings plus captured hooks, replaces the captured skill tree, emits strict MCP
from captured servers plus Bridge, resolves only referenced secret env names, and publishes the
capability manifest last. Route Workspace through that materializer for canonical Claude launches.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Claude-specific hook validation** — shared hook shape, but Claude's accepted events and `statusMessage` semantics differ from Codex.
- **Skill grants required only for Claude in this slice** — meets the new authority contract without retroactively invalidating existing Codex profiles.
- **Manifest-last generation marker** — stale manifest is removed before mutation and restored only after settings, skills and MCP are complete.
- **Bridge is reserved and host-custodied** — selected MCP cannot claim `tachyon` or `tachyon_bridge`; the runtime file adds the current Bridge separately.

## Files touched

- `src/config/{agentProfileAuthority,agentProfileResolver}.ts` — Claude grants and projection.
- `src/config/agentProfileProjection.ts` — inspector contract and attestation.
- `src/harness/HarnessManager.ts` and `src/workspace/Workspace.ts` — combined materialization.
- `test/unit/{agentProfileResolver,agentProfileConfigLoader,harness,agentManager}.test.ts` — authority, invalid input and lifecycle evidence.
- `docs/runtimes/parity.md` — measured matrix.

## Risks & unknowns

- Partial filesystem mutation on failure — remove the manifest before writes, use atomic file/tree replacement, and publish the manifest last.
- Runtime-specific hook drift — use the existing Claude hook parser's closed event set.
- Credential leakage through MCP — declarations retain `${VAR}` references; only referenced values enter the process environment.

## Visual impact

No rendered surface changes; Agent Studio already represents selected capabilities generically.

## Sources consulted

- `docs/specs/460-claude-native-config-inheritance/`
- `src/config/agentProfileResolver.ts`
- `src/plugins/adapters/{claude,codex,hooks}.ts`
- `src/harness/HarnessManager.ts`
- `src/workspace/Workspace.ts`
