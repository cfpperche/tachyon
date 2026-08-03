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
