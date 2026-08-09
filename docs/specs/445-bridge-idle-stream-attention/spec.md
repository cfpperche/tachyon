# 445 — bridge-idle-stream-attention

_Created 2026-07-24._

**Status:** shipped
**Closure:** t-8c6dd4 classifies Bridge requests and keeps non-tool MCP traffic metric-only; focused and full verification passed.
**Verify:** `npx vitest run test/unit/bridge.test.ts test/unit/bridgeSlowRequestPolicy.test.ts`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Idle MCP stream renewals currently look like hung Bridge tools and accumulate durable
Attention warnings overnight. Distinguish transport/session traffic from actionable
tool calls so healthy long-lived streams remain observable in metrics without paging
the human.

Affected Product Invariants: **none** — this corrects internal observability
classification without changing a registered product promise.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: idle MCP stream remains quiet**
  - **Given** an authenticated MCP GET stream held for at least five minutes
  - **When** it closes or reconnects
  - **Then** its duration remains measurable but no warning enters Attention
- [x] **Scenario: a genuinely slow tool remains visible**
  - **Given** an MCP `tools/call` request exceeding the extreme threshold
  - **When** it completes
  - **Then** one warning identifies its tool and caller
- [x] DELETE/session and non-tool protocol requests remain metric-only.
- [x] Request classification contains no body, arguments, token or other sensitive data.

## Non-goals

- Redesign the Notice Inbox or its 50-row presentation cap.
- Change MCP client keepalive/reconnect behavior.
- Suppress Bridge duration metrics.

## Open questions

None.
