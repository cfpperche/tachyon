# 445 — bridge-idle-stream-attention — plan

_Drafted from `spec.md` on 2026-07-24. The approach, not the steps (those go in `tasks.md`)._

## Approach

Classify each Bridge HTTP request with a closed content-free kind. GET becomes an MCP
stream, DELETE a session operation, and a parsed `tools/call` POST a tool call.
Duration accounting remains unchanged. The warning policy admits only tool calls;
every other kind remains metric-only.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Closed request kind instead of inferring from missing tool** — absence of a tool
  currently conflates streams, initialization and malformed traffic.
- **Keep all durations in Bridge metrics** — transport lifetime remains useful health
  evidence even when it is not human-actionable.
- **Allow warnings only for proven tool calls** — unknown/non-tool traffic cannot
  honestly name an action for the human.

## Files touched

- `src/bridge/Bridge.ts` — classify the HTTP request in completion metadata.
- `src/workspace/bridgeSlowRequestPolicy.ts` — gate warnings on tool-call kind.
- `test/unit/bridge.test.ts` — prove GET/DELETE/tool classifications.
- `test/unit/bridgeSlowRequestPolicy.test.ts` — prove streams stay metric-only.

## Risks & unknowns

- A POST starts as protocol traffic and is promoted only after safe JSON parsing
  proves `tools/call`; malformed requests remain non-actionable.
- Existing tests constructing completion metadata explicitly state their kind,
  making future call-site omissions visible to TypeScript.

## Visual impact

No layout change. The visible proof is absence of false warnings; automated policy
tests are stronger than a screenshot for this timing defect.

## Sources consulted

- `.tachyon/reports/bridge-idle-stream-attention-spam-2026-07-24.md`
- `src/bridge/Bridge.ts`
- `src/workspace/bridgeSlowRequestPolicy.ts`
- `src/workspace/DaemonEngineHost.ts`
