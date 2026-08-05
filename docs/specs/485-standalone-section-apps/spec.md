# 485 — standalone-section-apps

_Created 2026-08-02._

**Status:** shipped-partial

**Closure:** 2026-08-04 — Control is gone. Every section it rendered is a standalone app that opens
as its own editor tab, `Cockpit.ts` / `cockpit/main.tsx` / `cockpitSingleton.ts` no longer exist, and
`test/unit/controlRendererRatchet.test.ts` became a resurrection guard so the host cannot return
through another door. Phases A, B, C and E complete; D delivered twenty migrations (D1–D20). Gate on
delivery: 682 files / 7639 unit tests, 116 browser tests.

`shipped-partial` rather than `shipped`, and the two gaps are named rather than rounded off:

1. **"One broken app does not take the others" is measured FALSE.** E1 deleted
   `errorBoundary.test.ts` along with Control; restoring it turned the criterion from an assertion
   into a measurement, and 12 of 29 webview mounts carry no boundary — seven of them real product
   surfaces. Ratcheted in that test, owned by t-cd01bb.
2. **Reload restore was never exercised at this app count.** The headless Dev Host harness dies on
   `Developer: Reload Window` (t-5fc17d), so it needs a human (D21).

The **Phase C CHECKPOINT** was never struck; it was insurance against side-by-side not being what the
use wanted, and the use answered by continuing.

**What this cost, and what it taught.** The enforcement mechanism the spec proposed — declare a
posture, and let a test fail the build — worked, and it kept working through twenty migrations that
each moved a live surface. The recurring finding is narrower and more transferable: **an inventory of
what a surface DECLARES cannot see what it RENDERS.** It appeared three times in different costumes —
the Phase A consumption check, the class guard's base-vs-descendant hole, and finally Phase E itself,
which was planned believing the launcher's twelve tiles were the list of things Control drew. They
were not: four surfaces had no tile and were found only by reading the `lazy()` calls out of the
client. Each time, the fix was to stop writing the rule as prose and make the mechanism read the
truth instead — which is also why the page pad, the panel line budget and the renderer inventory are
tests today rather than instructions that had already failed two, two and one time respectively.

The second lesson is about deletion. Three test files were nearly lost in E1 because each was named
for the SITUATION that produced it rather than for what it protects, so all three looked disposable
when the situation ended. `embedPagePad` held six live guards to retire one; `errorBoundary` held a
shared component's contract; `studioCrossStudioResidue` held a fix the standalone Terminal Studio
still depends on. Two were caught by review, the third by the agent that had deleted it.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Supersedes:** SDD 410's *app count* decision only (`docs/specs/410-cockpit-single-app/plan.md`,
Key decisions → "App count: **2** (sidebar + cockpit)"), and its Phase C mandate that all screens
open inside Control as subroutes. Everything else 410 established — the `WEBVIEW_SURFACES` guard,
the kit guard, the CSS co-load pattern, the sidebar's frozen separate role — is kept and load-bearing
here.

## Intent

SDD 410 collapsed 23 peer webview apps into two (sidebar + cockpit) and, in Phase C, mandated that
every screen open **inside** Control as a subroute. Its own words name what it was buying:

> A shared kit (`shared/ui`, design-system tokens) **cannot enforce one runtime when every surface is
> a peer app.**

That fix worked and is not in dispute. What 410 *also* did, knowingly, was trade something away:

> Concurrent side-by-side instances of the same screen class are **knowingly traded** for the
> coherent single app (former Option C's regression, **explicitly accepted by product**).

Six weeks of use inverted that trade. The maintainer's motivating cases are concrete and cannot be
served by any amount of polish inside one panel: the Board open **beside** a terminal, and two task
details open **side by side**. One panel can show exactly one screen; this is a capability ceiling,
not a rough edge.

So the app-count decision is reversed: each Control section becomes a standalone app that opens as
its own editor tab, launched from the sidebar Control tab that already exists (t-6e2952, 0.56.162).

**The reversal is only safe if it carries its own answer to the sentence above.** 410 used *one
runtime* as the mechanism that made the design system enforceable. Going back to N apps without
replacing that mechanism recreates 2026-07-18 exactly — peer apps drifting into dual command routes,
CSS bleed, dual pad, and surface-local shell overrides. This spec therefore has two halves that ship
in order, and the enforcement half comes **first**: a mechanical conformance contract that fails a
build on an **undeclared** departure from the shared shell or the design system. Discipline is not
the mechanism; a test is.

The contract is deliberately not a wall. A surface that must extend the shell does so through
declared extension points and stays conforming; a surface that must replace it declares that, with a
reason, and passes. What fails is silence. A contract with no supported way out is a contract that
gets worked around, and a worked-around contract enforces nothing — which is the failure mode 410
was written to end, arriving by a different road.

The second objection to N apps — that every open app is another live subscriber, multiplying the
event cost this project spent 2026-08-02 reducing (t-b51923: 40 events/s → 2.4/s) — is answered by
visibility gating, which does not exist today: `onDidChangeViewState` appears nowhere in the
codebase, and `StudioPanelManagerBase.ts:160` sets `retainContextWhenHidden: true`, so the ~10
standalone panels that already exist keep refreshing while hidden behind other tabs. Gating them is
worth doing on its own merits and is a prerequisite here.

### Two kinds of app, not one

Both design consults caught the same hole in this spec's first draft, independently, and it is worth
stating in the intent rather than in a footnote: **a task detail is not one of the twelve sections.**
`CONTROL_SECTION_NAV` holds twelve top-level dashboards; a task detail is a route with its own
identity, carrying an immutable `wsHash` (`route.ts:37`). Migrating "the sections" would deliver
twelve editor tabs and **still fail motivating case #2** — two task details side by side.

So this spec declares two kinds, and every decision below applies to both:

| Kind | Cardinality | Examples |
|---|---|---|
| **Dashboard** | one panel per section, per project | Board, Fleet, Engine, Settings, the other eight |
| **Document** | one panel per identity | task detail, and any future entity screen |
| **Window** | one panel, no project and no identity | tmux Server Inspector |

**The third kind was found by building, 2026-08-03 (D1), and is recorded here rather than in a
footnote because it changes what "the twelve sections" means.** A dashboard is per-PROJECT, and the
tmux inspector has no project: its socket is one per user and shared by every workspace in the window,
its model includes sessions owned by folders this window never opened, and its screen carries its own
workspace filter with an "all" option. Under `dashboard` two attached projects would open two
byte-identical panels onto one server. The rejected alternative — dashboard keyed on a constant
project — makes one panel and a key that lies, and could not REFUSE a caller that passed a real
project; see notes.md for the full argument. Cardinality remains a parameter of one manager, now with
three values instead of two.

A document's identity is fixed at open and is never rewritten by the project selector. That is the
rule that makes "two task details side by side" mean two *different* documents rather than one
screen that changes under the human.

#### A document is one ENTITY, not one screen — reading and editing are its modes

**Maintainer decision, 2026-08-03, correcting this spec.** The draft counted task detail and Task
Studio as two documents. They are one: the same task, read and then edited.

The router already says so. `parentRoute` sends `studio-edit(task, X)` to `task-detail(ws, X)`
(`route.ts:283`), and its own comment names it "the task-edit→task-detail chain" — the studio's way
back is the task, not the Board. Splitting them into two apps would put **two editor tabs on one
identity**, which contradicts the cardinality rule this section just established, and would allow
task detail and Task Studio to sit open on the same task showing divergent state, one of them with
unsaved edits. Two panels disagreeing about one entity is worse than one panel with a mode to
resolve.

So: **a document app is keyed by its entity, and edit is a MODE within it.** The cost is real and
named here rather than discovered later — switching mode with unsaved edits needs a declared policy.
That cost is paid either way; the split merely pays it worse, by making divergence representable.

Two limits on this rule, both deliberate:

- **It generalises by entity, not by "studios".** Task is the only studio whose parent is an entity
  route today; `studioParentSection` sends command, terminal, runbook, schedule and agent to flat
  sections (`route.ts:187`). Those are documents with one mode, not two — do not invent a reading
  view none of them has.
- **Pin IS folded in — same shape as task.** Maintainer, 2026-08-03: one Pins document app carrying
  detail and edit, keyed by pin id; the **list stays in the sidebar**, which is what a sidebar is for.

  This corrects a claim made a paragraph earlier in this spec's own history. Pin was first excluded
  on the grounds that its detail is a sidebar surface, read off `editorHome: "sidebar"` in
  `WEBVIEW_SURFACES`. That field names the surface's HOST FILE, not where the panel opens:
  `SidebarPrototype.ts:439` calls `createWebviewPanel(PIN_PREVIEW_VIEW_TYPE, …, ViewColumn.Active)`.
  A pin detail is **already an editor tab**. So unifying detail and edit moves nothing about where a
  human reads a pin — it is the same consolidation task gets, not a larger one.

  Two consequences ride along. `studio-edit(pin)` currently returns to `returnRoute ?? overview`
  because it had no detail route to return to; under one app that return target becomes the app's own
  read mode. And the manifest's `editorHome` is proven ambiguous — a field read twice in this session
  as "where it opens" when it means "who hosts it". Worth a rename, filed separately.

Also correcting the record: this spec's Open questions claim "the only live standalone editor panel
is `AgentPanePanel`". There are more — `SidebarPrototype.ts:439` (pin preview), `plugins/ui/host.ts`
and `AgentFixtureStudioPanel.ts` all call `createWebviewPanel` today. The grep behind the original
claim missed hosts whose file name does not end in `Panel.ts`.

**Done** means: the twelve Control dashboards and the identity-bearing documents are standalone
editor apps, any two can be open at once, every one of them provably renders through the shared
shell and design system, a hidden app does no work, and Control's single-app machinery is gone.

## Acceptance criteria

_Phase 0 (conformance contract) and Phase 1 (visibility gating) are the prerequisites; they are
listed first because nothing else may land before them._

_The contract has three postures, not two. What fails the build is an **undeclared** departure, never
a declared one — a surface with a real reason to differ must have a supported way to say so, or the
contract will be worked around instead of used._

| Posture | Meaning | Cost to the author |
|---|---|---|
| **Conform** | mounts the shared shell, uses kit + tokens | nothing; the default |
| **Extend** | shared shell, but composes its own regions/controls into it | declare what it extends; first-class, not an exception |
| **Replace** | own shell | declared entry with a non-empty reason, reviewed as a decision |

- [x] **Scenario: an UNDECLARED departure fails the build**
  - **Given** the conformance contract is in place
  - **When** a webview app mounts its own page chrome, or introduces its own chrome/pad/token values,
    without declaring `extend` or `replace`
  - **Then** a test fails and names the offending surface — the failure is mechanical, not a review
    comment
- [x] **Scenario: extending the shell is supported, not tolerated**
  - **Given** a section that genuinely needs chrome the shared shell does not offer
  - **When** its author composes that chrome through the shell's declared extension points
  - **Then** it passes the contract with no exception entry, and the extension it uses is visible in
    the manifest
- [x] **Scenario: replacing the shell is possible and expensive on purpose**
  - **Given** a surface whose needs the shell cannot serve even by extension
  - **When** its author declares `replace` with a reason
  - **Then** the build passes, the reason is recorded next to the surface, and an empty or missing
    reason fails
- [x] The shell offers real extension points, evidenced by at least one section using `extend`
      rather than every section landing on `conform` — a shell nobody can extend is a shell people
      will replace
- [x] The conformance contract covers **every** editor webview surface, not only the ones migrated by
      this spec — declared through the existing `WEBVIEW_SURFACES` manifest (spec 279) rather than a
      parallel inventory
- [x] 410's standing exceptions (sidebar, pin-preview, dev-only spec-350 fakes, plugin surfaces)
      carry forward as explicit entries or are re-justified; none survives implicitly

- [x] **Scenario: a hidden app stops working, not merely stops mattering**
  - **Given** several apps are open and one is visible
  - **When** a `views-changed` event is emitted
  - **Then** the hidden apps run no refresh, no collection, no subscriber callback and post no model
  - _Not "a hidden app costs nothing" — `retainContextWhenHidden: true` keeps an iframe and its
    memory, and codex was right to call the absolute claim false. What must go to zero is the WORK._
- [x] **Scenario: a revealed app is correct, not stale**
  - **Given** an app was hidden while the workspace changed
  - **When** the human brings its tab forward
  - **Then** it shows current state — caught up by delta from the event journal where the window
    covers it, by full resync where it does not, and never by showing stale data

- [x] **Scenario: the motivating capability**
  - **Given** the migration has shipped
  - **When** the human opens the Board and a terminal, or two task details, in a split editor
  - **Then** both are visible and live at the same time
- [x] **Scenario: choosing the project does not rewrite an open document**
  - **Given** a task detail opened from project A, and the sidebar offering the project selector
  - **When** the human switches the selector to project B
  - **Then** the open task detail still shows project A's task — the switch changes what the next
    thing opens against, never what an open document *is*
- [x] The project selector exists exactly once — no per-app copy, no mirror. It lived in the header
      row of the sidebar's Control tab as delivered here; **t-72ff5a moved it up into the sidebar's
      own chrome** (above the search bar, beside the Project Handoff pill) when the selection began
      to scope seven of the sidebar's nine tabs rather than only the next Control panel. "Exactly
      one control" is unchanged and is what both placements are protecting; see the superseded
      decision below.
- [x] **Scenario: the launcher opens apps**
  - **Given** the sidebar Control tab (t-6e2952)
  - **When** the human activates a section tile
  - **Then** that section's app opens as its own editor tab, or is revealed if already open
- [ ] **Scenario: reload restores what was open** — NOT verified, and deliberately left open: the
      headless Dev Host harness dies on `Developer: Reload Window` (t-5fc17d), so half the restore
      question is unreachable by an agent. Needs a human with apps open across editor groups (D21).
  - **Given** several section apps open across editor groups
  - **When** the window reloads
  - **Then** each returns to its tab and its state, using the restore machinery spec 361 established
- [x] **Scenario: a deep link still lands**
  - **Given** an existing `tachyon.*` open-command or a route that today redirects into a Control
    section
  - **When** it is invoked
  - **Then** it opens the corresponding app on the corresponding route, with no dead redirect left
    behind
- [ ] **Scenario: one broken app does not take the others** — MEASURED FALSE and left open on
      purpose. Restoring `errorBoundary.test.ts` in E1 turned this from an assertion into a
      measurement, and 12 of 29 webview mounts have no boundary at all — seven of them real product
      surfaces (the five studio shells, agent-pane, pin-preview). The gap is named and ratcheted in
      that test; t-cd01bb closes it. Marking this today would have been the easy lie.
  - **Given** two section apps open
  - **When** one fails to render or its host path throws
  - **Then** the other keeps working — the isolation that centralization could not offer
- [x] Control's single-app machinery is removed once the last section has moved: the internal
      router, `navEpoch`, the singleton claim, the subroute breadcrumb chrome, and the section tab
      strip (already removed by t-aa2780)
- [x] `docs/specs/410-cockpit-single-app/spec.md` records that its app-count decision was superseded
      here, so a future reader finds the reversal from either direction

## Non-goals

- **The sidebar stays a separate app.** 410 froze it deliberately; nothing here merges it.
- **No visual redesign.** Sections keep the chrome they have; this spec moves where they render and
  what enforces their conformance, not how they look. A section that looks wrong today is a separate
  concern.
- **No new design system.** The existing kit and tokens are the standard, by the owner's explicit
  requirement. This spec makes them enforceable across N apps; it does not replace them.
- **Not the event hub.** t-a8f4a9 (delta push instead of whole-model re-post) becomes more valuable
  under N apps, but visibility gating is what this spec needs and the hub remains its own decision.
- **Approvals and Validations** stay deep-link/compatibility routes, not top-level apps — they are
  already outside `COCKPIT_SECTION_ORDER`.

## Open questions

- ~~**Does each app get its own host panel manager?**~~ **RESOLVED, 2026-08-03** — one generic
  manager, configured from the manifest, never twelve classes. Both consults reached this
  independently. Cardinality is a **parameter**, not a constant: a dashboard is one panel per
  section per project; a document is one panel per identity. Twelve hand-written managers would
  recreate the triplication `StudioPanelManagerBase` was written to end, and would move the
  conformance contract from "inspect a manifest" to "inspect twelve heterogeneous classes".

  Correction to this spec's own premise, found by grok and verified: the "~10 existing standalone
  panels" cited above **do not exist**. `AgentStudioPanel`, `PinStudioPanel`, `CommandStudioPanel`,
  `ActivityPanel`, `ApprovalPanel` and `HandoffPanel` are 13–43 line tombstones with zero
  `createWebviewPanel` calls — 410 retired them too, and what survives is a serializer redirect.
  The only live standalone editor panel is `AgentPanePanel` (470 lines). The road is far less built
  than this spec claimed; `StudioPanelManagerBase`'s *design* is still good evidence, but its
  *dialect* (dirty/save/entity CRUD) must not be pasted onto dashboards that push a model.

- ~~**What is the unit of "app"?**~~ **RESOLVED, 2026-08-03** — one entrypoint per app, all built in
  a **single esbuild invocation with `splitting: true`**, so Preact, the kit and shared utilities are
  extracted into common chunks instead of being copied twelve times. Each app owns its own bootstrap,
  error boundary and CSS.

  The dichotomy in the original question was false and both consults said so, for different reasons.
  Grok: crash isolation is the webview boundary, not the module graph. Codex: a single bundle with
  twelve lazy mounts still shares shell, listener, state and error boundary — that is code-splitting,
  not app isolation. Codex's point decides it, because per-app failure isolation is one of the
  reasons this reversal is worth doing at all. Twelve independent IIFE builds are rejected for the
  reason grok named: they would prevent chunk extraction and reopen 410's budget hole for real.

  The budget test moves with it: `cockpitBundleBudget.test.ts` measures `dist/webview/cockpit.js`
  alone. Its successor measures each app's eager entry and the reachable total, driven from the
  manifest rather than from a hardcoded filename.
- ~~**Where is workspace scope chosen?**~~ **RESOLVED by the maintainer, 2026-08-03.** The selector
  moves out of Overview and into the **header row of the sidebar's Control tab**, in the slot the
  Agents tab already uses for its `All · N` filter. This is the placement neither consult proposed:
  codex argued for "the launcher" without saying where in it, grok argued for each app's own chrome.
  The header row wins because the pattern already exists in the product — it lands as `conform`, not
  as a new component — and because one control cannot diverge from itself the way twelve copies can
  (the divergence t-46eb4f closed).

  Two consequences that ride along, and neither is optional:
  - The scope's authority is the **host**, extracted from `Cockpit.ts`'s module-scoped
    `controlWsHash` into a window-level store the section managers observe. The UI moves; the single
    writer does not become many.
  - **Changing the selector must never retarget an already-open document.** `route.ts:37` already
    treats a task detail's `wsHash` as identity, not preference — a task opened from project A stays
    that task. Without this, two task details side by side silently become different documents when
    the human touches the selector. This is a correctness rule, not a UX preference.

  Accepted residue: the selector is only on screen while the sidebar is on the Control tab. Changing
  project is a rare action, and today it is worse — buried in a section the human may not have open.

  **SUPERSEDED IN PART by t-72ff5a, 2026-08-05 (owner).** The residue stopped being acceptable when
  the scope stopped being about Control. This decision was correct for what the selection did HERE:
  it chose which project the next Control panel opened against, so living inside Control cost the
  human nothing. t-72ff5a made that same selection govern the seven per-project sidebar tabs
  (Agents, Terminals, Pipelines, Schedules, Commands, Runbooks, Pins), and a control that governs
  seven tabs from inside an eighth can only be reached by leaving what it governs.

  What changed: the selector moved out of Control's `.sec-actions` slot into fixed sidebar chrome
  above the search bar, and the Project Handoff pill moved there with it (it had lived in the
  per-folder header, which those seven tabs no longer have). What did NOT change: exactly one
  control, the host as its single writer, and the identity rule below.

  Also removed with it: the **"All workspaces"** option. It kept an aggregate mode in which the seven
  tabs would stack every project under folder headers again, which is the two-regime state t-72ff5a
  exists to end. An unresolved scope now resolves to the first attached project, in the sidebar, in
  `buildCockpitModel` and at every `extension.ts` call site — one rule, applied everywhere, so no
  surface has to write to another to agree with it. The legitimate need to watch every project at
  once belongs to the sidebar's Attentions tab, which stays cross-project by decision (owner,
  2026-08-05): a queue that hides the agent stuck in the project you are not looking at is the one
  thing scoping must never do.
  - `controlWorkspaceScope.test.ts` anchors the selector's testid to `cockpit/App.tsx` and must move
    with it, in the same change. The test is right in spirit (one control, no mirrors) and wrong in
    its anchor once the selector leaves Control. (t-72ff5a re-anchored it a second time, for the same
    reason, when the selector left Control's header for the sidebar chrome — and the testid was
    renamed `control-workspace-select` → `sidebar-workspace-select`, because the old name asserted a
    home the control no longer has.)
- ~~**Does the migration keep both paths alive, or cut over?**~~ **RESOLVED, 2026-08-03** — atomic
  cutover, one surface per PR, mirroring the discipline 410 proved. In the same PR: the app lands,
  the launcher and commands point at it, old restore state and deep links become redirects, and that
  surface's renderer leaves Control. A compatibility shim with **no UI** may survive; two paths that
  render the same surface may not.

  Both consults converged, and both named the same reason: Control's host state is global
  (`panel`, `currentRoute`, `navEpoch`), so a surface living in both places at once means two
  subscriptions, two scope policies and two possible answers to one command. Approvals already wore
  that scar before 410. Rollback of a PR restores that section's Control renderer; it does not
  depend on a permanent dual path.
