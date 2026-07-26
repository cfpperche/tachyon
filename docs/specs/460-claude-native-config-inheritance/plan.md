# 460 — claude-native-config-inheritance — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

First inventory the current private-home materializer by family, then add Claude-specific support
decisions to the shared native-policy resolver. Replace whole-file merge behavior with a closed
allowlist parser and a forced final `autoMemoryEnabled: false` override. Treat settings, skills and
MCP as a single atomically refreshed generation where their references are coupled. Keep trust and
authentication external to authored policy; lifecycle tests prove the same generation on every path.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Key-level settings allowlist** — prevents a workspace settings file from transitively authoring
  hooks, permissions, environment, plugins or auth; rejected whole-file copying/merging because its
  runtime semantics and authority boundary drift with upstream.
- **Separate requested and runtime-owned planes** — trust, bootstrap, credentials and memory retain
  their existing governed paths; rejected treating private-home state as canonical profile input.
- **Atomic coupled generation** — settings, skills and strict MCP must refresh together; rejected
  independent refresh because references could point to stale or absent capability content.

## Files touched

- `src/config/agentNativeConfigPolicy.ts` — Claude support tuples and validation.
- `src/config/agentProfileProjection.ts` — profile policy attestation/projection boundary.
- `src/harness/HarnessManager.ts` — closed Claude settings/capability materialization.
- `src/workspace/Workspace.ts` — pass canonical projection through all lifecycle paths.
- `src/webview/agent-studio-shell/*` — only if the supported policy becomes authorable in Studio.
- `test/unit/{harness,agentManager,agentNativeConfigPolicy}.test.ts` — parser, lifecycle and
  non-inheritance regressions.
- `docs/runtimes/parity.md` — measured matrix evidence.

## Risks & unknowns

- Upstream Claude setting semantics can change; do not reimplement undocumented merge behavior.
- Workspace skills/MCP can carry executable authority; validate source containment and preserve the
  existing strict MCP path.
- The exact trust grant must not be mistaken for policy inheritance.

## Visual impact

If Studio gains Claude family controls, inspect the real form and record evidence. Otherwise this is a
private runtime projection with no rendered change.

## Sources consulted

- `docs/architecture/agent-native-config-inheritance.md`
- `docs/specs/441-native-config-policy-foundation/`
- `src/harness/HarnessManager.ts`
- `src/config/{agentNativeConfigPolicy,agentProfileProjection}.ts`
- Claude Opus 5 adversarial review artifact: `.tachyon/probes/probe-6b278b37-158e-4e8c-8105-5afa6b17fbd4/result.json`
