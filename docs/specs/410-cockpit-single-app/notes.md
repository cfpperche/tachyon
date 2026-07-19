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

- Pending: Claude agent **fable** adversarial review of this spec (requested 2026-07-18).

## Open threads

- Pilot surface pick at implementation kickoff.
- Thin-host vs single-panel-only intermediate strategy.
