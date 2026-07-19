# 414 — browser-user-companion — plan

_Deferred until design ratify of `spec.md` (2026-07-19 seed)._

## Approach

Not written yet. After the maintainer answers the open questions in `spec.md` (umbrella ownership,
MVP depth, external-client substrate, tool surface, multi-workspace), draft:

1. Pairing protocol against engine control / Bridge auth
2. Extension MV3 surface map (popup / side panel / optional content script limits)
3. Capture → Task/evidence pipeline
4. Approval projection + resolution path
5. Bridge tool shapes (`user_browser_*`) and skill packaging
6. Phased delivery tickets

## Key decisions

_Recorded as product proposals in `spec.md` concept brief; not locked as implementation plan._

## Files touched

_TBD at plan time (expected classes: engine pairing, Bridge tools, extension package repo or monorepo path, skill/docs)._

## Risks & unknowns

See `spec.md` security posture and open questions. Highest early risks: privacy scope of extension
permissions; permission-laundering if approval UI is treated as proof; conflation with agent-browser.

## Visual impact

v1 extension UI (popup + approval list). Visual QA will matter for popup density and approval copy;
not applicable until implementation phase.

## Sources consulted

- `docs/system-design.md` — engine/shell split; future shells as adapters
- `docs/specs/267-plugin-agent-browser/spec.md` (+ 268, 271) — agent-owned browser product
- `t-fe52f0` — companion/mobile umbrella (desktop Control landed; mobile open)
- Pin `p-2112a8` — human discussion seed
- Bridge approval model (`request_human_approval` / `get_approval_status`) — anti-laundering
- Spec 273/274 evidence channel — possible capture attachment path
