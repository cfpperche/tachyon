# 350 — studio-shell — tasks

_Generated 2026-07-04. PHASE 1 ONLY. Commit per task, ALWAYS by pathspec. No existing studio/store/bridge
files are touched in this phase._

## Implementation

- [x] T1 Shell types + pure modules: StudioMessage protocol (versioned union, domain registration,
  fail-closed unknowns + lint-test), error taxonomy, dirty/save gating, restore decisions — DOM-free +
  tests.
- [x] T2 StudioPanelManagerBase (host): lifecycle + adapter interface + panel restore + one dispatcher for
  the protocol; tests in the pinStudioPanel.test.ts style (fake webview).
- [x] T3 StudioFrame (webview): header/action slots/Cancel-Save, content regions, kit sections, error
  surfacing with shell-owned save gating, labels contract, CSP shell integration.
- [x] T4 Fake 1 — PipelineStudioAdapter (in-memory) + pipeline-studio surface (dev-flag entry) exercising
  the FULL lifecycle; esbuild entry; preview routes with ALL stateful scenarios.
- [x] T5 Fake 2 — Agent-entity fixture (quick-add chips, role select, instructions, worktree section as
  domain components in regions) — test + preview route only.
- [x] T6 AgentForm compatibility spike (read-only) — findings + needed-APIs list in notes.md.
- [x] T7 Adapter surface budget doc (shared/studio/README.md: hook categories, forbidden bypasses, import
  matrix pointer) + agent visual pass (both fakes, stateful scenarios) + full suite/typechecks.

## Verification

- [x] Protocol: unknown version/message fails closed; domain messages cannot shadow core names — T1 tests.
- [x] Lifecycle incl. restore (new/edit/dirty/failed-load across simulated reload) — T2 tests.
- [x] Save gating from error taxonomy (unknown = blocking; adapter cannot bypass) — T1/T3 tests.
- [x] Pipeline fake: every lifecycle scenario green — T4 tests.
- [x] Agent fixture renders dense domain components in regions — T5 test.
- [x] Full `npm test` + both typechecks green.

**Headless check:** `npm test -- --run test/unit/studioShell.test.ts test/unit/studioPanelBase.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/studioShell.test.ts test/unit/studioPanelBase.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/studioShell.test.ts -t "fail"`
<!-- Headless proxy: the fail-closed protocol/gating paths ARE the shell's contract. Surfaces are fakes by
     design in Phase 1 — the human-visible dogfood arrives with Phase 2 (Task Studio migration). -->

**Human dogfood:** Phase 1 has no user-visible surface (accepted at ratification). Optional eyeball: the
pipeline-studio preview route behind the dev flag, checking the chrome matches Task Studio's language.

## Visual QA

- [x] Evidence: agent-browser captures of the pipeline fake's 7 stateful scenarios (clean/dirty/validation-
  blocked/save-pending/stale-conflict/load-error/domain-action) + both agent fixture variants (default/new),
  captured 2026-07-04 against the dev preview harness (`npm run preview:webview`). Saved locally under
  `.tachyon/evidence/spec350/` (gitignored; not shipped, dev-only artifacts).
- [x] Verdict: PASS. Chrome is consistent across both fakes and matches the existing dark VS Code theme
  language (mono title, bordered `.ds-input` fields, right-aligned Cancel/Save) — the "one chrome" bar from
  plan.md's visual-pass note. All 7 pipeline states render distinctly and correctly (dirty dot, save-button
  gating, stale banner, load-error banner + taxonomy error list, domain-action result merged into fields).
  Region composition (fields/sideActions) holds up under the Agent fixture's dense field set. Two minor,
  non-blocking observations recorded for a future pass: (1) the stale-conflict banner has no visible Reload
  action (StudioFrame's `onReload` is optional; the pipeline fake doesn't wire one since it has no real CAS
  path) — fine for Phase 1, worth wiring when a real CAS studio migrates; (2) the load-error state shows a
  slightly redundant pair of messages (generic banner + specific error line) — cosmetic only.
