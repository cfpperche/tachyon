# 278 — webview-preview-all-views

_Created 2026-06-27._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-27 (resumed after specs 279/280). The multi-view preview harness now spans ALL 9
Tachyon webview surfaces — every converted view (sidebar/plugins/activity/probes/inspector/agent-studio/pin-preview/
handoff/pin-studio) has a route + provenance-labeled fixtures + a shared-envelope makeMessage, so `visual-qa` can
target any surface. Slice 1 (sidebar/plugins/activity) shipped pre-pause (Lanes A–C); the rest were onboarded as
their panels converted (probes/inspector/agent-studio/pin-preview in spec 279, handoff in spec 280, **pin-studio
here** — the last view). Lane D landed: a GENERATED route catalog (`buildCatalog` → `scripts/webview-preview/
routes.json`, 23 entries) + a smoke test that keeps it in sync, asserts every route resolves to a real view+fixture+
esbuild bundle, and asserts the catalog spans all 9 surfaces. Verified: full suite 1727 green, typecheck/build/
engine-boundary clean; a LIVE agent-browser sweep confirmed all 9 views render a non-empty root (265–749 chars).
DEFERRED (out of scope, unchanged): the named-surface→route DISCOVERY (spec 277 "passo 2") that CONSUMES this
catalog. The harness ↔ shell stay deliberately separate (the harness injects via its own page; the real panels use
renderWebviewShell) — activity/pin-studio's vendor bootstrap is a real-panel-only path, fine for the fixture renders.

> **Origin (owner, "passo 0"):** spec 274 built a preview harness that renders ONE Tachyon webview — the sidebar —
> standalone at a URL, so `visual-qa` can screenshot it. But Tachyon has FIVE webviews; the owner's actual Visual-QA
> pain ("the buttons in the extension are inconsistent — misaligned glyphs, icon sizes, spacing") lives in the OTHER
> views (the Agent Studio / activity tabs, the Plugins drawer). visual-qa today literally cannot reach them — there's
> no URL. This spec "prepares the stage for ALL the Tachyon views": generalize the harness so every webview renders
> standalone, and EMIT a machine-readable route catalog the deferred v2 discovery (spec 277's "passo 2") will consume.
>
> **Codex dueto (2026-06-27) — NEEDS-REVISION, folded.** Two material fixes + scope cut: (a) the contract-drift guard
> as first drafted was INSUFFICIENT — importing a view's VM type catches VM-shape drift but NOT envelope-`type`-string
> drift (host renames `{type:"plugins"}`→`{type:"pluginState"}` and the harness still typechecks while lying); the fix
> is a SHARED exported message-envelope type / constructor per view, imported by host sender + webview listener +
> harness injector, so the route table never spells a raw type string. (b) build-vs-buy must be DOCUMENTED, not
> implied (Storybook/Ladle/Histoire preview COMPONENTS; this previews built webview ENTRYPOINTS under host-message
> contracts + real CSS/CSP/vendor assets — a different problem). (c) Narrow the first slice to sidebar + plugins +
> activity (don't claim "all 5 render"). Plus: fixture PROVENANCE labels + a host-shape test per view; a generated
> (not hand-maintained) minimal catalog + a smoke assertion; LAZY per-view CSS extraction with a link-order check; a
> ready-HANDSHAKE replacing the post-10× race; an explicit CSP/fonts/vendor-bundle fidelity checklist.

## Intent

Generalize the spec-274 sidebar-only preview harness into a **multi-view** harness, driven by a per-view **route
table**, that renders a Tachyon webview standalone at a parameterized URL (`?view=<v>&fixture=<f>`), each fed a
per-view fixture over its OWN `postMessage` contract — so `visual-qa` (and any future visual tooling) can target a
Tachyon surface beyond the sidebar.

**First slice (this spec): `sidebar` + `plugins` + `activity`.** The route-table abstraction lands now and is PROVEN
by two non-sidebar views (so it isn't speculative); `handoff` + `pin-studio` are onboarded later (a follow-up) once
their fixtures + CSS + vendor assets are real — they are NOT claimed as rendering here.

Also emit a generated **route catalog** (`view → harness-url + fixtures`) as the machine-readable contract that the
deferred named-surface→route DISCOVERY (spec 277 OQ / "passo 2") consumes. **This spec produces the catalog; it does
NOT build the discovery.**

## Build-vs-buy decision record (folded from Codex)

**Decision: hand-rolled harness, NOT Storybook/Ladle/Histoire.** Those tools preview *components* in isolation —
they'd require wrapper components + a mocked VS Code host context, recreating exactly the FICTION this harness avoids.
What visual-qa needs is the REAL built webview entrypoint (`dist/webview/<view>.js`) running standalone under (1) the
view's actual host-`postMessage` contract, (2) the real panel CSS/CSP/`asWebviewUri` asset set, and (3) the real
vendor bundles (mermaid/katex/excalidraw) — i.e. the production iframe, minus VS Code. A story tool models none of
those faithfully; adopting one would add a dependency + a mock layer AND still not let visual-qa judge the real
surface. The existing harness already does (1)+(2) for the sidebar at ~70 lines; generalizing it is cheaper and more
faithful than buying. (Revisit only if a 3rd+ consumer needs an addon ecosystem this can't cheaply provide.)

## What this is (and is NOT)

- It is **dev/test substrate** — the same nature as today's harness: a `node scripts/webview-preview/serve.mjs` thing, NOT shipped in
  the `.vsix`, NOT a user-facing runtime. It exists so an agent can screenshot a real bundle at a real URL.
- It is **NOT** the named-surface→route discovery (that's a separate spec — passo 2 — which reads the catalog this
  spec emits), **NOT** a visual-regression / pixel-diff gate, **NOT** a redesign of any view.

## What already exists (grounding)

- esbuild already builds each view as its own browser bundle → `dist/webview/<view>.js` (sidebar/activity/handoff/
  plugins/pin-studio), plus on-demand vendor bundles (mermaid/katex/excalidraw).
- Every view's `main.tsx` already guards `acquireVsCodeApi` (`typeof … === "function" ? … : undefined`), so
  **standalone it runs with `vscode === undefined`** and posts `{type:"ready"}` as a harmless no-op. Each listens for
  a view-specific host message:

  | view | message contract (host → webview) | standalone initial state |
  |---|---|---|
  | sidebar | `{type:"fleet", fleets:[FleetVM], prefs}` | renders `SAMPLE` (the only view with a built-in sample) |
  | activity | `{type:"activity", vm, prepended?}` + `{type:"imageData", id, dataUri}` | EMPTY (renders nothing until pushed) |
  | handoff | `{type:"handoff", vm}` | `undefined` (empty until pushed) |
  | pin-studio | `{type:"pinStudio", vm}` (+ `error`/`attachmentStored`) | `undefined` |
  | plugins | `{type:"plugins", vm}` / `{type:"consent", vm}` / `{type:"busy"}` / `{type:"result"}` | `undefined` |

- The harness already has the injection-race pattern (post the message ~10× until the view's `useEffect` listener
  mounts), the fail-loud empty-root + page-error banner, and a `?fixture=` param. It is just hard-wired to the
  sidebar (links `sidebar.css`, frames at 340px, posts only `{type:"fleet"}`).
- **CSS reality:** each panel links `codicon.css` + `design-system.css` (shared), but its **panel-specific styles are
  INLINE `<style>` inside the `*Panel.ts`** (the `/* spec 252 — panel-specific deltas */` blocks). Only the sidebar
  was extracted to a shared `sidebar/sidebar.css` (spec 274) precisely so the harness + the real webview share ONE
  source. The harness can only render a view faithfully if that view's styles are reachable as a stylesheet.

## Design

1. **Per-view route table (the core).** A declarative map: `view → { bundle, cssLinks[], makeMessage(fixture),
   frame:{w,h}, vendor?[] }`. The harness reads `?view=`, links that view's CSS, loads its bundle (+ vendor), waits
   for the ready handshake (design #6), then posts `makeMessage(fixture)`. Unknown view/fixture → fail loud (existing
   pattern). The table is the SINGLE source the catalog is generated from.

2. **Contract-drift guard — SHARED message envelope, not just the VM type (folded; the "logic in the vscode layer
   escapes CI" lesson).** The inject contract DUPLICATES the host→webview protocol; importing only `PluginsViewModel`
   catches VM-shape drift but NOT an envelope rename (`{type:"plugins"}`→`{type:"pluginState"}` still typechecks while
   the harness lies). FIX: each onboarded view exports a shared message-envelope type + a constructor/constant
   (`PLUGINS_MSG = "plugins"`, `makePluginsMessage(vm): PluginsHostMessage`), imported by the host sender, the webview
   listener, AND the harness `makeMessage`. The route table must never spell a raw `type` string except through those
   shared defs — so any envelope/VM drift breaks the harness BUILD (typecheck), not a screenshot. (Where a view lacks
   such a shared envelope today, introducing it is part of onboarding that view.)

3. **Per-view fixtures, with PROVENANCE (folded).** Each fixture is a complete VM (all REQUIRED arrays satisfied — the
   spec-275 lesson: a base FleetVM missing `commands/runbooks/pins` crashed the bundle). A hand-authored VM that
   diverges from what the host actually pushes makes visual-qa judge a FICTION, so each fixture is LABELED by
   provenance: `sample-derived` | `unit-fixture-derived` | `captured-host-vm` | `synthetic-edge`. Canonical
   default/loaded states REUSE the view's existing `SAMPLE`/unit-test fixture module (imported, not re-typed);
   `synthetic-edge` is allowed only for edge/empty states and must be labeled. Each onboarded view also gets ≥1
   host-side serialization/shape test asserting the real host VM matches the fixture's shape.

4. **CSS extraction — LAZY, per onboarded view, order-checked (folded).** Each panel's panel-specific styles are
   inline `<style>` in `*Panel.ts`; only the view being onboarded gets its block extracted to a shared
   `<view>/<view>.css` linked by BOTH the panel `getHtml` and the harness (esbuild copies it to
   `dist/webview/<view>.css`). Do NOT mass-move all four — that's untested churn risking load-order/CSP/`asWebviewUri`
   regressions. Preserve the EXACT link order (`codicon → design-system → panel-specific → script`); guard it with a
   real-panel HTML snapshot/link-order check + the harness render check (so the extraction provably doesn't change the
   real panel's rendering).

5. **Route catalog emission — generated, minimal (folded).** GENERATE (never hand-maintain) a `routes.json` from the
   route table with a MINIMAL schema: `[{ view, fixture, url, frame, tags? }]` — no descriptions, no discovery
   aliases, no visual-qa policy (passo 2 adds named-surface mapping). Back it with a smoke assertion: every catalog
   route returns a non-empty root (the fail-loud contract, mechanized).

6. **Ready handshake, not a post-race (folded).** Each view already posts `{type:"ready"}` on mount. The harness waits
   for that `ready` message, THEN injects `makeMessage(fixture)` once — deterministic, no flaky 10×-post race (which
   produced intermittently-empty screenshots). Keep a bounded timeout → fail loud if `ready` never arrives.

## Fidelity checklist (folded — the harness must not pass while the real webview would fail)

Per onboarded view, prove (or explicitly exclude the dependent fixture state):
- **CSP:** the real webview runs under a strict nonce'd CSP (`script-src 'nonce-…'`, `style-src webview.cspSource`).
  The harness need not replicate the CSP, but it MUST load the same stylesheet/script SET in the same order — a view
  that only works via inline style under CSP must be proven to also work as an external stylesheet.
- **Codicon + fonts:** confirm codicons/fonts render (not missing-boxes) at the harness URL — a font that loads in VS
  Code but 404s on localhost makes visual-qa judge noise.
- **Vendor bundles:** activity's on-demand mermaid/katex and pin-studio's excalidraw are NOT ordinary CSS/JS. The
  route table declares per-view `vendor[]`; a fixture state that needs a vendor asset either loads it explicitly or is
  EXCLUDED from acceptance (and the exclusion is logged, not silent). For the first slice, activity fixtures avoid
  mermaid/katex-dependent content unless the vendor load is proven.

## Acceptance criteria

- [x] **First-slice views render standalone:** `?view=<v>&fixture=<f>` for EACH of `sidebar`, `plugins`, `activity`
  loads the real bundle and renders a non-empty, correctly-styled surface (fail-loud if a bundle doesn't hydrate).
  `handoff`/`pin-studio` are NOT claimed here.
- [x] **Per-view injection via shared envelopes:** each view receives its OWN message contract through a SHARED
  exported envelope type/constructor (not a raw `type` string in the route table); a `type`-rename or VM-shape change
  breaks the harness BUILD (typecheck), not a screenshot.
- [x] **Ready handshake:** the harness waits for the view's `{type:"ready"}` then injects once (deterministic); a
  missing `ready` within a bounded timeout fails loud.
- [x] **Faithful CSS, lazy + order-checked:** each onboarded view links the same stylesheet set as the real panel, in
  the same order; its panel-specific styles come from a SHARED `.css` (no inline-vs-harness drift), guarded by a
  link-order check on the real panel's HTML.
- [x] **Fixtures complete + provenance-labeled:** each fixture satisfies its view's required VM fields (no
  missing-array crash), reuses the view's `SAMPLE`/unit fixture for canonical states, and carries a provenance label;
  each onboarded view has ≥1 host-shape test tying the real host VM to the fixture shape.
- [x] **Generated minimal catalog + smoke:** a `routes.json` is GENERATED from the route table (`view, fixture, url,
  frame, tags?` only) and a smoke test asserts every catalog route returns a non-empty root.
- [x] **`visual-qa` reaches a non-sidebar surface:** the harness serves the Plugins drawer (and an activity tab) at a
  URL that visual-qa's `config.routes` / invocation can target.

## Open questions — RESOLVED (Codex dueto 2026-06-27, leans folded)

- **OQ1 — scope/sequencing:** **incremental.** Land the generalized route table + `sidebar` + `plugins` + `activity`
  now (two non-sidebar views PROVE the abstraction); `handoff`/`pin-studio` are a follow-up, only claimed when their
  fixtures/CSS/vendor are real. Do NOT keep "all 5 render".
- **OQ2 — fixture source of truth:** **reuse + label.** Reuse each view's `SAMPLE`/unit fixture for canonical states
  (import the same module the tests use); dedicated `synthetic-edge` fixtures only for edge/empty states, always
  labeled by provenance.
- **OQ3 — CSS extraction breadth:** **lazy per onboarded view**, with a real-panel link-order check — never a mass
  move of untested styles.
- **OQ4 — catalog format + ownership:** **generated from the route table**, minimal schema only; no hand-maintained
  manifest, no discovery aliases (passo 2 adds those).
- **OQ5 — non-React panels:** **defer** (AgentForm/ProbeResultPanel/ServerInspector — a different harness class, not
  the owner's pain; revisit on demand).

## Non-goals

- The named-surface→route DISCOVERY (spec 277 "passo 2") — this spec only EMITS the catalog it will read.
- `handoff` + `pin-studio` onboarding (a follow-up once their fixtures/CSS/vendor assets are proven).
- Shipping the harness in the `.vsix` / any user-facing runtime (dev/test substrate only).
- Visual-regression / pixel-diff baselines (visual-qa judges vs written intent, not a pixel oracle).
- Native/desktop surfaces or the non-React inline panels (OQ5 defers the latter).
- Replicating the real webview's CSP (the harness matches the asset SET + order, not the nonce policy).
- Any redesign of a view (this stages the views AS-IS for QA; fixing the button inconsistency is the follow-up this
  unblocks).
