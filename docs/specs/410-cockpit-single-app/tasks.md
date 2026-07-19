# 410 — cockpit-single-app — tasks

_From plan.md. Revised 2026-07-19 (fable P0s). Work phase-by-phase; one migration surface per PR._

## Phase A — Foundation

- [ ] STYLEGUIDE: two-app rule + link spec 410; no new editor `main.tsx` without `WEBVIEW_SURFACES` entry.
- [ ] Extend `WebviewSurface` in `src/webview/surfaces.ts` (editorHome / cockpitSectionId / retiredInFavorOf as needed) + update `webviewConvention.test.ts` — **no parallel inventory test file**.
- [ ] Section module interface + shell wrapper (`PageChrome` + page pad).
- [ ] **Implement lazy section `import()` loader in Phase A** (required before Phase B).
- [ ] Document/enforce eager `cockpit.js` **≤ 350 KB** through Phase B (assert or PR size note + fail policy).
- [ ] Harden section restore: exact S; unknown → `overview` + unit test.
- [ ] Map commands → `openCockpit({ section })` for native; leave standalone while `editorHome=standalone`.
- [ ] **Pilot = Approvals:** in-tree section body; single open path; drop dual `ApprovalPanel` route when ready; stop always-on approval.css co-load when section inactive.
- [ ] Pilot updates `WEBVIEW_SURFACES` (+ serializers) in the same PR.
- [ ] Visual QA pilot vs Fleet; Evidence/Verdict in `notes.md`.

## Phase B — Control-family (one PR each; each PR updates WEBVIEW_SURFACES + MIGRATED_VIEWS if paths move)

- [ ] Approvals complete (if not finished in A).
- [ ] Runtime Ops.
- [ ] Validations.
- [ ] Plugins.
- [ ] tmux inspector.
- [ ] Board (mission) shell.
- [ ] Overview/Engine/Fleet/Worktrees/Deliveries/Settings shell audit.

## Phase C — Multi-instance class

- [ ] Confirm hosting decision in plan (default **B: thin-host exception** for task detail / handoff / probes) with human if overriding.
- [ ] If B: document exceptions on `WEBVIEW_SURFACES`; share kit/shell; no fake “singleton section” migration.
- [ ] If A: design multi-instance cockpit sections before code.
- [ ] If C: product sign-off on losing N panels; then migrate.

## Phase D — Studios

- [ ] Lazy studio routes under cockpit; StudioFrame preserved.
- [ ] Migrate studios one PR at a time; WEBVIEW_SURFACES each time.

## Phase E — Cleanup

- [ ] Delete dead bundles; convention tests green.
- [ ] Optional cookbook via `sdd-cookbook.sh`.
- [ ] Closure line on spec when agreed tranche ships.

## Verification

- [ ] `webviewConvention.test.ts` green (primary guard).
- [ ] Kit / patterns tests green.
- [ ] Lazy loader present before first heavy Phase B merge.
- [ ] Pilot visual QA recorded.
- [ ] Eager cockpit.js size noted vs 350 KB budget.

**Verify:** `npm run typecheck && npx vitest run test/unit/webviewConvention.test.ts test/unit/webviewComponentKit.test.ts test/unit/uiPatterns.test.ts`

## Dogfood

**Dogfood-Opt-Out:** Foundation is structural until Approvals pilot lands end-to-end. Each migration PR should add headless or human path as it becomes meaningful.

**Human dogfood (foundation):** Control → Fleet baseline → Approvals pilot → same pad/title/button height; `Tachyon: Open Human Approvals` hits the same UI as the Control tab; sidebar still separate.

## Visual QA

Required for pilot and every migrated surface (shell vs Fleet).

- Risk: double pad, dual open paths, button overrides, co-load bleed, multi-instance regressions.
- Record `Evidence:` + `Verdict:` in notes or PR.

**Visual QA:** pending foundation pilot.
