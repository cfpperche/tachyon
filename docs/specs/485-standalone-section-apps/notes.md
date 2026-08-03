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

## Deviations

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

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

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
