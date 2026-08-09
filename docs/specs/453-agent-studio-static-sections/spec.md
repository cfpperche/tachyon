# 453 — agent-studio-static-sections

_Created 2026-07-25._

**Status:** shipped
**Closure:** New/Edit Agent configuration disclosures were replaced with accessible, always-expanded
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
static cards, with responsive narrow layout, regression tests, and visual evidence.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Replace the three configuration disclosures in New/Edit Agent—Persistent instructions, Git worktree
isolation, and runtime-conditional Isolated harness—with static in-flow sections. Their controls and
behavior remain unchanged while important configuration is always visible.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] Persistent instructions, Git worktree isolation, and applicable Isolated harness render as static
  titled sections without disclosure triangles or open state.
- [x] New and Edit preserve the existing conditional harness visibility and all field values.
- [x] Validation, dirty state, save/cancel, navigation, and serialization are unchanged.
- [x] Static sections provide a clear title, help/context, and always-visible controls.
- [x] Desktop and narrow visual evidence preserves hierarchy and introduces no overflow.
- [x] Regression coverage fails if any of the three configuration disclosures returns.

## Non-goals

- Redesigning Agent Evolution's per-file diff viewer.
- Changing runtime capability detection or form persistence.
- Adding sticky/floating UI or altering unrelated Studio surfaces.

## Open questions

None.
