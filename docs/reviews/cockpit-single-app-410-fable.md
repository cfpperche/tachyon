# Review: SDD 410 — cockpit-single-app

_Reviewer: agent **fable**. Adversarial review of spec + plan + tasks only — no code written._
_Reviewed: `docs/specs/410-cockpit-single-app/{spec,plan,tasks,notes}.md` @ 2026-07-18 draft, against
`docs/STYLEGUIDE.md`, `src/cockpit/model.ts`, `src/webview/Cockpit.ts`, `src/webview/surfaces.ts`,
`test/unit/webviewConvention.test.ts`, `test/unit/webviewComponentKit.test.ts`, and current
`dist/webview/*.js` sizes in this checkout._

## 1. Verdict: **ACCEPT-WITH-CHANGES**

The two-app intent is right and the phased, screen-by-screen migration shape is the correct answer to
23 independent bundles. But the spec/plan were authored without checking two pieces of repo state that
directly collide with Phase A's own guard task and Phase C's migration list — both are cheap to fix in
the doc, expensive to discover mid-implementation. Fix the P0s below before Phase A starts; the P1s
should land as plan.md edits, not blockers.

## 2. P0 blockers (must fix before implement)

### P0-1 — Phase A's proposed guard collides with an existing, fully-enforcing manifest

`plan.md` Phase A step 2 ("Guard") proposes a **new** "Unit test or build-time list of allowed
`src/webview/*/main.tsx` entries (snapshot)." `tasks.md` repeats this as "Add inventory/allowlist test
of `src/webview/*/main.tsx`" and even suggests `test/unit/webviewComponentKit.test.ts` as a possible
home for it.

That test file is the wrong one — it enforces `MIGRATED_VIEWS` (spec 282, banned kit-class tokens),
not surface inventory. The actual inventory/allowlist manifest **already exists**:
`src/webview/surfaces.ts` (`WEBVIEW_SURFACES`, spec 279), enforced by
`test/unit/webviewConvention.test.ts`, which today asserts:

- every surface has a real `main.tsx` + esbuild entry (`"every converted surface is a real preact bundle"`),
- the manifest is **fully enforcing with an empty allowlist** (`"is FULLY ENFORCING... spec 279 complete"`),
- every `createWebviewPanel` id is manifested (`"the manifest covers every registered webview surface"`),
- every editor-area panel has an explicit reload-serializer policy.

None of spec.md, plan.md, tasks.md or notes.md mention `surfaces.ts`, spec 279, or
`webviewConvention.test.ts`. If Phase A's guard is authored as a second, independent snapshot instead of
extending `WEBVIEW_SURFACES`, the repo ends up with **three** overlapping "what webview surfaces exist"
lists (spec 279 `WEBVIEW_SURFACES`, spec 282 `MIGRATED_VIEWS`, and a new 410 list) — exactly the "second
token set / second button" anti-pattern `STYLEGUIDE.md` opens by forbidding. Worse: the moment Phase A's
own pilot task ("Remove pilot's competing shell CSS... if still present") or any Phase B/E task deletes a
`main.tsx`/Panel manager, `webviewConvention.test.ts`'s "manifest covers every registered surface" and
"every surface converted" assertions go red unless `WEBVIEW_SURFACES` is edited in the same PR — and
nothing in `tasks.md` schedules that edit.

**Fix:** Phase A's guard task must explicitly say it extends `src/webview/surfaces.ts` (e.g. a
`cockpitSectionOnly: boolean` / `retiredInFavorOf: "cockpit"` field) rather than authoring an
independent list, and every Phase B/C/E task that deletes a `main.tsx` or Panel manager must include
"update `WEBVIEW_SURFACES` + `webviewConvention.test.ts` expectations" as part of that task's definition
of done.

### P0-2 — Phase C's target surfaces are multi-instance; cockpit is a singleton

`src/webview/Cockpit.ts` holds `let panel: vscode.WebviewPanel | undefined` and a single
`currentSection` — module-level singleton, "reveal existing or create one." But `tasks.md` Phase C lists
migrating **Task detail**, **Handoff**, and **Probes** straight into "a cockpit section." Checked against
the actual host managers:

- `TaskDetailPanelManager` — `private readonly panels = new Map<string, PanelEntry>()`, keyed per task id,
  explicitly supports N concurrent task-detail panels open at once.
- `HandoffPanelManager` — `Map`-keyed per workspace hash, same multi-instance support.
- `ProbeResultPanelManager` — same `Map`-keyed pattern.

A one-`panel`/one-`currentSection` cockpit cannot host "3 task-detail panels open simultaneously, one per
task" as "a section" without a real design decision: does cockpit grow multi-instance/tabbed section
support, do these three surfaces get a documented standing exception to stay thin standalone hosts, or is
only the single most-recent instance supported post-migration (a real behavior regression for anyone who
currently keeps two task-detail tabs open side by side)? Neither `plan.md`'s Phase C table nor its Risks
table mention this. This isn't an implementation nuance — it's a structural blocker for the entire Phase C
track as scoped, and it should be decided as a plan-level architecture call, not discovered when the first
Phase C PR tries to make it work.

### P0-3 — Spec explicitly asked for a bundle-size budget; plan doesn't give one

`spec.md` Open Question 3: "Bundle weight: ... plan picks a **default with a size budget note**."
`plan.md`'s Key decisions table answer is "Lazy sections after pilot" (rejected: "single unsplit chunk
forever") — a strategy, not a number. The Risks table's mitigation is "measure dist size on pilot," which
is an observation step, not a gate.

Measured in this checkout, the actual stakes are concrete: `dist/webview/cockpit.js` is already **244KB**.
The Phase C migration targets are each individually larger than cockpit is today:
`activity.js` 648KB, `task-detail.js` 644KB, `handoff.js` 640KB, `task-studio.js` 568KB,
`pin-studio.js` 452KB. Phase A's plan text commits to lazy `import()` only for **Phase D studios**
("Lazy `import()` per studio to protect cockpit TTI") — Phase B/C get no equivalent commitment, and no
task in `tasks.md` builds or tests the lazy-section mechanism during Phase A. Without an enforced budget
or a required code-splitting step before a Phase B/C surface merges, cockpit's editor-open bundle can grow
by multiple MB before anyone notices, silently regressing every user's Control-open TTI — and there's no
CI gate that would catch it.

**Fix:** plan.md states a numeric budget (e.g. "+N KB max per migrated section before code-splitting is
mandatory, cockpit.js stays under M KB through Phase B") and Phase A implements the lazy-import mechanism
(not just decides on it) before Phase B's first PR, since Phase B's first target (Activity/Task
detail-adjacent surfaces) are the largest bundles in the tree.

## 3. P1 gaps

- **Pilot surface left "TBD" despite the spec asking the plan to decide.** `spec.md` Open Question 1:
  "pick in plan." `plan.md`'s Files/areas table: "Pilot surface | TBD among approvals / runtime-ops /
  validations." `tasks.md` still says "Choose and implement **one** pilot... at implementation start."
  The spec's own instruction wasn't followed — either update the spec to say "pilot chosen at
  implementation kickoff" (weakening the ask) or actually name one in the plan.

- **Motivating narrative partly contradicts STYLEGUIDE's own status table.** `spec.md`'s Intent opens
  with "divergent padding, header typography, button chrome... is a primary driver of visual
  inconsistency" as the reason two apps are needed. But `STYLEGUIDE.md`'s Pilot status table already
  marks Approvals, Validations, Runtime Ops, Board (head), tmux/Inspector, Activity, Plugins, Task
  detail, control-inspector, and pipeline-studio chrome as **"done."** If chrome parity is already
  substantially shipped per the project's own style guide, the acceptance criteria under "Incremental
  migration (per surface)" that re-test header/pad parity are re-asserting an already-covered guarantee
  (the `MIGRATED_VIEWS` kit guard already polices this). The actual unresolved problem — one runtime
  instead of N webviews, no CSS co-load bleed, no dual command-routing paths — deserves to be the
  acceptance criteria's primary framing; right now it reads as solving a problem STYLEGUIDE says is
  mostly solved, while under-specifying the problem that's actually still open.

- **Existing dual path for Approvals isn't inventoried as a baseline risk.** `tachyon.openApprovals`
  today opens the standalone `ApprovalPanelManager` (its own `approval.js` bundle, its own
  `createWebviewPanel`) completely independently of Cockpit's `"approvals"` section. Meanwhile
  `Cockpit.ts` **already** statically imports `./approval/messages.js` and `./approval/viewModel.js` (not
  just co-loaded CSS) — so the current state is a partial, undocumented merge: business logic is shared,
  the component mount and the command routing are not. `notes.md`'s baseline inventory doesn't capture
  this nuance, so whoever picks Approvals as the Phase A/B pilot is scoping against the plan's mental
  model ("a real Preact child import instead of a second conceptual app") rather than the actual current
  code, where half of that is already true.

- **CSS co-load risk is named but never gated.** `plan.md`'s Risks table flags "Embed CSS co-load bleed"
  and says "Stop co-loading foreign sheets as sections go in-tree" — but no acceptance criterion or task
  requires this to actually happen; a foundation slice could ship, a pilot could land, and the 11
  stylesheets currently loaded unconditionally in `Cockpit.ts`'s `renderWebviewShell` call (codicon,
  design-system, vscode-theme, mission-control×2, plugins×2, approval, validations, runtime-ops,
  inspector, cockpit) could remain unconditionally loaded indefinitely with no test catching the
  omission.

- **`Verify:` command omits the most relevant existing guard.** `tasks.md`'s `Verify:` line runs
  `webviewComponentKit.test.ts` and `uiPatterns.test.ts` but not `webviewConvention.test.ts` — the
  existing suite most likely to catch a Phase A regression (P0-1) if the new guard is added correctly.

- **Spec-282 `MIGRATED_VIEWS` bookkeeping isn't mentioned either.** Same shape as P0-1 but for the older
  guard: when a Phase C surface's directory disappears (e.g. `handoff`, `task-detail`), the
  `MIGRATED_VIEWS` array in `webviewComponentKit.test.ts` still names it, and that test's own
  `existsSync(dir)` assertion (`"migrated view ${view} missing"`) would fail. Not called out anywhere in
  tasks.md's Phase C or Phase E checklists.

## 4. P2 nits

- `spec.md` Intent: "≈23 `App.tsx` surfaces + separate `main.tsx` mounts" slightly overstates a 1:1
  mapping — `plugin-host`'s single `main.tsx`/bundle serves **two** manifested `viewId`s
  (`tachyonPluginSurface`, `tachyonPluginSurfaces`) per `surfaces.ts`. Doesn't change the thesis, just a
  minor inventory precision nit.
- Board is already `"mission"` in `CockpitSectionId` (`src/cockpit/model.ts`) and is already wired into
  `Cockpit.ts` (`missionWsHash`), same partial-embed shape as Approvals (P1 above). `plan.md` Phase B row
  6 ("Board (mission) — Heaviest") doesn't flag that this one may also be further along than "peer app"
  framing suggests — worth a one-line note alongside the Approvals nuance once that's added.
- `tasks.md` Verify section keeps a commented-out placeholder for a future
  `cockpitAppInventory.test.ts` path — reasonable as a stub, but once P0-1 is resolved this comment should
  either be deleted (if `surfaces.ts` is extended instead) or updated to point at the real file, so it
  doesn't drift into a second phantom guard suggestion of its own.
- "documented default with a single migration note" (spec.md, "section navigation is durable" scenario)
  is vague enough to not function as a fixed oracle — see patch below.

## 5. Suggested acceptance-criteria patches (paste-ready)

**Patch A — replace the vague guard scenario in `spec.md` with one that names the real manifest:**

```
- [ ] **Scenario: the foundation guard is the single source of truth for webview surfaces**
  - **Given** `src/webview/surfaces.ts` (`WEBVIEW_SURFACES`, spec 279) and
    `test/unit/webviewConvention.test.ts` already enforce main.tsx/esbuild-entry/serializer coverage
    for every registered webview surface
  - **When** Phase A adds a mechanical guard for the two-app rule
  - **Then** the guard extends `WEBVIEW_SURFACES` (e.g. a `cockpitSectionOnly` / `retiredInFavorOf`
    field) rather than introducing an independent manifest or snapshot
  - **And** any task that deletes a `main.tsx` or Panel manager updates `WEBVIEW_SURFACES` (and its
    `converted` / reload-serializer expectations) in the same PR, verified by
    `webviewConvention.test.ts` staying green
```

**Patch B — add a multi-instance design scenario before Phase C is scheduled:**

```
- [ ] **Scenario: multi-instance surfaces have an explicit cockpit hosting design**
  - **Given** Task detail, Handoff, and Probes today support N concurrent panel instances
    (`Map`-keyed by task id / workspace hash in their Panel managers)
  - **When** Phase C proposes migrating a multi-instance surface into "a cockpit section"
  - **Then** plan.md states, before any Phase C task starts, one of: cockpit gains
    multi-instance/tabbed section support; the surface keeps a documented standing exception as a
    thin standalone host; or only the single most-recent instance is supported post-migration
    (with the resulting behavior change stated explicitly, not silently accepted)
  - **And** the choice is recorded in plan.md's Key decisions table, not deferred to
    "implementation start"
```

**Patch C — turn the bundle-weight open question into an enforced oracle:**

```
- [ ] **Scenario: cockpit bundle growth is gated, not just measured**
  - **Given** `dist/webview/cockpit.js` is 244KB today and Phase B/C migration targets
    (activity.js 648KB, task-detail.js 644KB, handoff.js 640KB, task-studio.js 568KB,
    pin-studio.js 452KB) are each larger than cockpit itself
  - **When** a surface migrates into cockpit's Preact tree
  - **Then** it is loaded via the Phase A lazy-import mechanism unless explicitly exempted with a
    written reason in plan.md
  - **And** a documented numeric budget (e.g. "cockpit.js stays under **X** KB through Phase B") is
    checked — by CI size assertion or an explicit manual dist-size note per migration PR — before that
    PR merges
```

**Patch D — replace "documented default with a single migration note" with a fixed oracle:**

```
- [ ] **Scenario: section navigation is durable**
  - **Given** cockpit is open on section S
  - **When** the webview is hidden/shown or the panel is restored after reload (serializer path)
  - **Then** section S is restored exactly, using the existing `CockpitPanelState.section` +
    `registerTrustedPanelSerializer(context, COCKPIT_VIEW_TYPE, ...)` path already wired in
    `src/extension.ts`
  - **And** if S no longer exists (retired section), cockpit falls back to `"overview"` and this
    fallback is asserted by a unit test — not just "a migration note"
```

**Patch E — pick the pilot in the plan (or admit the spec's ask was too strong):**

```
Files / areas (foundation) table, "Pilot surface" row:
- Replace "TBD among approvals / runtime-ops / validations" with the chosen surface and one line of
  why (e.g. "Approvals — smallest App.tsx, already partially shares messages/viewModel with cockpit,
  worst historical shell offender so its fix is the most visible proof").
- If the team genuinely wants to defer the pick to implementation kickoff, change spec.md's Open
  Question 1 from "pick in plan" to "pick at kickoff, plan states the decision criteria" so the doc
  doesn't claim a commitment it didn't make.
```

## 6. What is already solid

- **Inventory is accurate.** Verified independently: 23 `App.tsx` under `src/webview/`, 24 `main.tsx`
  (matches `notes.md`'s baseline exactly).
- **Phasing is genuinely incremental**, not big-bang-with-extra-steps: Phase A ships a foundation +
  single pilot before any bulk Phase B/C migration, and each migration row in Phase B/C is its own
  PR/checkbox — consistent with the "no big-bang" ratified intent.
- **Sidebar is correctly frozen and out of scope**, consistent with STYLEGUIDE's existing sidebar
  density-chrome exception; nothing in the plan tries to fold sidebar in.
- **Reuses the existing `CockpitSectionId` as the nav spine** rather than forking a second router —
  directly aligned with the "no second token set / no second router" instinct the rest of the codebase
  already enforces.
- **Non-goals are appropriately scoped**: explicitly excludes sidebar absorption, framework swap,
  studio-canvas visual identity, mobile, and (importantly) plugin-runtime multi-compat, matching the
  stated out-of-scope parallel human workstream.
- **Risks table correctly names the real hazards** (bundle bloat, CSS bleed, serializer loss, dual open
  paths, studio isolation) even though several aren't yet gated by an acceptance criterion (see P1) — the
  awareness is there, it just needs to be turned into fixed oracles.
- **Visual QA and Dogfood aren't silently opted out.** The Dogfood-Opt-Out has a concrete reason
  (foundation is structural, revisit at Phase B) and still requires a human dogfood pass for the
  foundation slice; Visual QA is explicitly required, not deferred indefinitely.
- **Human ratification line is present** and the plan's "Sources consulted" section shows real repo
  grounding (inventory, `model.ts`, `Cockpit.ts`, panel managers, STYLEGUIDE, prior specs 252/282/342).
