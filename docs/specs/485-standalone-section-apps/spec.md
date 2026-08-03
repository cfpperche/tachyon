# 485 — standalone-section-apps

_Created 2026-08-02._

**Status:** draft
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

**Done** means: the twelve Control sections are standalone editor apps, any two can be open at once,
every one of them provably renders through the shared shell and design system, a hidden app costs
nothing, and Control's single-app machinery is gone.

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

- [ ] **Scenario: an UNDECLARED departure fails the build**
  - **Given** the conformance contract is in place
  - **When** a webview app mounts its own page chrome, or introduces its own chrome/pad/token values,
    without declaring `extend` or `replace`
  - **Then** a test fails and names the offending surface — the failure is mechanical, not a review
    comment
- [ ] **Scenario: extending the shell is supported, not tolerated**
  - **Given** a section that genuinely needs chrome the shared shell does not offer
  - **When** its author composes that chrome through the shell's declared extension points
  - **Then** it passes the contract with no exception entry, and the extension it uses is visible in
    the manifest
- [ ] **Scenario: replacing the shell is possible and expensive on purpose**
  - **Given** a surface whose needs the shell cannot serve even by extension
  - **When** its author declares `replace` with a reason
  - **Then** the build passes, the reason is recorded next to the surface, and an empty or missing
    reason fails
- [ ] The shell offers real extension points, evidenced by at least one section using `extend`
      rather than every section landing on `conform` — a shell nobody can extend is a shell people
      will replace
- [ ] The conformance contract covers **every** editor webview surface, not only the ones migrated by
      this spec — declared through the existing `WEBVIEW_SURFACES` manifest (spec 279) rather than a
      parallel inventory
- [ ] 410's standing exceptions (sidebar, pin-preview, dev-only spec-350 fakes, plugin surfaces)
      carry forward as explicit entries or are re-justified; none survives implicitly

- [ ] **Scenario: a hidden app stops costing**
  - **Given** several section apps are open and one is visible
  - **When** a `views-changed` event is emitted
  - **Then** only the visible app(s) do refresh work; hidden apps do none
- [ ] **Scenario: a revealed app is correct, not stale**
  - **Given** an app was hidden while the workspace changed
  - **When** the human brings its tab forward
  - **Then** it shows current state — caught up by delta from the event journal where the window
    covers it, by full resync where it does not, and never by showing stale data

- [ ] **Scenario: the motivating capability**
  - **Given** the migration has shipped
  - **When** the human opens the Board and a terminal, or two task details, in a split editor
  - **Then** both are visible and live at the same time
- [ ] **Scenario: the launcher opens apps**
  - **Given** the sidebar Control tab (t-6e2952)
  - **When** the human activates a section tile
  - **Then** that section's app opens as its own editor tab, or is revealed if already open
- [ ] **Scenario: reload restores what was open**
  - **Given** several section apps open across editor groups
  - **When** the window reloads
  - **Then** each returns to its tab and its state, using the restore machinery spec 361 established
- [ ] **Scenario: a deep link still lands**
  - **Given** an existing `tachyon.*` open-command or a route that today redirects into a Control
    section
  - **When** it is invoked
  - **Then** it opens the corresponding app on the corresponding route, with no dead redirect left
    behind
- [ ] **Scenario: one broken app does not take the others**
  - **Given** two section apps open
  - **When** one fails to render or its host path throws
  - **Then** the other keeps working — the isolation that centralization could not offer
- [ ] Control's single-app machinery is removed once the last section has moved: the internal
      router, `navEpoch`, the singleton claim, the subroute breadcrumb chrome, and the section tab
      strip (already removed by t-aa2780)
- [ ] `docs/specs/410-cockpit-single-app/spec.md` records that its app-count decision was superseded
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

- **Does each app get its own host panel manager, or one manager parameterized by section?** The
  ~10 existing standalone panels share `StudioPanelManagerBase`; whether twelve sections need twelve
  managers or one generic one is a plan-level decision with real consequences for the conformance
  contract's shape. Owner: plan.
- **What is the unit of "app"?** Twelve separate bundles reintroduces the bundle-budget problem 410
  solved with one; one bundle with twelve lazy mounts keeps the CSS graph shared but weakens
  isolation. Owner: plan, and it should be decided with the bundle-budget test in hand.
- **Where is workspace scope chosen?** Today the scope selector lives in Overview and every section
  reads it (t-46eb4f). With N apps, one of them owning the selector is odd. Owner: plan.
- **Does the migration keep both paths alive per section during the transition, or cut over?** 410
  migrated one surface per PR with the old panel retired at the end of each; the mirror image here
  is one section per PR with the Control section retired at the end of each. Owner: plan.
