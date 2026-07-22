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
- [x] C.0 Router: `CockpitRoute` discriminated union + navEpoch staleness guard + persisted revive (schemaVersion 2) + revive precedence. Design hardened in an adversarial dueto first (probe-840f7a80, 16 findings). Commit eeb28089.
- [x] C.1a Task Detail subroute: `mission/task/<id>` navigates in place inside Control (tombstone contract + CAS updates ported verbatim); retire TaskDetailPanel host. Commit 19199b4a.
- [ ] C.1b Task Studio subroutes (`mission/task/new`, `mission/task/<id>/edit`): design DONE (studios-routes-design.md, 2 duetos 2026-07-21); lands as Phase D PR **D2**; retire TaskStudioPanel host when it lands.
- [x] C.2 Fleet subroutes: `fleet/agent/<name>/activity` (Activity), `fleet/agent/<name>/probes` + `fleet/probes` unfiltered debug route (Probes); retire ActivityPanel + ProbeResultPanel hosts. Design hardened in an adversarial dueto first (probe-2d90286d, REDESIGN verdict, binding-generation + envelope-identity guard added). Commit 937f3701.
- [x] C.3 Handoff section: folds directly into a `"handoff"` CockpitSectionId (workspace-scoped like Approvals/Validations, no new route kind — no immutable per-entity locator unlike Fleet's subroutes); retire HandoffPanel host. Also fixed a coverage gap found in the same PR: `src/webview/cockpit/**/*.tsx` was never typechecked by any tsconfig. Commit 985708bb.
- [ ] C.4 Pin Studio nav-less route; retire PinStudioPanel host. Regrouped with C.1b + Phase D (maintainer decision, 2026-07-21); design DONE (studios-routes-design.md); lands as Phase D PR **D3**.
- [x] Standing exceptions approved: plugin surfaces stay out (security isolation); dev-only spec-350 fakes stay.

## Phase D — Studios (design hardened 2026-07-21 — see studios-routes-design.md)

_Two adversarial duetos (probe-ad112b99 REDESIGN 15 findings → v2; probe-393d5244 REDESIGN 8
protocol-completeness findings → v3). Product sign-offs recorded: draft policy = 3-option dialog
(Save / Leave and keep draft / Discard) + bounded host cache; CSP acceptance deferred to D2/D3
landing gates with security probes._

- [x] D0: router kinds (studio-new/studio-edit + StudioId) + STUDIO_REGISTRY + StudioRouteHost + nav-transaction FSM + mount handshake + revisioned persistence + draft cache + Command Studio pilot; retire CommandStudioPanel. DoD includes a design-conformance probe on the real FSM code. Landed `3aa19029` (2026-07-21); implemented inline (Fable, maintainer-authorized exception) with 6 adversarial probe rounds (2 design + 4 code) before landing.
- [x] D1a: Terminal + Runbook + Schedule Studio (shared shape, reuses D0's FSM as-is + a new
      generic `refreshStudioReferenceData` push for Runbook/Schedule's live command/agent catalogs);
      retired the 3 hosts. Split from D1 in-flight (2026-07-21): Agent Studio's evolution/soul-profile
      domain messages are ~5x the size of the other three combined — bundling it into the same PR
      mixed risk profiles for no reason, so it moved to its own D1b. Landed `ac87346e` (2026-07-21);
      implemented inline (Fable, maintainer-authorized exception re-confirmed for D1-D3) with 2
      adversarial probe rounds; round 1 caught a real cross-studio state-residue crash (a stale
      `studioIncoming` message from the PREVIOUS studio landing in a freshly-mounted DIFFERENT
      studio) + a missing Terminal `referenceData` handler, both fixed; round 2 verified the fix
      against studioHost.ts's actual binding-teardown ordering (no late-message race).
- [x] D1b: Agent Studio (soul profile + evolution candidates messaging); retired AgentStudioPanel.
      Landed `9d3bd256` (2026-07-21); implemented inline (Fable, maintainer-authorized exception)
      with 2 adversarial probe rounds. Required one deliberate extension to the shared mechanism:
      `StudioMessageHooks.handleDomainMessage`'s ctx now also carries the binding's `entityId`
      (studioHost.ts), threaded through so soul/evolution actions (each carrying their own `agent`
      field) can be validated against the bound entity, mirroring the retired panel's guard. Round 1
      found + fixed 2 real bugs: a lazy CSS load-order bug (Agent Studio's Tailwind sheet requested
      AFTER studio-frame.css on an in-session navigation into Agent Studio, reversing the cascade vs
      a direct deep-link) and confirmed-safe-but-worth-documenting: `binding.entityId` never updates
      after a successful `studio-new` save, so soul/evolution actions stay unavailable for a
      just-created agent until the user navigates away and back — a real UX gap (not a correctness
      bug: the client's own entity state also never refreshes post-save, so host and client agree)
      pre-existing since D0 but only made visible by Agent Studio's post-save domain actions; kept as
      a documented known limitation (studioHost.ts) rather than the larger `StudioSaveResult`
      interface change it would need — see D1d below.
- [x] D1c: Fleet agent rows gained a "Probes" and an "Edit" (Agent/Terminal Studio) button — mirrors
      the existing fleetActivity fallback-resolve-then-requestNavigate pattern exactly (dirty-form
      checkpoint gate included). "Edit" is kind-routed the same way the sidebar's
      `tachyon.editAgentStudioItem` already dispatches, hidden for ad-hoc (undeclared) rows and
      re-checked authoritatively host-side. Landed `421b0f81` (2026-07-22); 1 adversarial probe round
      caught a real bug (`ws.config?.agents[c.name]` read by plain index — a webview-message `name`
      of "constructor"/"__proto__"/"toString" would resolve an inherited Object.prototype property
      instead of `undefined`, slipping past the "not declared" guard; fixed with `Object.hasOwn`).
- [x] D1d: `StudioSaveResult`'s "ok" case now optionally carries the newly-persisted entity's id
      (`entityId?: string`, adapter.ts), threaded through `mapStudioSubmitResult` and all 5
      `*StudioAdapter.save()` calls via `patch.name`. `beginStudioSave` (studioHost.ts) adopts it into
      the binding (`b.entityId`, `b.mode` → "edit") and re-runs `sendStudioLoad` on success, so a
      `studio-new` form no longer stays stuck in "new" mode after a real save — closes the D1b-found
      gap (soul/evolution actions in Agent Studio are post-save follow-ups gated on a named entity).
      Landed `27d1af96` (2026-07-22); 1 adversarial probe round (2 false positives traced to
      incomplete pasted diff context — a pre-existing `binding !== b` guard already covers the
      claimed race; 3 real findings fixed/documented: an empty-string entityId silently dropped by a
      truthy check, a documented known-limitation note on `b.route` staying `studio-new` post-adopt
      (draft-cache/dedup identity split — checkpoint flow still protects against silent loss, just
      caches under the wrong slot), and a doc-comment on the `patch.name`-as-persisted-key invariant).
      Also fixed 2 unrelated pre-existing typecheck breaks discovered blocking this landing on main
      (companion LAN/pair-QR work from other agents, `129c7a9b`) — not part of D1d's scope.
- [ ] D2: Task Studio (CAS/rich-doc/visuals, task-edit→task-detail chain) + CSP tranche 1 + security probe; retires TaskStudioPanel (closes C.1b).
- [ ] D3: Pin Studio (Excalidraw, attachment roots, nav-less returnRoute) + CSP tranche 2 + security probe; retires PinStudioPanel (closes C.4).

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
