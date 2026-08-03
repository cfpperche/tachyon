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
- [x] C6. Move the project selector into the sidebar Control tab header row (the slot the Agents tab
      uses for `All · N`), with the host keeping a single writer. Re-anchor
      `controlWorkspaceScope.test.ts` in the same change.
- [x] C7. Guard the identity rule: switching the selector does not retarget an open document.
- [x] C8. Launcher tiles and `tachyon.*` commands open/reveal these two apps; their old Control
      routes become redirects with no dead path left behind.
- [ ] **CHECKPOINT — stop and use it.** Board beside a terminal, two task details side by side, for a
      few days. If side-by-side is not what the use wanted, the remaining ten are untouched and the
      spec's `Done` narrows here. _Strike this only on the maintainer's word — it is insurance, not
      a technical requirement._

### Phase D — the remaining dashboards, and the documents

**Order matters and is not preference.** Every PR here removes something from `Cockpit.ts`, and C4/C5
proved a three-way merge of two such PRs silently keeps BOTH sides with no conflict reported (see
notes.md). So Phase D is SEQUENTIAL on that file: one lands, the next rebases onto it. Two agents may
work in parallel only if the second re-applies onto the first before delivery, never merges into it.

- [x] D1. **tmux Server Inspector** — and the task that discovered the THIRD cardinality. It is not a
      dashboard: the socket is cross-workspace by design, the model carries sessions owned by closed
      and other-window workspaces, and the screen has its own workspace filter with an "all" option,
      so one panel per project would open N identical tabs onto one server. `window` (key = `viewId`,
      no project, no identity) is the member, and `sectionPanelKey` REFUSES both — see notes.md for
      the rejected "dashboard with a constant project". The retired `tachyonServerInspector` viewType
      is reused rather than replaced, because a `window` app's persisted state is byte-identical to
      that tombstone's, so restore revives with no shim at all.
- [x] D2. **Plugins** — the second Phase D migration and the second `dashboard`. Where D1 found a third
      cardinality by not fitting, this one fits the table the spec always had, and the fact is in the
      domain rather than in a policy: a plugin install is per-workspace end to end (lockfile, runtime
      detection and every apply are rooted at one `workspaceRoot`), so two attached projects have two
      genuinely different plugin sets and two panels showing two answers is correct. The retired
      `tachyonPlugins` viewType is REUSED (a one-field `wsHash`→`project` rename), which is C4's call
      rather than C5's — see notes.md for the two-part question that separates the three prior calls.
      The trap this one paid for was the page PAD, not the page FRAME: `.ck-plugins-root`'s
      `--ds-page-pad-*` rule lived in `cockpit.css`, and the Phase A consumption check cannot see a
      missing pad. **D3 should grep `cockpit.css` for its surface's root class before anything else.**
- [x] D3. **Runtime Ops** — and the migration that shows a section's cardinality is not a property of
      being a section. It was commissioned as a `dashboard` and is a **`window`**: `buildSnapshot()` takes
      NO project and `extension.ts` implements it as a merge across every attached workspace, the provider
      quota it shows is account-wide by its own type's words, and `sendRuntime` never read the project
      selector — so two attached projects would have opened two byte-identical panels. The launcher tile
      beside it decides the point: **Runtime Config is a `dashboard`** (`buildSnapshot(wsHash)`), so two
      adjacent tiles have opposite cardinalities and the difference is a parameter on a signature. The
      brief's `DONE_WHEN` ("prove two projects differ BY CONTENT") was unsatisfiable without changing
      behaviour the same brief forbade, and was replaced with D1's symmetric proof: one panel, and
      `sectionPanelKey` REFUSING a project. The viewType is NEW (`tachyonRuntimeOps`) — the first surface to
      fail the "does the id still name this app" half, because `tachyonRuntimeOpsView` names spec 367's
      retired **WebviewView**, a different surface kind that was never registered. D2's `cockpit.css` grep
      paid off in the OTHER direction: the pad was always this sheet's, so the residue was a rule to DELETE
      in both sheets rather than move. **D4 should run BOTH ten-second checks: grep `cockpit.css` for the
      root class, and read the host dep's signature for whether it accepts a project.**
- [x] D4. **Human Inbox** — the fourth Phase D migration, the third `dashboard`, and the first surface to
      leave Control with TWO route kinds: its item detail stays a SUBROUTE of the app rather than becoming a
      document (the queue is a thing a human works down — `route.ts:258` — and two items side by side is a
      product decision nobody asked for). Cardinality confirmed by D3's method rather than assumed: every read
      is rooted at ONE `workspaceRoot` (pending approvals, that workspace's validations, both Saved Agent
      queues, the config digest, the artifact loader's containment root), so two projects have two genuinely
      different queues. Three firsts worth carrying forward: the `cockpit.css` grep returned a THIRD answer —
      **nothing to do** — because `.hi-root` is a `div` and the embed neutralization is `.ck-embed-host > main`;
      the viewType question had **no subject**, since this surface was born a Control section AFTER 410 and left
      no tombstone (new id `tachyonHumanInbox`, no shim); and the state between messages is the SUBROUTE itself,
      inherent to the design rather than inherited, so it lives inside `bind` and a shared slot would show
      project A's approval decision under project B's tab. **D5 should grep `cockpit/App.tsx` for what it
      renders AROUND its surface, not only for the surface**: the item's `← Inbox` breadcrumb was Control's
      chrome, and without moving it into the app the detail would have been reachable and unleavable — no
      functional test would have noticed.
- [ ] D5–D10. One PR per remaining dashboard (Overview, Engine, Fleet, Worktrees, Execution,
      Runtime Config, Settings). Each PR: app lands,
      launcher + commands point at it, old restore state and deep links redirect, that section's
      renderer leaves `cockpit/App.tsx`. A shim with no UI may survive; two live renderers may not.

      **These are a different shape of work from D1–D4, and the difference is not where anyone expects.**
      Measured before planning: the JSX is NOT the cost. Engine is 12 lines, Worktrees 13, Execution 16 —
      thin wrappers around `ModuleChrome` plus components that already exist and already ship
      (`WorkspaceCard`, `ListRow`). Fleet is 66 and Overview 113. None approaches what
      `human-inbox/App.tsx` already was before D4 touched it. Extraction is close to mechanical.

      The cost is the MODEL. `buildCockpitModel(bundles, opts)` is ONE pure function producing every
      section's slice from one `CockpitDeps.collect()`. D1–D4 each had a host source of their own
      (`inboxSources`, `buildSnapshot`, the plugin lockfile); these six share Control's. So each PR has a
      fork it must answer explicitly:

        (a) the app calls the same builder and reads its own slice — cheap to write, and every open panel
            pays the whole collect;
        (b) collect + builder split per section — real work, and the payoff is an open Fleet not
            re-collecting worktree data.

      **Take (a) first.** (b) is optimization before a measurement exists, and `t-a8f4a9` (an engine event
      hub pushing deltas instead of per-window polling) plausibly subsumes the whole problem — doing (b)
      now risks building something that gets thrown away. Record the collect cost per panel when (a) lands;
      that is the measurement (b) would need and nobody has.

      **Correction to the paragraph above, measured after writing it: the model is A cost, not THE cost.**
      The thing that actually separates these six from D1–D5 is the STYLESHEET, and counting JSX lines
      cannot see it. Every one of the five migrated apps arrived with a stylesheet of its own
      (`mission-control.css`, `inspector.css`, `plugins.css`, `runtime-ops.css`, `human-inbox.css`) and
      **not one of them uses a single `ck-` class** — checked by grep across all five directories, which
      returns nothing. Engine is the first section whose markup is written in CONTROL's namespace:
      `ck-card-list`, `ck-empty` on the section itself, and `ck-mono` plus five `ck-wt-*` inside
      `WorkspaceCard` — which is not extracted either (`cockpit/App.tsx:773–842`, 69 lines, so Engine's
      real footprint is ~81 lines of TSX and not the 12 the section body suggests).

      Those rules live in `cockpit.css` and are SHARED: `ck-mono` has 9 uses, `ck-empty` 3, `ck-card-list`
      2. So moving a rule breaks whatever section still renders it, and copying it forks a definition —
      the classic problem the first five never hit because each owned its own sheet from birth. Each rule
      has a LAST user somewhere in D5–D10, and until that migration it must be live in two places.

      This does not change the (a)/(b) recommendation; it adds a third question every one of these PRs has
      to answer out loud: **which `ck-` rules does this section consume, who else still consumes them, and
      does this migration move them, copy them, or leave them.** `page-frame.css` (t-32c872) is the shape
      of the answer when a rule is genuinely shared — one opt-in sheet, LINKED not copied, with the Phase A
      contract checking the CONSUMPTION. Reach for that before duplicating.

      Two facts checked rather than assumed, so no one re-derives them:

        - **The workspace scope survives Overview leaving.** `cockpit/App.tsx`'s comment calls its `<select>`
          "THE global workspace scope, and the only one in Control", which reads like a blocker. It is not:
          `controlWorkspaceScope` is a host-side per-window authority and the SIDEBAR writes it
          (`SidebarPrototype.ts:286`). Overview's select is a second writer, not the owner.
        - **Settings has no `section === "settings"` branch.** It is the `else` fallback at the end of the
          chain. Whoever migrates it finds that out before starting, not during.
- [ ] D11. **Task Studio becomes the EDIT MODE of the task-detail document**, not its own app
      (spec.md § "A document is one ENTITY"). Same panel, same key (`taskId`), mode as state. Declare
      and test the unsaved-edit policy on mode switch — that policy is the cost this decision accepts,
      and leaving it implicit is how it turns into data loss.
- [ ] D12. The remaining studios (command, terminal, runbook, schedule, agent) become document apps
      with ONE mode. Their parent is a flat section (`route.ts:187`), not an entity route, so do not
      invent a reading view none of them has.
- [ ] D13. **One Pins document app carrying detail and edit**, keyed by pin id — same shape as D11.
      The LIST stays in the sidebar. `studio-edit(pin)`'s `returnRoute ?? overview` fallback becomes
      the app's own read mode, since it existed only for lack of a detail route to return to.
      Its current host is `SidebarPrototype.previewPin` (`:439`), which already opens an editor panel;
      moving it to `SectionPanelManager` also gets it the Phase B gate it has never had.
- [ ] D14. Decide the Overview JUMP card — survives, mirrors the launcher, or goes. It is a second
      navigation surface left open deliberately by t-aa2780.
- [ ] D15. Exercise restore with all apps open across editor groups, then reload. Spec 361's
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
- [x] **Evidence (D1, 2026-08-03):** the tmux app at 880 and 360, on BOTH its tabs, captured through the
      route this change adds — `npm run preview:webview` + `?view=inspector&fixture=volume&width=<w>&height=900`
      with the browser VIEWPORT set to the same width (t-b24282's fix, used rather than only cited), rendering
      the REAL shipped `dist/webview/inspector.js` with the exact stylesheet list `TmuxPanel.ts` links
      (`cockpitCssParity.test.ts` asserts the two agree). The `volume` fixture is committed with the route —
      20 sessions across four groups (three attached, one closed/foreign), 15 live, 5 dead, 4 orphaned, long
      `startCommand`s — because C5's pass came back clean on a broken screen partly for want of volume.
      Screenshots under `.vqa/485-d1/` (gitignored work evidence; the ROUTE and the driver
      `scripts/visual-qa/tmux-app-widths.mjs` are committed, so all four are one command to re-take) and
      attached via `attach_evidence` on `tmuxapp` (`ev-2026-08-03T17:24:48.967Z-0`). Anchor, written from the
      task's problem statement before the surface was measured: *the inspector must arrive as a first-class
      editor tab showing the SAME server it showed inside Control — at 880 the page chrome on one row above
      the Overview/Server tabs, the five-column filter bar on one row below them, session rows reading
      status · label · meta · age · actions, with the surface's own single page pad rather than doubled or
      absent where Control's shell used to be; at 360 usable rather than clipping, the filter bar reflowing
      instead of overflowing and the row actions wrapping instead of pushing the row off the page; and at both
      widths its own Workspace filter, with the "all" option, present and untouched — because that filter is
      the reason this app is one panel and not one per project.*
- [x] **Verdict (D1):** satisfies the anchor at both widths, on both tabs; zero horizontal overflow anywhere
      (scrollWidth == clientWidth at 880 and 360). At 880 the five filters sit on one row and each session row
      reads on one line; at 360 the filter bar reflows to five stacked rows, each session row wraps its meta
      and actions below the identity, and the Server tab's five-metric grid reflows 2-up with the diagnostics
      `pre` scrolling inside itself while the page does not. The Workspace filter and its "all" option render
      unchanged at both widths, and the `(closed workspace)` foreign group shows its own note — the two facts
      the `window` cardinality rests on, visible on screen rather than only in a test.
      Two things named so they are not read as migration defects, both INHERITED: at 360 the Kill button wraps
      to its own line (`.acts { flex-wrap: wrap }`, and Control rendered it identically), and every age reads
      ~414d because the fixture pins a fixed epoch while `ago()` computes live — a fixture artifact the
      `default` fixture has always had. `inspector/App.tsx` and `inspector.css` are byte-identical across this
      change, which is what lets both claims be checked rather than asserted.

- [x] **Evidence (D2, 2026-08-03):** the Plugins app at 880 and 360, on FOUR fixtures, captured through the
      route this change adds — `npm run preview:webview` +
      `?view=plugins&fixture=<default|update-available|source-changed|runtime-gap>&width=<w>&height=900`
      with the browser VIEWPORT set to the same width (t-b24282's fix, used rather than only cited),
      rendering the REAL shipped `dist/webview/plugins.js` with the exact stylesheet list
      `PluginsPanel.ts` links (`cockpitCssParity.test.ts` asserts the two agree). The fixtures are the ones
      t-4e5f11 and t-fb216a already committed, used rather than invented. Screenshots under `.vqa/485-d2/`
      (gitignored work evidence; the ROUTE and the driver `scripts/visual-qa/plugins-app-widths.mjs` are
      committed, so all eight are one command to re-take) and attached via `attach_evidence` on
      `pluginsapp`. Anchor, written from the task's problem statement before the surface was measured:
      *Plugins must arrive as a first-class editor tab showing the SAME installed list it showed inside
      Control — nothing gained and nothing lost by the move. At 880 the page chrome and its three actions on
      one row, the install-by-source bar and the Installed/Marketplace tabs below it, the filter/sort
      toolbar on ONE row, and each card reading name · version · status badge · actions with its provenance
      and runtime pills beneath, all inside the surface's own single page pad rather than doubled or absent
      where Control's shell used to be; at 360 usable rather than clipping, with `plugins.css`'s own
      `@media (max-width: 720px)` firing; and at BOTH widths the card states t-4e5f11 built reading exactly
      as they did — "up to date", "update available · vX" beside Update, and "source changed · still vX"
      beside REAPPLY, because a migration is exactly where a badge and its verb quietly stop agreeing.*
- [x] **Verdict (D2):** satisfies the anchor at both widths on all four fixtures; zero horizontal overflow
      anywhere (scrollWidth == clientWidth at 880 and 360, and no unclipped element escaping the page box).
      At 880 the three chrome actions sit on one row, the toolbar's filter/sort/count read as one row, and
      every card reads on the lines the anchor names. At 360 `plugins.css`'s 720px block fires — the
      toolbar collapses to one column and `.card-actions` becomes a full-width row under the title — the
      chrome actions wrap to two rows, and t-fb216a's coverage notice wraps as prose. The page pad measures
      12px/16px at both widths, from `plugins.css` rather than from Control's shell, which is the one CSS
      rule this migration had to move. The two card states t-4e5f11 built are verified by their exact
      strings rather than by eye: `visual-qa` reads "update available · v0.2.0" beside **Update**, and
      `secrets-guard` reads "source changed · still v2.0.1" beside **Reapply**.
      One thing named so it is not read as a migration defect: the FOURTH state the task names — downgrade —
      is not a fourth card rendering. `deriveUpdateCheck` maps `isDowngrade` to `up-to-date` deliberately
      (a source resolving LOWER offers nothing to update to, and "update available · v0.1.0" would be a
      lie); its distinct treatment is the consent drawer's force gate, which has never been a harness
      fixture in Control either. So three card renderings cover the four states, and `default` stands for
      both "up to date" and "downgrade".
- [x] **Evidence (D3, 2026-08-03):** Runtime Ops at 880 and 360, on FIVE fixtures, captured through the
      route this change RESTORES — `npm run preview:webview` +
      `?view=runtime-ops&fixture=<provider-healthy|throttled|provider-exhausted|long-label|duplicate-workspace>&width=<w>&height=900`
      with the browser VIEWPORT set to the same width (t-b24282), rendering the REAL shipped
      `dist/webview/runtime-ops.js` with the exact stylesheet list `RuntimeOpsPanel.ts` links
      (`cockpitCssParity.test.ts` asserts the two agree). The fixtures are the ones already committed, used
      rather than invented. Screenshots under `.vqa/485-d3/` (gitignored work evidence; the ROUTE and the
      driver `scripts/visual-qa/runtime-ops-app-widths.mjs` are committed, so all ten are one command to
      re-take) and attached via `attach_evidence` on `runtimeopsapp` (`ev-2026-08-03T19:36:58.523Z-0`).
      Anchor, written from the task's problem statement before the surface was measured: *Runtime Ops must
      arrive as a first-class editor tab showing the SAME runtime inventory it showed inside Control. At 880
      the page chrome above a five-metric summary strip with the snapshot timestamp pushed to its right
      edge, the provider-capacity block below it reading identity · quota windows · control one row per
      provider, and the runtime table below that with its five column headers and one group per runtime, all
      inside the surface's OWN single page pad — which always lived in `runtime-ops.css` rather than in
      `cockpit.css`, so it must measure the SAME now that the embed-context rules are deleted; at 360 usable
      rather than clipping, with this sheet's own `@container (max-width: 720px)` and
      `@media (max-width: 760px)` firing; and at BOTH widths the two CROSS-WORKSPACE facts legible — a
      runtime row naming every workspace it spans, and the provider block stating its quota is account-wide
      — because those are the visible evidence for the `window` cardinality this task took against its brief.*
- [x] **Verdict (D3):** satisfies the anchor at both widths on all five fixtures; zero horizontal overflow
      anywhere (scrollWidth == clientWidth at 880 and 360, no unclipped element escaping the page box).
      **The load-bearing measurement is a negative one:** the page pad reads 12px/16px at every width on
      every fixture — identical to Control — which is what proves the two deleted rules
      (`cockpit.css`'s `.ck-embed-host > .runtime-ops` and this sheet's `!important` re-assert) were embed-only
      compensation rather than something load-bearing. A static CSS test cannot make that claim.
      At 880 the summary strip sits on one row with the timestamp flush right (gap 0px) and the table renders
      its five headers as a grid; at 360 the summary reflows to three rows, the provider rows stack with
      full-width meters and the control below, and the table header goes `display: none` while each cell shows
      its `data-label` — the stacked layout `runtime-ops.css` was written for. The cardinality's own evidence is
      on screen rather than only in a test: `duplicate-workspace` renders ONE runtime row reading
      "2 managed / apps/api, tools/api", and the capacity header states the quota is "not attributed to a
      runtime, workspace, or agent".
      Two corrections the run forced, recorded because they were the measurement being wrong rather than the
      screen: the capacity block is ALWAYS two rows (an unobserved provider reads "not observed" rather than
      vanishing — confirmed pre-existing, since `runtime-ops/App.tsx`, the fixtures and `src/runtimeOps/` are
      byte-identical across this change), and `mixed` is literally `const mixed = providerHealthy`, so
      measuring both would have photographed one screen twice and reported two passes; `throttled` and
      `provider-exhausted` took its slot. One thing named so it is not read as a migration defect: every
      timestamp reads 7/9/26 because the fixtures pin a fixed epoch — the same fixture artifact D1 recorded.


## Cookbook

**Cookbook-Opt-Out:** no new operator or agent surface — this reverses where existing screens render.
The one behavioural rule an operator must know (a document's project is fixed at open) belongs in
`spec.md`, not in a separate how-to.
