# 410 — cockpit-single-app — notes

_In-flight memory. Empty of implementation log until build starts._

## Baseline inventory (2026-07-18)

- **23** `App.tsx` under `src/webview/`.
- **24** `main.tsx` (includes `plugin-host`, `ui-gate`).
- Control already embeds several product CSS/JS graphs via `cockpit.css` co-load — migration
  should **collapse** co-load into in-tree imports, not add a third path.

## Decisions during authoring

- Spec id **410** via `sdd new cockpit-single-app` (empty `409-cockpit-single-app` dir removed if present).
- Plugin runtime multi-compat is an **explicit non-goal** (parallel human workstream).
- Hermes does not load Tachyon SDD as a native Hermes skill; use `.tachyon/plugins/sdd` scripts.

## Review

- Done: Claude agent **fable** adversarial review of this spec (2026-07-18).
  Verdict: **ACCEPT-WITH-CHANGES**. See `docs/reviews/cockpit-single-app-410-fable.md`.
  P0s: (1) Phase A's proposed main.tsx guard collides with the existing, fully-enforcing
  spec-279 `WEBVIEW_SURFACES` manifest (`src/webview/surfaces.ts` +
  `test/unit/webviewConvention.test.ts`) — must extend it, not fork a third source of truth.
  (2) Phase C targets (Task detail, Handoff, Probes) are multi-instance panels today; cockpit
  is a singleton — needs an explicit hosting design before Phase C starts. (3) spec.md asked
  the plan for a bundle-size budget; plan.md never gave a number — cockpit.js is 244KB today
  vs. activity.js 648KB / task-detail.js 644KB / handoff.js 640KB as Phase C targets.

## Open threads

- Pilot surface pick at implementation kickoff.
- Thin-host vs single-panel-only intermediate strategy.

## Review dispatch

- 2026-07-18: spawned agent `fable` (claude) parent=hermes for adversarial review → `docs/reviews/cockpit-single-app-410-fable.md`.
- Board: t-7315ad

## Fable review (2026-07-19)

- Deliverable: `docs/reviews/cockpit-single-app-410-fable.md`
- Verdict: **ACCEPT-WITH-CHANGES**
- P0 folded into spec/plan/tasks:
  1. Guard = extend `WEBVIEW_SURFACES` (279) + `webviewConvention.test.ts` — not a new inventory test
  2. Multi-instance (task/handoff/probes): default **thin-host exception (B)** before Phase C
  3. Bundle: lazy loader in Phase A; eager cockpit.js **≤ 350 KB** through Phase B
- P1 folded: pilot = **Approvals**; dual open path baseline; CSS co-load gate; Verify includes convention test; MIGRATED_VIEWS on delete
- Intent reframed: architecture/runtime unification, not re-doing STYLEGUIDE chrome checklist

## Pilot

Approvals — dual `tachyon.openApprovals` vs cockpit section is the proof target.

## Phase A implementation (2026-07-19)

- `WEBVIEW_SURFACES.editorHome` + `cockpitSectionId` (Approvals = legacy-redirect → approvals).
- Multi-instance tagged `standalone-multi` (activity/handoff/probes/task-detail).
- `resolveCockpitSection` + unit tests; unknown → overview.
- Cockpit build: ESM + splitting (`dist/webview/cockpit.js` ~22KB eager; section chunks under `dist/webview/chunks/`).
- Lazy section bodies via `preact/compat` lazy+Suspense for mission/approvals/validations/runtime/tmux/plugins.
- `tachyon.openApprovals` → `openCockpit({ section: "approvals" })`; ApprovalPanelManager redirects only.
- RuntimeOpsView dispose-only serializer (no bottom bar).
- Bundle budget test: eager cockpit.js ≤ 350KB when dist present.
- STYLEGUIDE: two-app rule.

**Eager size after Phase A build:** ~22015 bytes cockpit.js.
