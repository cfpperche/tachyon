# 485 — standalone-section-apps — tasks

_Generated from `plan.md` on 2026-08-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

Phases A and B move no surface and must land first. Everything from C on is one PR per surface, with
maintainer visual sign-off before release (convention agreed 2026-08-02).

## Implementation

### Phase A — conformance contract

- [x] A1. Add `posture` (`conform` | `extend` | `replace`) to each entry in `WEBVIEW_SURFACES`, with
      `extend` naming the extension points used and `replace` requiring a non-empty reason. Carry
      410's standing exceptions forward as explicit entries (sidebar, pin-preview, dev-only spec-350
      fakes, plugin surfaces) — none survives implicitly.
- [x] A2. Give the shared shell named extension points (regions/slots) so `extend` is a real posture
      and not a euphemism for `replace`.
- [x] A3. Convert at least one existing surface to `extend` through those points. If every surface
      lands on `conform`, the points are decorative — say so in `notes.md` and fix before A closes.
- [x] A4. Generalize `webviewConvention.test.ts`: an **undeclared** departure fails and names the
      surface — own page chrome, own pad/token values, mounting outside the shared shell. A declared
      `replace` passes; an empty reason fails.
- [x] A5. Fail-before proof for A4: a scratch surface that bypasses the shell makes the test red, and
      declaring it turns it green. Record in `notes.md`; do not commit the scratch surface.

### Phase B — visibility gating

- [x] B1. Add view-state observation to the panel manager layer (`onDidChangeViewState` appears
      nowhere in the repo today). A hidden panel runs no refresh, no collection, no subscriber
      callback, and posts no model.
- [x] B2. Catch-up on reveal: journal delta where the window covers it, full resync where it does
      not. A revealed panel is never stale.
- [x] B3. Guard by counting WORK, not wall time: with N panels open and one visible, a
      `views-changed` produces refresh work for the visible panel only.
- [x] B4. Apply to the panels that exist today (`AgentPanePanel`, Control) and measure the before/
      after the same way t-b51923 did — journal events per second with two agents running.

### Phase C — generic manager + the two motivating apps

- [x] C1. `SectionPanelManager`: configured from the manifest entry, keyed by
      `viewId + project + identity`, cardinality as a **parameter** (dashboard = one per section per
      project; document = one per identity). Creates through the shared shell; persists the minimum
      state `registerTrustedPanelSerializer` needs.
- [x] C2. Multi-entry build: one entrypoint per app in a single esbuild invocation with
      `splitting: true`; Preact and the kit extracted to shared chunks, per-app bootstrap, error
      boundary and CSS.
- [x] C3. Replace `cockpitBundleBudget.test.ts` with a manifest-driven successor measuring each app's
      eager entry and the reachable total. Record the new numbers in `notes.md` against 410's
      baseline (~244 KB, gate 350 KB) so a future reader can see whether this reversal cost size.
- [x] C4. **Task detail as a document app** — multi-instance, identity fixed at open. Two task
      details from different projects open side by side and stay distinct.
- [x] C5. **Board as a dashboard app** — one panel per project, revealed rather than duplicated.
- [ ] C6. Move the project selector into the sidebar Control tab header row (the slot the Agents tab
      uses for `All · N`), with the host keeping a single writer. Re-anchor
      `controlWorkspaceScope.test.ts` in the same change.
- [ ] C7. Guard the identity rule: switching the selector does not retarget an open document.
- [ ] C8. Launcher tiles and `tachyon.*` commands open/reveal these two apps; their old Control
      routes become redirects with no dead path left behind.
- [ ] **CHECKPOINT — stop and use it.** Board beside a terminal, two task details side by side, for a
      few days. If side-by-side is not what the use wanted, the remaining ten are untouched and the
      spec's `Done` narrows here. _Strike this only on the maintainer's word — it is insurance, not
      a technical requirement._

### Phase D — the remaining ten dashboards

- [ ] D1–D10. One PR per section (Overview, Engine, Fleet, Inbox, Worktrees, Execution, Runtime Ops,
      Runtime Config, tmux, Plugins, Settings — minus any already moved). Each PR: app lands,
      launcher + commands point at it, old restore state and deep links redirect, that section's
      renderer leaves `cockpit/App.tsx`. A shim with no UI may survive; two live renderers may not.
- [ ] D11. Decide the Overview JUMP card — survives, mirrors the launcher, or goes. It is a second
      navigation surface left open deliberately by t-aa2780.
- [ ] D12. Exercise restore with all apps open across editor groups, then reload. Spec 361's
      machinery has never been tested at this count.

### Phase E — remove Control

- [ ] E1. Remove the internal router, `navEpoch`, the singleton claim (`cockpitSingleton.ts`), the
      subroute breadcrumb chrome, `Cockpit.ts` and the cockpit entry.
- [ ] E2. Record the supersession in `docs/specs/410-cockpit-single-app/spec.md` so a reader finds
      the reversal from either direction, and set this spec's `**Closure:**` line.

## Verification

_Each maps to a checkbox in `spec.md` § Acceptance criteria._

- [ ] An undeclared departure from shell or design system fails the build and names the surface (A4).
- [ ] `extend` passes with no exception entry; `replace` passes only with a non-empty reason (A1, A4).
- [ ] At least one real surface uses `extend` (A3).
- [x] Hidden apps do no refresh work; revealed apps are current, never stale (B1–B3).
- [ ] Board and a terminal, and two task details, are visible and live simultaneously (C4, C5).
- [ ] Switching the project selector does not rewrite an open document (C7).
- [ ] The selector exists exactly once, in the sidebar Control tab header (C6).
- [ ] Reload restores every open app to its tab and state (D12).
- [ ] Every `tachyon.*` command and deep link lands on an app, with no dead redirect (C8, D1–D10).
- [ ] One app failing to render leaves the others working (C2 — per-app error boundary).
- [ ] Control's single-app machinery is gone (E1).
- [ ] 410 records that its app-count decision was superseded (E2).

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** the delivered behaviour is two editor tabs visible at once with live content and
a project selector that does not rewrite open documents — none of it observable headlessly. The
mechanical half is covered by `**Verify:**` (conformance contract, hidden-app work count, identity
rule, restore); the human half is the checkpoint below, which is the point of the spec.

**Human dogfood:**
1. Open the Board and an agent terminal in a split editor. Both live at once.
2. Open two task details side by side. Both stay their own task.
3. With a second project open, switch the selector in the sidebar Control tab header. Already-open
   documents keep their project; newly opened ones follow the selector.
4. Reload the window. Everything comes back to its tab.
5. Hide an app behind another tab, change something it shows, bring it forward. It is current.

## Visual QA

Every phase from C on changes a visible surface. Per the convention agreed with the maintainer on
2026-08-02, each surface PR captures preview screenshots (`npm run preview:webview` + agent-browser)
and the maintainer sees them **before** the release — validation is part of `done`, not polish.

Two findings already justify the cost, neither catchable by a test: a 1px border that made the
launcher grid read as a grafted widget (t-6e2952), and an Overview action row that clips at 360px
(t-89ecfe).

- [x] **Evidence (C4, 2026-08-03):** 4 fixtures x 2 widths (880, 360) of the REAL shipped
      `dist/webview/task-detail.js`, captured through the route this change adds —
      `npm run preview:webview` +
      `?view=task-detail&fixture=<default|heavy|sparse|tombstone>[&width=360]`. Attached via
      `attach_evidence` on `fase485c4` (`.tachyon/evidence/t-40e408/`, not committed: `docs/` holds
      durable documentation, not generated images — the ROUTE is committed, so any of the eight
      re-takes in one command). Anchor, written from the task's problem statement before the surface
      was built: *the task detail must render in its own tab exactly as it rendered as a Control
      subroute — same reading column, field rhythm, tombstone banner and middle-truncated refs —
      because this phase moves WHERE it renders, not HOW it looks.*
- [x] **Verdict (C4):** satisfies the anchor. At 880 the reading column fills the frame with the page
      pad and long refs truncate in the middle; at 360 the action row wraps BELOW the title (t-89ecfe's
      failure mode does not recur), the fields card stacks, and the attention callout wraps as prose.
      No horizontal overflow at either width on any fixture. One intended difference: no "← Board"
      breadcrumb — it existed to get back INSIDE Control, and a tab is closed rather than navigated out
      of. One defect found and deliberately NOT fixed here because it is PRE-EXISTING: an empty body
      renders `BODYno body` on one line (`.ds-section` is an inline span whose `margin-bottom` cannot
      make vertical space, and `.td-body` — unlike `.td-journal` — is not a flex column). `App.tsx` and
      `task-detail.css` are byte-identical across C4 and neither Control-only sheet touches those
      rules, so Control renders it the same way today. Filed as **t-fe8ba3**.
- [x] **Evidence (C5, 2026-08-03):** the Board at 880 and 360, captured through the route this change
      adds — `npm run preview:webview` + `?view=mission-control&fixture=default`, rendering the REAL
      shipped `dist/webview/mission-control.js`. Screenshots under `.tachyon/vqa/485-c5/` (gitignored
      work evidence, the same call C1–C3 and C4 made — `docs/` holds durable documentation, not generated
      images; the ROUTE is committed, so either width is one command to re-take) and attached via
      `attach_evidence` on `fase485c5` (`ev-2026-08-03T15:05:38.916Z-1`). Anchor, written from the task's
      problem statement before the surface was built: *the Board must arrive as a first-class editor tab
      showing the SAME work queue it showed inside Control — nothing gained and nothing lost by the move:
      the toolbar on one row at 880, the columns and cards below it, page padding that is the board's own
      rather than doubled or absent where Control's shell used to be; and at 360 usable rather than
      clipping, with the toolbar wrapping instead of overflowing and the board scrolling horizontally
      inside itself while the page does not.*
- [x] **Verdict (C5):** satisfies the anchor at both widths. At 880 the title and all four toolbar
      controls sit on one row, the columns render below with the board's own single page pad, and nothing
      of Control's shell is left behind. At 360 the toolbar reflows to three rows through
      design-system.css's shared 620px `.ds-page-chrome` breakpoint — nothing clips, nothing overlaps —
      and the board scrolls horizontally inside itself rather than the page doing so.
      The pass earned its cost on a false alarm worth repeating: at 360 the create action LOOKED lost, and
      the cause was the harness rather than the board — `scripts/webview-preview/index.html` sizes a DIV
      (`#frame`), not an iframe, so `?width=360` narrows the box while `@media (max-width: 620px)` still
      reads the 1280px browser viewport and never fires. Measuring a breakpoint here needs the BROWSER
      viewport set (what `scripts/visual-qa/*.mjs` already do with `page.setViewport`); `?width=` alone
      silently tests nothing. Filed with the maintainer's own half of the measurement as **t-b24282**.

## Cookbook

**Cookbook-Opt-Out:** no new operator or agent surface — this reverses where existing screens render.
The one behavioural rule an operator must know (a document's project is fixed at open) belongs in
`spec.md`, not in a separate how-to.
