# 410 — cockpit-single-app — tasks

_From plan.md. Revised 2026-07-19 (fable P0s). Work phase-by-phase; one migration surface per PR._

## Phase A — Foundation

_Status 2026-07-19: foundation + Approvals single-path + lazy ESM shipped in code; human Visual QA still pending._


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

**COMPLETE 2026-07-21** — all seven landed (t-610705 journal has per-item evidence/commits).

- [x] Approvals complete (CSS co-load pilot).
- [x] Runtime Ops (co-load; dead RuntimeOpsView removed, t-ed3067).
- [x] Validations.
- [x] Plugins (co-load + standalone retirement, t-d23f93, after the shell workspace selector t-d16a39).
- [x] tmux inspector (co-load + standalone retirement).
- [x] Board (mission) shell (co-load + standalone retirement; bounded liveness ported to src/cockpit/missionVm.ts).
- [x] Overview/Engine/Fleet/Worktrees/Deliveries/Settings shell audit (ck-pill→Badge, token geometry, EngineLogPanel kit adoption).

## Phase C — Subroutes (supersedes the multi-instance plan — maintainer mandate, 2026-07-21)

- [x] Mandate recorded: ALL screens open inside Control as subroutes; multi-instance exception revoked; side-by-side knowingly traded (maintainer, 2026-07-21, t-610705 journal).
- [ ] C.0 Router: `{section, subroute, params}` + persisted revive + deep links (`openCockpit({route})`, `tachyon.*` commands become redirects) + breadcrumb/back in shell chrome. Design hardened in an adversarial dueto first.
- [ ] C.1 Board subroutes: `mission/task/<id>` (Task Detail), `mission/task/new` + `mission/task/<id>/edit` (Task Studio); retire TaskDetailPanel + TaskStudioPanel hosts.
- [ ] C.2 Fleet subroutes: `fleet/agent/<name>/activity` (Activity), `fleet/agent/<name>/probes` (Probes); retire ActivityPanel + ProbeResultPanel hosts.
- [ ] C.3 Handoff section; retire HandoffPanel host.
- [ ] C.4 Pin Studio nav-less route; retire PinStudioPanel host.
- [x] Standing exceptions approved: plugin surfaces stay out (security isolation); dev-only spec-350 fakes stay.

## Phase D — Studios

- [ ] The 5 studio shells become routes on the Phase C router; StudioFrame preserved.
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
