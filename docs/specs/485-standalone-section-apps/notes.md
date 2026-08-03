# 485 — standalone-section-apps — notes

_Created 2026-08-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### Phase A — the three extension points are the ones the repo already departs on (2026-08-03)

The plan asked for "named extension points (regions/slots)". A slot vocabulary invented from first
principles would have had zero users on the day it landed, which is exactly the decorative outcome A3
warns about. So the set was derived the other way round — from the departures the seven surviving
surfaces actually ship — and came out at three, each **detectable from source** rather than
honour-system (`SHELL_EXTENSION_POINTS` in `src/webview/shared/shell.ts`):

| Point | What it names | Detected by |
|---|---|---|
| `page-chrome` | the surface styles the page frame itself (`html` / `body`), which `design-system.css` already owns | a selector starting `html`/`body` in `src/webview/<view>/**/*.css` |
| `base-style` | the surface links no `design-system.css` and brings its own base layer | the host's `styles:` / `styleFiles:` list |
| `token-scale` | the surface mints its own `--ds-*` values instead of reading the scale | a `--ds-*:` declaration in its own CSS |

**What is deliberately NOT a point:** the CSP options (`imgBlob`, `connectSrc`, `workerSrc`,
`childSrc`, `frameSrc`, `scriptCspSource`). They are a security axis, orthogonal to design-system
conformance. Folding them in was tried and rejected: it made six of seven surfaces `extend` and left
`conform` meaning nothing.

**Posture distribution after A1** — four conform, four extend, none replace:

| Surface | Posture | Why |
|---|---|---|
| `tachyonSidebar` | extend · `page-chrome` | side-bar surface, not the editor: overrides the DS editor background + page pad |
| `tachyonCockpit` | extend · `page-chrome` | full-bleed `!important` reset of `html, body, #root` so embedded sections can't re-impose a pad |
| `tachyonPinPreview` | extend · `page-chrome` | own `body` baseline + fixed 880px column |
| `tachyonAgentPane` | extend · `base-style`, `token-scale` | links **no** `design-system.css` (Tachyon Mono `@font-face` breaks xterm cell metrics) and therefore mints its own `--ds-1..4` |
| `tachyonPipelineStudio` | conform | dev-only spec-350 fake; mounts via `StudioPanelManagerBase` → shared shell |
| `tachyonAgentFixtureStudio` | conform | dev-only spec-350 fake; its region composition is `StudioFrame`'s four **content** regions (kit usage, not a page-frame departure) |
| `tachyonPluginSurface` / `tachyonPluginSurfaces` | conform | the untrusted part is quarantined behind an opaque-origin `srcdoc` frame; the first-party relay page around it is ordinary kit |

410's four standing exceptions (sidebar, pin-preview, the dev-only spec-350 fakes, the plugin
surfaces) are therefore explicit rows, and being dev-only buys no exemption — both fakes are held to
the contract like anything else.

### Phase A — the declaration is checked in BOTH directions (2026-08-03)

An undeclared departure fails and names the surface; a **declared point nothing uses also fails**.
The second half is what stops `extend` becoming a rubber stamp — without it, declaring all three
points on every surface would silence the contract while looking compliant. It also buys a
non-vacuity guarantee for free: the "declared point is actually used" test passing is proof that
detection really sees the four extending surfaces, so the contract cannot be quietly blind.
### Phase B — where the visibility gate lives (2026-08-03)

`src/webview/shared/panelWorkGate.ts`, one primitive, used by every panel host: the studio manager
base, Control, and the agent pane. It sits at the **manager** layer rather than at `extension.ts`'s
fan-out, because the fan-out has no idea which panels exist or which of them a human is looking at —
`onViewsChanged` dispatches by `ViewKind`, and only the manager holds panels. Gating at the fan-out
would have to answer "is ANY consumer visible", which is the wrong question the moment there is more
than one panel per kind, which is exactly what this spec is for.

The gate exposes its one decision as a pure function (`decideCatchUp`), the same way
`studio/restoreDecisions.ts` does, so the branch that must never be wrong can be read and tested
without a panel, a webview or a clock.

### Catch-up before suppression, and the shape of the journal

The reveal was designed first. t-b51923's real risk was never the storm — it was swallowing the last
invalidation and leaving a view stale forever, and this phase can commit that exact fault one layer
down. So:

- while hidden, each suppressed invalidation is journaled in a bounded window (64 entries,
  ≈27s at the post-t-b51923 rate);
- on reveal with the window intact → **delta**: replay each DISTINCT kind once. Legitimate because a
  `views-changed` carries no payload — it says "this view is stale", never what changed — so N
  identical ones hold exactly the information of one;
- window overflowed, or `WorkspaceClient` reported `resynced`/`engineChanged` while we were hidden →
  **full resync**. We stop claiming to know what changed and rebuild.

The resync branch is not a bespoke path: it is `sendModel()` + `sendSectionModule()`, the exact body
of the shell's own 3s poll. Recovery therefore runs code Control executes twenty times a minute
rather than a branch that only ever fires on reveal.

The upstream-resync branch is wired from `extension.ts`'s subscriber (`markControlSourceResync()`
next to the `refreshAll()` that was already there). Without it, a hidden Control would replay the
three kinds `refreshAll` happens to touch and silently assert it knows what the engine just admitted
it does not.

### `visible`, not `active`

The gate keys on `WebviewPanel.visible`. A panel side by side with the focused one is being looked
at and must keep working — two live surfaces at once is the capability this whole spec buys, and
gating on `active` would have broken it in the same change that enabled it.

### Phase C — the manager's config is a manifest ROW plus one seam, and the seam has four members (2026-08-03)

`plan.md` asked for "one `SectionPanelManager`, configured from the manifest entry". The shape that came
out is `SectionAppConfig = { app: WebviewAppEntry } + declarative surface bits + bind(session) => binding`,
and the two halves are deliberately different in kind:

- everything DECLARATIVE (the manifest row, `styleFiles`, `title`, `iconName`, CSP passthroughs, the shell
  extension points) is data a test can read. That is what keeps the Phase A promise: the conformance
  contract inspects a manifest, not twelve heterogeneous classes;
- everything BEHAVIOURAL is one function, `bind(session) => binding`, and the binding has four members:
  `replay(kind)`, `resync()`, optional `onReveal()`, optional `onMessage()`. Nothing else — no lifecycle to
  implement, no base class to subclass, no save flow to stub out.

`replay` and `resync` are named after `panelWorkGate.ts`'s two catch-up branches on purpose. An app that
implements them has, by construction, implemented its reveal behaviour; there is no separate "catch-up
path" for an author to forget or for a test to be the only caller of. The first model an app ever posts
goes through `replay` too (the `ready` handshake is claimed by `refreshKindFor`), so the catch-up path is
the path that runs twenty times a session rather than one that only fires on reveal.

**What was taken from `StudioPanelManagerBase`, and what was rejected.** Taken: the FORM — a declarative
surface config, a `Map` on a composite key, reveal-on-reopen rather than a second panel, creation through
the shared shell, and a persisted state that is the minimum the serializer needs. Rejected: the DIALECT.
That base speaks `entity`/`patch`/`dirty`/`save`/`cancel`/CAS because a studio edits one record. A section
app is the other thing — the host pushes a model at a screen that reads it — and pasting the studio
vocabulary onto a dashboard would have handed all twelve apps a save flow none of them uses, and put the
conformance contract back in front of twelve different message protocols.

### Phase C — `session.post()` to a hidden panel is DROPPED, and the drop arms a resync (2026-08-03)

Phase B's guard is static: it reads `Cockpit.ts` and fails on a `pushX?.()` outside the sanctioned sites.
That is the right mechanism for one surface with a known set of doors. It is not enough for a CLASS that
ten more apps will be built on, by authors who will not read its doc comment — a static guard can only
know about doors in files it was pointed at.

So the gate here is structural as well as tested. `SectionPanelManager` gives the domain exactly one way to
reach the webview (`session.post`), and that one way asks `gate.visible` first: a post to a hidden panel
posts NOTHING and calls `markSourceResync()`, so the panel rebuilds from scratch the moment someone looks
at it. A bypass therefore cannot reach a hidden webview, and cannot leave it stale either — the two
failure modes the gate exists to prevent — without any test having anticipated that particular bypass.

It also covers the case no static guard would have caught anyway: an async load that STARTED while the
panel was visible and resolves after the tab went behind another one. That is not sabotage, it is the
ordinary shape of `await`, and it is how a hidden panel gets written to in practice.

The static guard is still there (`panelWorkGate.test.ts` gained two cases pointed at this file: every
`entry.binding.*` call sits in a gate option or inside `gate.run`, and there is exactly ONE `postMessage`
site which checks visibility and arms the resync). Fail-before was run for both: injecting
`setTimeout(() => entry.binding.replay(…))` goes red naming `SectionPanelManager.ts:360`, and adding a
second `broadcast` post site goes red naming both offsets. Belt AND braces, because the braces are the
part that scales to apps nobody has written yet.

### Phase C — the CLIENT's own poll is gated by CONFIG, not by trust (2026-08-03)

Phase B's loudest finding was that Control's hidden cost was not the event fan-out at all: it was the
webview's own `setInterval(3000)`, kept alive by `retainContextWhenHidden: true`, running a full collect
twenty times a minute behind another tab. The fix was host-side, in the `case "refresh"` handler.

`SectionAppConfig.refreshKindFor(message)` is that fix generalized: an app declares which inbound messages
mean "refresh me", and the manager routes those through the gate instead of to `onMessage`. The proof
surface deliberately KEEPS a 3s client poll for this reason — it is the thing being defended against, so
it should be present rather than politely omitted, and `sectionPanelManager.test.ts` drives the wire
message a client actually sends rather than the gate object (0.56.159's lesson, the same way
`hiddenPanelWork.test.ts` does).

### Phase C4 — the task detail keeps the `tachyonTaskDetail` viewType, so restore REVIVES instead of redirecting (2026-08-03)

The obvious reading of "the legacy serializer has to open the app" is a new viewType plus a dispose-and-reopen
redirect. C4 does the other thing: the app IS `tachyonTaskDetail`, the viewType SDD 410 retired to a
serializer-only tombstone. Three consequences, all of them better than the redirect:

- a pre-410 window state is handed to `SectionPanelManager.deserialize` and BECOMES the app's panel. Nothing is
  disposed, nothing is reopened, and there is no window in which the human sees a tab close and another open;
- `WEBVIEW_SURFACES` gets its row back under the same id, so the manifest reads as a reversal of 410's
  retirement rather than as a new surface that happens to look like the old one;
- there is no second viewType to leave behind. "No dead path" is structural rather than a thing to check.

The whole compatibility shim is `migrateLegacy` in `TaskDetailPanel.ts`: the old panel persisted
`{wsHash, taskId}` and the manager persists `{project, identity}`, so it renames two fields. No UI, which is
the one kind of shim `spec.md` lets survive an atomic cutover. A legacy record whose fields are missing
migrates to an EMPTY identity, which `sectionPanelKey` refuses — so it disposes, the same outcome the
serializer already gives an unreadable state.

### Phase C4 — the tombstone cache became PER PANEL, and that was a latent singleton assumption (2026-08-03)

Control's task-detail tombstone cache was a single slot with a comment explaining why that was safe: "Control
is a singleton — at most one task-detail route is ever open, so a single slot (not a Map) suffices." True of
Control, false the moment the cardinality is `document`. In the app it is a `let lastKnown` inside `bind`,
which is per panel by construction rather than by a Map someone has to remember to key correctly.

`taskDetailApp.test.ts` covers it directly ("keeps ONE tombstone cache PER PANEL"): two tabs open, one task's
file deleted, and the assertion is that the OTHER tab still shows its own live task. A shared slot renders task
A's last-known state under task B's tab, which is the shape of bug that reads as data corruption to a human.

This is the general lesson of the phase, stated once: every "we are a singleton, so one slot is enough" in
Control is a defect waiting for its section to be migrated. Whoever takes a Phase D section should grep their
surface's host code for a single slot before assuming the move is mechanical.

### Phase C4 — Control keeps the task-detail ROUTE as a redirect, at the one commit point (2026-08-03)

The renderer left `cockpit/App.tsx`, but the route KIND stayed in `route.ts`, and that is deliberate. Three
things still produce one: persisted window state written before this change, a deep link, and
`parentRoute(studio-edit, "task")` — which is Task Studio's breadcrumb, and the one place the repo genuinely
means "back to that task". Deleting the kind would have forced Task Studio's parent policy to change in the
same PR, for reasons that have nothing to do with the task detail.

So `navigate()` — the ONE commit point every navigation intent reaches, by that function's own contract —
turns a task-detail route into "open the document's tab, and commit Mission instead". Every producer gets the
same coherent answer, and Control cannot end up on a route it has no renderer for. Placing it per call site
was rejected for the obvious reason: a redirect each caller must remember is a redirect the next caller
forgets.

The client half is `navigateStudioParent`, a new cockpit action mirroring pin's `navigateReturn` exactly:
the client sends its identity snapshot of the route it was showing and NO destination, the host derives the
destination from `parentRoute(currentRoute)`, and a queued click from a route the human already left is
dropped rather than fired at whatever is current. The breadcrumb used to post Task Detail's own `openTask`
and let Control navigate in place; there is no in-place navigation to that screen any more.

### Phase C4 — a dependency link opens ANOTHER document, it does not retarget this one (2026-08-03)

Control answered a dep-chip click by navigating the one panel to the other task ("a subroute of a subroute
stays a single active route, not a stack" — its own comment, and correct for a singleton). Under `document`
cardinality that is precisely the forbidden move: retargeting an open document is what the identity rule
exists to prevent, and it would make the dep chip a second way to lose the tab you were reading.

So `openTask` opens (or reveals) the OTHER task's own tab, in the SAME project — the dep is a task in this
document's workspace, so the identity it opens against is this document's `project`, never a shell scope.

### Phase C5 — the Board's `view` stayed `mission-control`, and its viewType did NOT (2026-08-03)

The app manifest row is `{ view: "mission-control", viewId: "tachyonBoard", cardinality: "dashboard" }`, and
the two halves were decided for opposite reasons — and the viewType half is the OPPOSITE call from C4's,
which is worth reading together with it.

`view` is the directory and the bundle basename. Keeping `mission-control` means `src/webview/mission-control/`
gained a `main.tsx` beside the `App.tsx` that was already there, and the two stylesheets `esbuild.mjs` already
emits under that basename needed no rename and no repointing in `cockpitCssParity`. Renaming the directory to
`board` would have been a rename touching ~10 files to say the same thing, inside a cutover.

`viewId` had to be NEW. C4 could reuse `tachyonTaskDetail` because 410 had retired that viewType to a
tombstone whose serializer only disposed and redirected — there was nothing live to preserve. `tachyonMission-
Control` is different: it is a LIVE redirect carrying its own persisted shape (`{schemaVersion, view, wsHash}`)
for panels written before 410. Reusing it would have made one viewType mean two incompatible shapes with no
way to tell them apart. So the legacy id stays a dispose-and-redirect — now INTO this app, carrying its
`wsHash` as the project — and `tachyonBoard` is what the live app registers.

**The Phase A cost this section was priced for came out at ZERO.** The Phase A open question warned that
Control's embedded sections style `html`/`body` and that each becomes page chrome its own manifest row must
declare or drop when it goes standalone, naming `mission-control.css` as carrying two such rules. Re-measured
here: t-e085bc had already deleted them, and the sheet mints no `--ds-*` values either. The Board is a
`conform` row and the contract checks it rather than being told. The warning is still live for `activity.css`.

### Phase C5 — `mission` left `COCKPIT_SECTION_ORDER` but stayed a `CockpitSectionId` (2026-08-03)

The first shape tried was to keep `mission` a Control section and simply not render it. That fails
`controlTabsBarRetired.test.ts` immediately and correctly: it renders every id in `COCKPIT_SECTION_ORDER` and
asserts each puts its own heading on screen, so a section with no renderer falls through to the
unknown-section fallback and reads as "Settings". A section list containing something Control cannot render
is a lie the suite already knew how to catch.

So `COCKPIT_SECTION_ORDER` is now, precisely, **what Control renders**, and `mission` moved to the
compatibility list beside `approvals`/`validations`. It stays a `CockpitSectionId` on purpose rather than
being deleted: a persisted `section:"mission"` panel state and a `tachyon.openControl mission` deep link must
still DECODE, or they fall back to Overview and the human silently loses the screen they had instead of being
redirected to it.

That split the launcher's catalog from Control's section list, which had been the same array. `sectionNav.ts`
now owns a `LAUNCHER_ORDER` of twelve — eleven sections plus the Board — with a `standalone` flag on the
tiles that open an app, and a module-level check that every section Control renders has a tile. This is the
shape Phase D repeats ten more times: a migration moves an id from one list to the other and changes where its
tile lands, without moving the tile.

### Phase C5 — the Board's redirect joins C4's, at `navigate()` rather than at nine call sites (2026-08-03)

Nine doors could ask Control for the Board: two commands, the launcher tile, the legacy Board serializer, a
Task Studio serializer's malformed-state fallback, a revived persisted route, Overview's Jump card, Fleet's
action, and a studio exit. Guarding each is nine guards and one that gets forgotten.

The first draft put the guard on `openCockpit`'s two navigation call sites. Rebasing onto C4 showed a better
home, already occupied: C4 had put its own task-detail redirect inside `navigate()`, the ONE commit point
every navigation intent funnels through, with a module-scoped `openTaskDocument` slot bound from `deps` when a
panel is created. C5's is the same three lines beside it (`openBoardDocument`), which means the two redirects
are read together and a third migration has an obvious place to go.

One composition detail that only exists because both landed: C4's redirect used to land Control on
`section("mission")` — the Board — after opening the task's tab. It lands on Overview now. Chaining into C5's
redirect instead would have opened a Board panel on every task-detail navigation, which nobody asked for; a
redirect that opens a surface the human did not request is not a redirect.

The client half is one line in `cockpit/main.tsx`: `onSetSection("mission")` posts the action and skips the
OPTIMISTIC model update every other section gets, because optimistically rendering a section this build has no
renderer for would flash the unknown-section fallback for the frame before the host's real model lands.
Consequence worth naming: `cockpit/App.tsx`'s three "go to the Board" affordances were NOT rewired. They still
call `onSetSection("mission")`, and they still work. The destination moved; the affordance did not.

### Phase C5 — a dashboard's workspace lookup is STRICT, and that is the cardinality (2026-08-03)

Control resolved "which workspace is the board about?" through a fallback chain — preferred, then the shell's
global scope, then the first attached root — because one panel had to answer for whatever scope the human last
chose. `BoardPanelManager` looks its workspace up by exact `wsHash`, because the project IS half the panel's
key. A loose resolution would let two panels land on the same workspace under different keys, or let a panel
silently retarget when the selector moves — which is the rule `spec.md` states for documents and is no more
acceptable for a dashboard. A project that is no longer attached says so on the panel and never borrows
another project's tasks (`boardPanel.test.ts` drives exactly that: open, close the folder, poll).

The liveness scan did NOT move again. `buildMissionVm` + `MissionAgentLists` stayed in
`src/cockpit/missionVm.ts` — a pure function of a workspace target with no Control anywhere in it — and the
new host imports them. Control kept no instance: an unused second coalescing window is a second window waiting
to disagree with the real one.

### Phase C5 — the trailing liveness retry is the ONE new host-initiated door, and it re-enters through the gate

`buildMissionVm`'s `onTrailingRetry` fires when a slow agent-list settles after its 250 ms fallback already
rendered, and it re-posts so real liveness replaces "unavailable". That is a host-initiated push, so it goes
through `session.run("board", …)` rather than calling `send()` directly.

Honest about what proves it: the manager's own structural gate would have caught it anyway — `session.post` to
a hidden panel posts nothing and arms a resync — so an ungated version of this door could not have reached a
hidden webview or left it stale either. Fail-before was run against the mechanism that CAN fail: bypassing
`SectionPanelManager`'s `refreshKindFor` routing (`entry.binding.replay(kind)` instead of
`entry.gate.run(...)`) goes red twice, on the static door guard naming the offending line and on the fixture's
behavioural poll test. `boardPanel.test.ts`'s own poll case was strengthened after noticing it would have
passed on a DEAD door as readily as a gated one: it now asserts the poll IS served while visible before
asserting it is ignored while hidden.

### t-32c872 — the page frame is a SHARED SHEET, and the contract now reads CONSUMPTION (2026-08-03)

The Board shipped standalone (C5) and lost per-column scrolling: one page-long scrollbar, four columns
grown to their content. Cause, already traced in the task: `.col-body { overflow-y: auto }` is the end of a
height chain that starts at `body`, and inside Control the start came from `cockpit.css` (`html, body {
height: 100% !important }`). t-e085bc had deleted the Board's own copy of those rules ON PURPOSE and named
cockpit.css the owner; C5 then moved the Board out from under that owner and linked nothing in its place.

**Where the height lives now: `src/webview/shared/page-frame.css`, LINKED, not copied.** The premise 485
changed is "one app = one page" — a standalone section app IS the editor tab, fills it, and scrolls in its
own regions. That is a property of the shared frame, so it is one sheet an app opts into
(`BoardPanel.ts`'s `styleFiles`), the same way `design-system.css` already owns the body baseline. Linking
a shared sheet is CONFORMANCE, not `page-chrome`: the Phase A scan reads `src/webview/<view>/**`, so the
Board stays `conform` — correctly, because it still styles no page frame of its own.

The sheet deliberately stops at `body`. `#root` stays the SURFACE's own declaration, because that rule is
the observable seam where a surface's layout meets the page frame — and it is the only thing a static
contract can read. Move `#root { height: 100% }` into the shared sheet and every app silently inherits a
chain, there is nothing left in the surface to detect, and the guard below is born green.

**The contract's real gap was the question it asked.** Phase A asks "does this surface DECLARE that it
styles the page frame?". For the Board the answer was no and it was RIGHT — `conform` was an accurate
declaration of a surface that broke anyway. The missing question is the other half: **does it CONSUME page
chrome another sheet provides, and does it link that sheet itself?** A surface can be conforming and still
collapse the moment it stops sitting next to whatever was holding it up. Three tests in
`webviewConvention.test.ts` now:

- a surface whose own CSS gives `#root` a percentage height must LINK a sheet that gives `html`/`body` a
  height (providers are resolved back to their source and read — no name allowlist);
- the mirror: a surface that links `page-frame.css` must actually anchor `#root` to the frame, so the sheet
  cannot become the new blanket (`overflow: hidden` is the WRONG frame for a document surface — it would
  put task detail's reading column out of reach);
- a blind-scan guard: the frame sheet must really provide a chain, and at least one surface must really
  consume one, or the two rules above are asserting nothing.

**Fail-before, both directions** (this session has been bitten three times by a guard that passed because
it was blind — Phase B's static door guard, C1's manager guard, and A5's own scratch surface):

    × a surface that DEPENDS on a root height chain links a sheet that provides it (t-32c872)
      → tachyonBoard: CONSUMES a page-frame height chain but links nothing that provides it —
        src/webview/mission-control/mission-control.css: `#root { height: 100%; min-height: 0; display: flex;
        flex-direction: column; }` resolves against a `body` with no height, so it collapses to content.
        Link page-frame.css (the shared frame) in src/webview/BoardPanel.ts, or stop anchoring to the frame.
        Linked: [codicon.css, design-system.css, vscode-theme.css, mission-control.tailwind.css,
        mission-control.css].

That is RED against the shipped 0.56.164 tree — the real defect, not an injected one — and green once
`page-frame.css` joins the list. The mirror rule was proven red by injecting the sheet into
`TaskDetailPanel.ts` (reverted): *tachyonTaskDetail: links page-frame.css but its own CSS never anchors
`#root` to the frame*. `cockpit` and `sidebar` are consumers too and pass on their own providers
(`cockpit.css`, `sidebar.css`), so the rule is not a one-surface special case.

This is what closes the eight remaining traps: every Phase D section that anchors to the frame either links
the shared sheet or names itself in a failing test.

### t-32c872 — the preview harness could not see this defect class, and now can (2026-08-03)

Worth stating plainly because it explains how C5's two-width visual pass came back clean on a broken
screen, and it is not only the fixture's fault: **the harness rendered `#root` inside its own sized
`#frame` div**, which handed the surface a definite height a real webview's `body` only has when a
stylesheet gives it one. The harness was more generous than the product, so the bug was invisible there by
construction — a fixture with 99 cards would have looked fine too.

`Route.pageFrame` fixes that for surfaces that ARE the page: `preview.ts` collapses `#frame`
(`display: contents`) and puts the measurement size on `<html>`, which is where a real page frame lives.
Measured on the same URL, `?fixture=volume&width=880&height=900`:

| | page scrollHeight / viewport | `.col-body` scrollable |
|---|---|---|
| before (no `page-frame.css`) | **12451** / 900 — one page-long scrollbar | no (clientHeight == scrollHeight == 12343) |
| after | 900 / 900 — the page does not scroll | yes (INBOX 12343, LANDED 9478 inside 792) |

Independent scroll, at 1100: INBOX `scrollTop` 2000, LANDED 600, TRIAGED/ACTIVE/DONE 0, page `scrollY` 0.

Two guards keep the harness honest rather than a note asking the next author to remember: a route linking
`page-frame.css` must declare `pageFrame` (`webviewPreviewRoutes.test.ts`), and the harness's Board CSS list
must equal `BoardPanel.ts`'s, in order (`cockpitCssParity.test.ts` — the same parity that file already holds
Control to). The `volume` fixture (INBOX 99 / TRIAGED 11 / ACTIVE 0 / LANDED 76, the owner's own board on
the day of the report) is committed with the route: ACTIVE stays empty on purpose, because an empty column
beside two tall ones is where a collapsed chain shows.

## Deviations

### C6/C7 — one window scope, resolved only at open (2026-08-03)

`ControlWorkspaceScope` is the single extension-host authority. The sidebar Control header is its visible
writer; Control observes it for the sections that have not migrated yet, and `SectionPanelManager` exposes
`openInCurrentScope` so an ambient selection is resolved once, when a new panel opens. The resulting
`SectionPanelTarget` remains immutable and keyed by project + identity. The explicit C7 test opens task A,
selects project B, then proves A remains A while the next task document opens against B.

The selector is omitted when only one project is attached. With multiple projects it occupies the existing
`.sec-actions` slot and offers the aggregate plus each attached project.

**Evidence:** `ev-2026-08-03T16:27:20.800Z-0`; captures at `.vqa/visual-qa/control-{one,multi}-{880,360}.png`
used viewport and `?width=` together.

**Verdict:** pass — at 880 and 360 the multi-project selector stays aligned and compact without crowding the
launcher; the one-project state adds no control or empty header residue.

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### Phase A — no page-frame "regions/slots" were added; the repo already has regions one layer down (2026-08-03)

`tasks.md` A2 says "named extension points (**regions/slots**)". No page-frame region emitter was
added, and this is a deliberate deviation rather than an omission.

The plan's parenthetical assumed the page frame is where composition happens. In this repo it is not:
the region mechanism already exists one layer down, in `StudioFrame`'s four named **content** regions
(`fields` / `richDoc` / `previewVisual` / `sideActions`, spec 350 T5), and every surface mounts a
single Preact tree into `#root` — a grep for `createPortal` or `document.body.appendChild` across
`src/webview` returns nothing outside `#root`. A `regions: ["banner"]` option emitting empty nodes
would have had **zero** users on the day it landed; that is the decorative outcome A3 exists to
catch, so it was not built.

What the page frame *does* legitimately vary on is the style baseline, the page chrome and the token
scale — so those became the named points, and each has real users today (see Design decisions).

**The honesty check A3 demands, stated plainly:** the points are not decorative. Four of eight
manifest entries land on `extend`, all three points are exercised, and a test
(`the shell's extension points are REAL …`) goes red if a point ever loses its last user or if every
surface ever lands on `conform`. The check is a test, not a promise to re-read this note.

### Phase A — `replace` has no user today, so the rule is tested on synthetic entries (2026-08-03)

All seven surviving surfaces mount through `renderWebviewShell`; none replaces the shell. Rather than
invent a fake `replace` surface to exercise the rule, `postureDeclarationErrors()` was extracted into
`surfaces.ts` as a pure function and the "non-empty reason" rule is asserted directly on synthetic
entries. Otherwise "an empty or missing reason fails" would sit untested until the first surface
needs it — the exact moment it is least likely to be noticed.

### Phase A — four hosts declare in the manifest only, not in the shell call (2026-08-03)

`renderWebviewShell` gained two optional passthroughs, `surface` and `extend`, emitted as
`data-shell-surface` / `data-shell-extends` on `<html>` so a rendered page carries its own
conformance claim. `SidebarPrototype.ts` (both its surfaces) and `AgentFixtureStudioPanel.ts` were
bound. `Cockpit.ts`, `AgentPanePanel.ts` and `StudioPanelManagerBase.ts` were **not**: a sibling
agent held them for Phase B while this landed. `src/plugins/ui/host.ts` was not bound for a design
reason instead — one `renderShell()` serves two viewIds.

Nothing is unguarded meanwhile: the manifest is the declaration of record, the test is the
enforcement, and a host that binds itself and then *disagrees* with the manifest already fails.
Follow-up to bind the rest and tighten the test from "a host that binds must agree" to "every host
binds": **t-4a3333**.

### Phase A5 — fail-before proof of the contract (2026-08-03)

A test that passes because it sees nothing is worse than no test, so the contract was made to fail
first. A scratch surface was added — `src/webview/ScratchDriftPanel.ts` (hand-rolled `<!DOCTYPE>`,
no shell call), `src/webview/scratch-drift/scratch-drift.css` (`body { padding: 17px 21px; … }` and
`--ds-2: 3px`), and a `WEBVIEW_SURFACES` row declaring `posture: "conform"` — i.e. the lie the
contract has to catch. **It was never committed; it is deleted.** Four states were run:

**1. Undeclared (`conform`) → RED, naming the surface:**

```
× an UNDECLARED departure from the shared shell/design system fails and names the surface
  → tachyonScratchDrift: UNDECLARED "base-style" — src/webview/ScratchDriftPanel.ts links [] — no design-system.css.
     Declare posture "extend" naming "base-style" in WEBVIEW_SURFACES, or stop departing.
    tachyonScratchDrift: UNDECLARED "page-chrome" — src/webview/scratch-drift/scratch-drift.css: styles the page
     frame itself — `body { … }`. Declare posture "extend" naming "page-chrome" …
    tachyonScratchDrift: UNDECLARED "token-scale" — src/webview/scratch-drift/scratch-drift.css: defines its own
     `--ds-2` value. Declare posture "extend" naming "token-scale" …
× every surface mounts through the shared shell unless it declares `replace`
  → tachyonScratchDrift (src/webview/ScratchDriftPanel.ts): mounts outside the shared shell — call
    renderWebviewShell, or declare posture "replace" with a reason
× no host emitter hand-rolls a <!DOCTYPE> — only the shared shell may (spec 280)
  → host files hand-rolling <!DOCTYPE> (use renderWebviewShell, or declare posture "replace"): ScratchDriftPanel.ts
```

**2. `replace` with an EMPTY reason → still RED**, on the rule rather than on the drift:

```
× every surface declares a posture, and the declaration is well-formed
  → tachyonScratchDrift: posture "replace" needs a non-empty reason — replacing the shell is a decision,
    and an unexplained one is indistinguishable from drift
```

**3. `replace` with a real reason → GREEN** (`8 passed | 7 skipped`), including the hand-rolled
`<!DOCTYPE>` check: a declared own-shell surface is what the posture buys.

**4. Mounted through the shell + `extend: ["page-chrome", "token-scale"]` → GREEN**, with the host
passing the same set to `renderWebviewShell` — the declared-extension path end to end.

Then the scratch was deleted and the suite re-run clean: `Test Files 1 passed · Tests 15 passed`.
### The `views-changed` fan-out was not the only door (B1)

`plan.md` and the task brief both framed Phase B around `extension.ts`'s `views-changed` fan-out.
Enumerating every path by which a hidden Control could still do work turned up a louder one that the
fan-out never touches: **the client's own 3s poll.** `cockpit/main.tsx` runs
`setInterval(() => post(refreshAction()), 3000)`, and `retainContextWhenHidden: true` keeps that
timer alive behind another tab, so a hidden Control ran `sendModel()` (a collect across every
workspace root, including the classified worktree read on some sections) plus `sendSectionModule()`
**twenty times a minute, forever** — more work than the whole event fan-out put together at the
post-t-b51923 rate.

Gated host-side, in the `case "refresh"` handler, not client-side: the host is where the gate and
the guard already live, and a host-side gate holds no matter what any client version's timer does.

This is 0.56.159's lesson arriving on schedule — that release shipped green tests that changed
nothing in production because the test drove the one door and production used five. Which is why the
guard in `hiddenPanelWork.test.ts` drives the wire message a client actually sends rather than the
gate object.

### The activity feed is paused, not journaled (B1/B2)

The third door, and the second that emits no `views-changed` at all: the agent-activity feed (`src/cockpit/activityFeed.ts`) runs a
1s attention poll and an `fs.watchFile` that reads, rebuilds and posts on every log append, whether
or not anyone is looking.

It is gated through `ActivityFeedIO.paused` rather than through the journal, because the feed already
owns a better journal than the gate could keep: the durable log itself. Hidden, it reads nothing and
its byte offset stays put; on reveal `catchUp()` ingests forward from that offset — a real delta —
and `pump()`'s existing `size < offset` branch is a real full re-prime when the log was truncated
under it. The same delta/resync bargain, arriving from the file rather than from a counter.

Consequence: the gate needed an `onReveal` hook that fires on EVERY reveal, including the one the
journal calls `none`. An activity log can grow while zero invalidations arrive, so hanging its
catch-up off the journal's decision would have left it stale for exactly the case it exists to cover.

### Phase C — the manager lives in `src/webview/shared/`, not `src/webview/` (2026-08-03)

`plan.md`'s file table says `src/webview/SectionPanelManager.ts` *(new)*. It landed at
`src/webview/shared/SectionPanelManager.ts` instead, and this is a correctness deviation rather than taste:
Phase A's contract test resolves "does this surface mount through the shared shell?" by accepting either a
direct `renderWebviewShell(` call in the host file OR an import of a module under `src/webview/shared/`
that makes one (`sharedMountModules()` walks exactly that directory). At the plan's path, every app host
that delegated panel creation to the manager would have failed the contract for mounting outside the
shared shell — while in fact mounting through it. The manager is shared infrastructure and belongs beside
`shell.ts`, `panelWorkGate.ts`, `panelSerializer.ts` and `studio/StudioPanelManagerBase.ts` anyway.

### Phase C — an app manifest SEPARATE from `WEBVIEW_SURFACES`, and `esbuild.mjs` keeps its own copy (2026-08-03)

Two questions needed one source or they would drift — what the manager configures itself from, and what
the budget test measures — and neither is the question `WEBVIEW_SURFACES` answers (conformance posture,
across surfaces that are not apps: a WebviewView, a static preview page, a plugin relay). So
`src/webview/webviewApps.ts` is a second, smaller manifest, and `webviewAppBudget.test.ts` asserts every
app row has a real surface row with the same bundle name, so the two cannot describe different worlds.

The uncomfortable half: `esbuild.mjs` is JavaScript and cannot import a TypeScript module, so it carries
its own `WEBVIEW_APP_VIEWS` array. Three alternatives were weighed and rejected — a JSON file both sides
read (TS would infer `string`, not the literal unions that make a missing `cardinality` a compile error,
and JSON carries no doc comments, which is where this repo keeps its reasoning); transpiling the manifest
in-process inside `esbuild.mjs` (a build that must build itself before it can build); and deriving the
entry list from the filesystem (every `src/webview/*/main.tsx`, which would sweep in surfaces that are not
apps). What is there instead is a test that fails, by name and in both directions, when the two lists
disagree — the same bargain the convention guard already takes when it reads `esbuild.mjs` as text.

### Phase C — the chunk-hygiene roots are DISCOVERED, not named (2026-08-03)

`scripts/webview-chunk-hygiene.mjs` seeded reachability from a hardcoded `["cockpit.js"]`, which was right
while exactly one entry existed. With a multi-entry splitting invocation it becomes actively destructive:
the whole point of one invocation is that the apps SHARE chunks, so a graph rooted only at Control prunes
every chunk another app needs and the package audit then refuses a build that was correct. Roots are now
every top-level `*.js` in `dist/webview` (IIFE bundles are harmless roots — they contain no chunk
references), so an app added to the manifest can never be forgotten here. The chunk prefix moved with it:
`cockpit-` named the one entry that used to exist, and the chunks belong to every app now, so it is `app-`.

`webviewChunkHygiene.test.ts` gained the case that would have caught the old shape: two entries, one chunk
imported only by the second, and a prune that must keep it.

### Phase C4 — the client's identity check is gone, and its absence is the guarantee (2026-08-03)

`cockpit/main.tsx` carried two guards from t-9993cc: clear `taskVm` when the active route's identity changes,
and reject a TASK push whose `wsHash`/`taskId` do not match the current route. Both existed because ONE panel
served every task and a late push from the route you just left could repopulate the screen under a different
one.

The document app has neither, and that is not a simplification to be suspicious of: a document panel IS one
identity for its whole life, the host resolves the task from that panel's own frozen target, and there is no
second identity for a message to belong to. The guard was a client-side patch over a host-side ambiguity that
the cardinality removes.

`cockpitTaskDetailIdentity.test.ts` was a SOURCE SCAN over those two guards, so it went with them. What
replaces it is stronger and behavioural rather than textual: `taskDetailApp.test.ts`'s "an open document is
never retargeted" describe drives the real host with the workspace list REORDERED under an open panel (the
strongest form of a scope change reaching it) and asserts the panel still resolves its own project. A source
scan cannot notice that the property it was guarding moved; a behavioural test cannot pass without it.

`cockpitTaskDetailShellHandshake.test.ts` went the same way, for the same class of reason: it proved that no
Control route handler swallows the shell's READY, using the task detail as its vehicle because
`handleTaskDetailAction` was the handler that once did. That handler no longer exists, and
`cockpitReadyHandshake.test.ts` already asserts the property for EVERY route kind, derived from `route.ts`
rather than transcribed. The app's own side of it is covered where it now lives: the READY handshake IS the
first refresh (`refreshKindFor` claims it), so a freshly opened tab paints through the same path a fan-out
refresh takes — there is no separate load path for a catch-up to diverge from, and no handler is ever offered
the message.

### Phase C4 — three Control tests were RETARGETED rather than deleted, and one new claim was added (2026-08-03)

`cockpitNavPendingBracket.test.ts` measured the routePending/routeReady bracket by driving a Board card click,
because that was Control's most ordinary navigation. It is not a navigation any more. The bracket itself is
unchanged and still matters, so the cases moved to `project-handoff` — a detail route Control keeps — and the
file gained the case the migration actually creates: **a click that opens a DOCUMENT must not emit a bracket
at all.** A pending state for a navigation that never arrives leaves the client in a progress bar forever,
which is a worse failure than the one the bracket was built to fix.

`attentionOpenTaskWhileBoardLive.test.ts` (t-20bbfa) is the guard over "Attention → Open detaches Control".
Its first half became a different claim (a second PANEL, not a changed route); its second half — Control keeps
its panel, its singleton claim and its model flow — survives the migration untouched, because Control is still
a singleton with the same module-scoped wiring. Both are asserted, and the new architecture makes the first
half stronger: the notice cannot disturb Control at all, because it no longer navigates it.

`cockpitMissionBoard.test.ts`'s `openTask` case now asserts the wsHash the Board passes, which is the moment
the document's identity is decided.

### Phase C5 — Phase B's Control measurement lost its exemplar door TWICE (2026-08-03)

`hiddenPanelWork.test.ts`'s "Control does no work behind another tab" block was built on
`refreshCockpitMissionBoard`. C4 deleted `refreshCockpitTaskDetail` and C5 deletes the board's — so the
block was repointed to `refreshCockpitHandoff`, which `onViewsChanged("handoff")` still calls and which is
exactly ONE refresh kind. Validations was tried first and rejected: `refreshCockpitValidations` pushes TWO
kinds (validations AND inbox), which doubles every suppressed count the test asserts.

Nothing about Phase B's finding changed — the gate, the journal, the delta/resync branch and the client-poll
door are the same code, measured through a different section. What the migrated surfaces' gating now proves
lives in `boardPanel.test.ts` and `taskDetailApp.test.ts`, driven through those apps' own doors. That is the
cutover working rather than a gap it left.

Two more were repointed for the same reason and are worth naming so a reader does not read them as weakened:
`cockpitRouter.test.ts`'s three navEpoch cases used the board's slow `listMissionControlAgents()` as the
wedgeable in-flight response and now use Runtime Ops' injectable `buildSnapshot()`; and
`cockpitReadyHandshake.test.ts`'s ordering guard names `handleApprovalAction` as the chain's first link,
having named `handleTaskDetailAction` and then `handleMissionAction` before it — the property under test is
the ORDER, not which handler happens to be first.

### Phase C5 — the C4 merge composed both sides of Cockpit.ts silently, so C5 was REBASED rather than merged (2026-08-03)

Recorded because the failure is invisible and will recur in Phase D, where ten more surfaces leave the same
host. C4 and C5 were built in parallel from the same base and both rewrote `src/webview/Cockpit.ts` heavily —
C4 removing the task-detail renderer, C5 removing the board's. Merging the second onto the first produced NO
conflict and a file LARGER than either side: git saw one branch's deletions and the other's edits in
different hunks and kept both, resurrecting the task-detail push next to the standalone app. Two live
renderers of one screen — precisely what `spec.md` forbids — with not one conflict marker to notice it by. A
`cherry-pick` was worse: it took C5's whole file and dropped C4's deletions in silence.

What shipped: C5 reset to `main` (with C4 in it) and re-applied its cutover by hand against the C4 text,
which is also how its redirect found its way into `navigate()` beside C4's instead of living in a wrapper of
its own. The maintainer verifies it with three greps that must all answer zero —
`resolveBlobUri`, `lastKnownTaskDetail`, `sendMission` in `Cockpit.ts` — because those are the exact symbols
the silent merge brought back. **The lesson for Phase D: two surfaces must not leave the same host in
parallel.** A three-way merge cannot tell "both deleted different things" from "one deleted, one edited", and
no test the two branches share will notice, because each branch is green on its own.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### t-32c872 — where the page frame lives: four candidates, three rejected (2026-08-03)

1. **Copy `html, body { height: 100% }` back into `mission-control.css`.** Rejected, and it is the option
   the task's constraints name explicitly: it is the gambiarra t-e085bc removed, it re-arms the co-load
   bleed (that sheet still co-loads into any Control session that ever showed the board), and repeated per
   section it recreates the dual pad SDD 410 closed and Phase A exists to prevent. Ten copies of a rule are
   ten places for it to drift.
2. **Put the height on `html, body` in `design-system.css`,** the baseline every conforming surface already
   links. Rejected on blast radius and on evidence: pin-preview and task detail are page-scrolling
   documents, and `overflow: hidden` there hides their own content below the fold — changing every surface
   that passes through the shared shell to fix one. It also makes the new guard un-failable: if every
   surface provides the chain, nothing can ever consume one it does not link, and the check is born green.
3. **`#root { position: absolute; inset: 0 }`,** which is how `agent-pane.css` gets a full-height page with
   no `body` height at all. It works and it is genuinely simpler, but it is surface-local again — it solves
   the Board and leaves the other nine to rediscover it — and it leaves the contract nothing to read, since
   "this surface needs the frame" stops being visible anywhere.
4. **Chosen: one shared `page-frame.css`, opt-in per app, with the contract checking consumption.** Given
   up: an app author has to remember one more line in `styleFiles`. Bought: the rule exists once, the
   remembering is enforced by a test that names the surface, and both directions are checked (linking it
   without needing it fails too).

Not done, deliberately: folding `cockpit.css`'s own `html, body` reset into this sheet. Control's reset is
`!important` because it must overpower the embedded sections' sheets it co-loads — a different job with a
different mechanism, and Phase E is already the change that removes it. Merging them now would be a
speculative refactor of the one surface this task must not disturb.

### Phase A — detection reads shipped source, not a runtime hook (2026-08-03)

The strongest possible mechanism would be `renderWebviewShell` itself throwing on an undeclared
departure. It was rejected: the shell would have to import `WEBVIEW_SURFACES` while `surfaces.ts`
imports the point type from the shell (an import cycle), and the shell can only see its own options —
never the CSS files, which is where two of the three departures live. So the shell owns the
*vocabulary* and the test owns the *enforcement*, with the source-scan pattern this repo already uses
(`cockpitCssParity.test.ts` reads Control's link order out of its shell call the same way).

Given up: a departure is caught at test time rather than render time. Bought: the check covers CSS as
well as host options, and there is no cycle. The blind-scan guard (`reads a real stylesheet list for
every surface`) is the safeguard against the source scan silently matching nothing.

### Phase A — surface-owned CSS only, not every sheet a surface links (2026-08-03)

`page-chrome` and `token-scale` are scanned in `src/webview/<view>/**/*.css` — the surface's own
directory — not across every stylesheet it links. Control links a dozen embedded sections' sheets and
would otherwise answer for all of them. See the Open questions entry below for what that leaves.
### Measured before/after (B4)

**Consumer work, `StudioPanelManagerBase.refreshAll()` with 8 panels open and 1 visible:**

| | journal events/s | refresh work/s |
|---|---|---|
| before (every panel refreshes, always) | 3.98 | **31.87** |
| after (hidden panels do nothing) | 3.98 | **3.98** |

Both rows come from one run of `test/unit/hiddenPanelWork.test.ts` ("before/after, producer unchanged
and consumer gated"), which prints them. The producer is the real `DaemonEngineHost` with its real
250ms coalescing window, fed t-b51923's measured storm shape (~15 invalidations/s per running agent ×
2 agents = 1800/min); it emitted 239 `views-changed` in the simulated minute. The consumer is the
real manager driven through the real fan-out door. "Before" is every panel visible, which is
byte-for-byte today's behaviour — nothing in the old code asked about visibility.

**The journal rate is identical in both rows, and that is the result, not a null one.** This phase
changes the CONSUMER; a number that moved there would mean it had reached into t-b51923's producer
fix, which this task explicitly forbade.

What was NOT done, and should not be read into the table: **no live two-agent measurement was
taken.** t-b51923 measured a running engine; no engine daemon is reachable from a change worktree
(no `events/*.jsonl` under any storage root here), and opening an editor window was out of bounds for
this task. The harness above is the honest substitute — real producer, real consumer, synthetic
arrival pattern — and the live number is worth re-taking on the maintainer's machine with Control and
a couple of panes open behind other tabs.

**Control's own hidden cost, by door, per minute behind another tab:**

| door | before | after |
|---|---|---|
| client 3s poll → `sendModel` + `sendSectionModule` | 20 full collects | **0** (1 on reveal) |
| `views-changed` fan-out → `refreshCockpit*` | 1 per event (~239/min at the storm rate) | **0** (≤1 per kind on reveal) |
| activity feed (on an agent-activity route) | 1s attention poll + a read/build/post per log append | **0** (one catch-up read on reveal) |
| agent pane co-attach poll, per open pane | 30 `tmux list-clients` | **0** (1 on reveal) |

### Suppression is per-panel, not per-manager

Each panel carries its own gate and its own journal. Simpler would have been one journal per manager
plus a visible-panel set, but then a panel revealed after a different one had already drained the
journal would come back empty-handed. Per-panel costs one array per open panel and cannot fail that way.

### The window can blow, on purpose

64 entries, so a panel hidden through a genuine storm takes ONE full resync on reveal instead of a
long replay. A journal that deduped kinds at record time would never overflow and the resync branch
would be dead code — a branch that never runs is not a safety net, it is a comment.

### Bundle size, before and after the multi-entry build (C2/C3)

The number a future reader wants is "did putting the app count back cost size?", so here is the whole
comparison in one place. All figures are uncompressed bytes of the real `node esbuild.mjs` output on this
worktree, measured the same way the budget test measures.

| | eager entry | reachable graph | chunks on disk |
|---|---|---|---|
| SDD 410's recorded baseline (`cockpitBundleBudget.test.ts`, gate 350 KB) | ~244 KB | not measured | not measured |
| this worktree, BEFORE C2 (single-entry cockpit target) | **105.1 KB** (107,591 B) | 1.58 MB (1,661,961 B) | 29 files, 1,554,370 B |
| after C2 — `cockpit.js` | **103.5 KB** (105,995 B) | 1.58 MB (1,661,592 B) | 30 files, 1,555,597 B |
| after C2 — `section-app-fixture.js` | **1.9 KB** (1,951 B) | 37.9 KB (38,838 B) | — |

**The headline is the second app's price: ~3.2 KB total** (1,951 B of entry + 1,227 B of new chunk). All
three chunks it reaches are shared with Control — that is the splitting invocation doing exactly what it
was chosen for, and `webviewAppBudget.test.ts` asserts it as a test rather than reporting it as a fact
("proves the apps SHARE chunks"). Twelve independent IIFE builds would instead have copied Preact and the
kit twelve times, which is the concrete shape of the budget hole `spec.md` rejected that option over.

`cockpit.js` did not grow when a second app joined its graph; it got **1.6 KB smaller**. About 0.1 KB of
that is shorter chunk filenames (`app-` replacing `cockpit-` across ~25 references) and the rest is
modules that became shared chunks once there were two consumers. It is a small number and it is reported
as one — the point is the direction, not the magnitude.

**410's ~244 KB is a historical figure, not a measurement taken here.** Control's eager entry has roughly
halved since that baseline was written, for reasons that predate this spec (more of the shell moved behind
lazy imports). The gate carried forward from it is unchanged at 350 KB, now applied PER APP rather than to
the one app that used to exist.

**What is deliberately not gated:** the shipped union (both entries + all 30 chunks = 1.59 MB / 1,663,543
B). A single global ceiling would go red for reasons that have nothing to do with an app's own cost — one
app's growth failing another app's build — and the two per-app budgets plus the shared-chunk assertion
already bound the thing that matters. The number is recorded here so a reader can watch it move.

### Phase C4 — Task Studio's breadcrumb lands on the Board, not on the task's tab (2026-08-03)

Pressing back from Task Studio used to show the task detail inside Control. Now it opens (or reveals) the
task's own tab AND lands Control on the Board — one action, two surfaces, because Control cannot stay on a
studio form it is navigating away from and cannot render the task either.

The alternative was to leave Control on the studio and merely reveal the tab, which is not a "back" at all,
and the other alternative — changing `parentRoute(studio-edit, "task")` to Mission — would have thrown away
the "back to THAT task" intent the repo deliberately encoded (t-610705 D2). What ships keeps the intent and
pays for it with a second surface moving, which is honest about what a two-app world looks like. Worth
re-judging with the maintainer once the checkpoint after C5 has been used for a few days.

### Phase C4 — the attachments grant narrowed from every workspace to one (2026-08-03)

t-4d59d3 forced Control to grant EVERY attached workspace's task-attachments parent as a local resource root
at panel creation, because one panel served every workspace and the grant cannot be re-assigned on a live
panel without recreating its iframe (which is how Control once went permanently blank). A per-identity panel
needs exactly one root, so the app grants only its own document's workspace — a smaller grant, and one the
cardinality makes available rather than one anybody had to argue for.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

### Phase A — embedded section CSS already styles `html`/`body`, and Phase C is where it starts to matter (2026-08-03)

Scanning surface-owned CSS found that sheets belonging to Control's **embedded** sections do the same
thing the contract flags on surfaces: `activity.css` carries 11 `html`/`body` rules,
`mission-control.css` 2. Today they are answered for by `tachyonCockpit`'s single `page-chrome`
declaration and by cockpit.css's `!important` reset, which exists precisely to overpower them — they
are not manifest surfaces, so nothing else asks.

The moment those sections become standalone apps (Phase C–E) each of them owns a real page, that
reset is gone, and every one of those rules becomes page chrome its own new manifest row must declare
or drop. That is the contract doing its job, but it means the migration's per-surface cost is not
zero for these sections. Worth pricing in when Phase C is sequenced rather than discovering it one
app at a time. Owner: whoever takes the first section migration.

### Phase A — pin-preview's `body` block looks like it can simply go (2026-08-03)

`pin-preview.css` re-declares `body` margin / padding / background / colour / font, and
`design-system.css` already sets all five. If that is true, pin-preview drops from `extend` back to
`conform` and the deletion is the cleanest possible outcome of a conformance contract. It was NOT
done here: Phase A moves nothing and changes nothing visually, and a `body` baseline swap is a visual
change that needs the two-width evidence this phase does not produce. Owner: unassigned; small.
### Work that still happens while hidden, and was left alone deliberately

- **The agent pane's tmux data stream.** The pane keeps its `attach` client and keeps writing output
  into xterm while hidden. Suppressing it needs somewhere to hold the bytes, and xterm's scrollback
  IS that somewhere — dropping them loses output, and detaching to avoid them contradicts t-feaaea
  (reattach is a human decision, and a reveal is not one). What WAS gated is the pane's only periodic
  host work: the 2s `tmux list-clients` co-attach poll.
- **`fs.watchFile`'s stat poll (2/s per open activity route).** The feed reads and posts nothing while
  hidden, but the watcher stays armed. Closing it means unwatch/rewatch across visibility, which
  resets the `prev` stat its change detector compares against. Cheap enough to leave; named here so
  it is not mistaken for zero.
- **The sidebar (`SidebarPrototypeProvider.refresh`) is NOT gated, and must not be naively gated.**
  It is the heaviest single consumer — every `views-changed` re-gathers a fleet per workspace root —
  but its push also sets `view.badge`, the attention count on the activity-bar icon, which is visible
  precisely WHILE the view is hidden. Gating it wholesale would freeze that badge: a correctness
  regression wearing a performance win's clothes. Splitting the badge computation from the fleet push
  would make it gateable, and is worth its own task.
- **`PluginSurfaceHost` editor panels** (`plugins/ui/host.ts`) also refresh unconditionally in
  `refreshAll()`. The same primitive applies; out of Phase B's declared scope (`AgentPanePanel` +
  Control), so untouched here.

### Phase B — the door guard is static, and its first cut was blind (2026-08-03, review)

Phase B's behavioural tests prove the four doors it found are gated. None of them would notice a
FIFTH door added later — and Phases C/D exist to add ten apps' worth of refresh paths. That is the
0.56.159 shape exactly: green tests proved the door worked, nothing proved it was the only door.

So `panelWorkGate.test.ts` gained a static guard: every `pushX?.()` in `Cockpit.ts` must sit inside
`pushControlRefresh` or the gate's `resync:` branch, and every `ControlRefreshKind` must have a case.

**Its first cut was itself blind, and the fail-before is what caught it.** It compared
`switchBody.includes(line.trim())`, so an injected `pushMissionBoard?.();` anywhere in the file
matched as a substring of the switch's own `case "mission": pushMissionBoard?.(); return;` — every
bypass passed. Rewritten to match sanctioned sites by OFFSET rather than by line text.

Fail-before, re-run after the rewrite: injecting `pushMissionBoard?.()` into `refreshCockpitProbes`
goes red naming `Cockpit.ts:973` and the fix. Clean tree: 18 passed.

The lesson is the one A5 encodes and this note repeats from the other side: a guard nobody has
watched fail is a guard nobody knows works.

### Phase C — the proof surface is dev-only, and the trusted serializer is therefore only proven in test (2026-08-03)

C1–C3 deliver a mechanism and move no section, so the only app on it today is
`section-app-fixture` — dev-only in exactly the sense spec 350's two studio fakes are: `extension.ts`
never instantiates its manager, no command contributes it, and it is reachable only from its own tests and
the preview harness. Following the precedent those two set, dev-only buys it NO exemption from the Phase A
contract: it is a `conform` row whose CSS is held to the same scan as every shipped surface.

The consequence to be honest about: its `extension.ts` serializer policy is **dispose-only**, because
there is no live manager instance to revive a panel into. `SectionPanelManager` does implement revival (it
persists `project` + `identity` and re-opens on the same key), and that contract is exercised end to end
against a real `registerTrustedPanelSerializer` in `sectionPanelManager.test.ts` — the test registers the
serializer, feeds it the state read back out of the RENDERED page rather than a re-derived copy, and
asserts the revived panel lands on the same key and is not disposed. What is NOT proven here is a real
window reload, which needs an app that ships: **C4/C5 own that**, and D12 owns it at N panels.

### Phase C — the visual pass, and what it was actually good for (2026-08-03)

`plan.md` says every phase after B is visible. C1–C3 is the seam in that claim: no section moved, no
shipped surface changed, `cockpit/App.tsx` was not touched, and the only thing a human can look at is a
dev-only proof surface no user can reach. The two-width sweep was run anyway, and it earned its cost
immediately — not on appearance.

**Anchor, written before the surface was built** (from the task's problem statement, not from what the
screen ended up looking like): *a reader must be able to tell, from the panel alone, WHICH app this is,
which cardinality decided its key, what that key came out as, and how many models the host has pushed —
because that is what makes "two identities are two panels, one dashboard is one panel" observable rather
than asserted.*

Measured at 880 and 360 (`npm run preview:webview` + the agent-browser plugin), all four fixtures
(`document`, `document-second-identity`, `dashboard`, `revealed-resync`). Verdict: it satisfies the
anchor. At 360 the action wraps below the title and the panel key wraps rather than clipping (the failure
mode t-89ecfe caught on Overview); no horizontal overflow at either width.

**What it actually caught, and this is the point:** the first render was BLANK of any model — the app
posted a surface-local `section-fixture/ready` while the preview harness waits for spec 278's SHARED
`READY` before injecting a fixture. Every unit test was green through this, because they drive the host
and the host claims either handshake. A view that never renders in the harness is a view nobody can
screenshot, review, or visual-QA — for C4 and C5 that would have been discovered at their sign-off, not
here. Fixed by using the shared constant, which is what it exists for.

Screenshots were NOT committed: they are work evidence, and `docs/` holds durable documentation rather
than generated images (repository guidance). The route is committed, so anyone can re-take them in one
command: `?view=section-app-fixture&fixture=<name>[&width=360]`.

### Phase C — Control is in the app manifest, and Phase E takes it back out (2026-08-03)

`WEBVIEW_APPS` has a `host` union: `{ host: "section", cardinality }` for the apps `SectionPanelManager`
drives, and `{ host: "control" }` for Control itself. Control is listed because it SHARES the build — it
is the reason the split chunks have a second consumer at all today, and its eager size is the number 410's
budget was written about — but the manager refuses to be constructed over that row rather than defaulting
its cardinality to something nobody declared. When Phase E removes Control, the row goes with it.

### Phase C — the manager gates the doors it OWNS; a host's own timers are still the host's problem

`SectionPanelManager` gates three doors by construction: the fan-out (`refresh`), inbound webview messages
an app claims through `refreshKindFor`, and every post. What it cannot gate is work a host starts on its
own account and never routes through the session — a `setInterval` in the app's host file, an `fs.watch`,
a subscription registered elsewhere. Phase B hit exactly this and answered it per-source (the activity feed
is paused via `ActivityFeedIO.paused`; the agent pane's co-attach poll is armed/cleared on view state), and
the seam for it here is `binding.onReveal` plus `session.visible`. Worth naming because the doc comment
above could be read as a stronger promise than it is: a hidden panel does no work THROUGH THIS MANAGER.
Owner: whoever migrates a section with a periodic host-side source (Fleet and the activity routes are the
candidates), in that section's own PR.

### Phase C — the manager's door guard was bound to one variable name (2026-08-03, review)

C1's guard over `SectionPanelManager` correctly refused a substring match, citing Phase B's blind
first cut. It then matched `/\bentry\.binding\b/` — the exact identifier. An ungated door written
`for (const e of this.panels.values()) e.binding.replay(…)` passed clean; renaming it to `entry`
made the same line go red.

Same failure class as the one it was avoiding, one level up: the guard saw a spelling, not a shape.
Widened to `/\.binding\b/` — any receiver. The allowlist is unchanged, since its entries are exact
call lines and still match.

Fail-before after the fix: the `e.binding` form goes red naming `SectionPanelManager.ts:258`. Clean
tree: 20 passed.

Worth stating because it happened twice in two phases: writing "not by substring" in a comment is
not the same as proving the guard fails. Only the injection tells you which one you built.
### Phase C4 — the empty-body section label is a PRE-EXISTING defect the visual pass surfaced (2026-08-03)

The two-width sweep found `BODYno body` rendering on one line when a task has no body: `.ds-section` is an
inline `<span>` whose `margin-bottom` cannot make vertical space, and `.td-body` — unlike its sibling
`.td-journal` — is not a flex column. It only shows on an empty body, because a rendered `MarkdownView` is a
block and forces the break itself, which is why four of the five preview fixtures hide it.

It is NOT introduced by this phase and was deliberately not fixed in it: `task-detail/App.tsx` and
`task-detail.css` are byte-identical across C4, and neither sheet Control adds that this app does not
(`vscode-theme.css`, `cockpit.css`) carries a `.td-body` / `.ds-section` / `.ds-dim` rule — so Control renders
it the same way today. Filed as **t-fe8ba3** with the reproduce URL, the cause and the candidate one-line fix.

Worth naming as a pattern rather than as one bug: this is the SECOND time the two-width sweep has paid for
itself on something no test would catch, and the first time it caught a defect the migration inherited rather
than created. A phase that "changes nothing visual" is exactly when an inherited defect is cheapest to see.

### Phase C4 — an out-of-order push within one identity is now possible, and is harmless (2026-08-03)

Control guarded its task pushes with `navEpoch`, so a slow `loadTaskDetail` that resolved after a navigation
was discarded. The app has no epoch: two refreshes racing on one panel can post in either order, and the
loser's payload is a slightly older projection OF THE SAME TASK.

That is a deliberate non-guard rather than an oversight. `navEpoch` protected against posting task A's data
under task B's route, and a document panel has no route to change. What is left — a stale-by-milliseconds
render of the task the tab IS — resolves on the next fan-out, and Control had the identical exposure already
(`navEpoch` does not bump on a same-route refresh, by its own contract). Named here so a future reader does
not mistake the absence for something that was forgotten.

### Phase C→D — two branches removing from the same file cannot be three-way merged (2026-08-03)

C4 and C5 both rewrote `src/webview/Cockpit.ts` heavily, each removing its own surface. Merging them:

    C4 alone:  resolveBlobUri x0, 3200 lines   (task-detail push removed)
    C5 alone:  resolveBlobUri x3, 3226 lines   (branched before C4, block still present)
    merged:    resolveBlobUri x3, 3286 lines   ← larger than either

Git reported NO conflict: the deletions and the edits fell in different hunks, so it kept both sides
and resurrected the push C4 removed — two live renderers, the one thing the spec forbids. A
`cherry-pick` was worse: it replaced the file wholesale with C5's copy, dropping C4's removals in
silence. Neither strategy failed loudly; both produced a plausible file.

C5 was re-applied BY HAND onto C4. That pass found a composition defect no merge could have surfaced
either way: C4's task-detail redirect landed on `section("mission")`, correct while mission was a
Control section, and after C5 it means "open a Board tab" on every task-detail navigation. Both that
and `studioExitTarget` now land on Overview — a panel appearing on a CANCEL is a surprise, not a
recovery.

Two rules for Phase D, which removes from this file ten more times:
- sequential on `Cockpit.ts`; a second PR REBASES onto the first, never merges into it;
- verify removals by grep after integrating, not by trusting a clean merge. The three that caught
  this: `resolveBlobUri`, `lastKnownTaskDetail`, `sendMission` — all must be 0.

The orchestration error was mine: the briefs warned both agents about `cockpit/App.tsx` and said
nothing about the HOST they both had to gut.
