# 279 — webview-preact-unification

_Created 2026-06-27._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-27. All 4 inline-HTML panels converted to the preact-bundle convention; the
inline-HTML class is gone (9/9 surfaces converted). Lanes: **A** substrate (`shared/shell.ts` renderWebviewShell +
`surfaces.ts` manifest + the convention guard as a unit test — proven to catch a premature converted-flag);
**B** probes (`ProbeResultPanel` 154→85 ln, preact-live read-only); **C** inspector (`ServerInspector` 365→169 ln,
the both-directions envelope pattern); **D** Agent Studio (`AgentForm` 753→252 ln — the dominant risk + the
original button-pain surface, full 5-tab form ported, formLogic.ts reused unchanged); **E** pin-preview
(security-hardened: `enableScripts:false`→true is SAFE via preact text-escaping + strict CSP + a hostile-fixture
injection proof showing 0 injected script/onerror DOM); **F** guard flipped to fully enforcing (empty allowlist →
a new inline panel fails CI). Each converted surface has a shared message envelope, extracted CSS, an esbuild
entry, and a harness route+fixture+test (Agent Studio finally `visual-qa`-reachable). Removed the obsolete
agentStudio inline-`<script>`-integrity test (that bug class is gone). Verified per lane + final: full suite 1712
green, typecheck/build/engine-boundary + convention guard clean; every surface live-rendered via agent-browser
(faithful, interactive round-trips proven). Commits: `973a63b` `64989fc` `cc8774a` `4b60f76` `5730dab`.

**Deviation from the dueto (recorded):** the guard discriminates on `acquireVsCodeApi` (the precise inline-logic
tell) + manifest coverage rather than forcing all 9 host files through `renderWebviewShell` — lower risk (the 5
pre-existing panels keep their bespoke CSPs, e.g. excalidraw's worker-src), no false-positive on activity's legit
mermaid/katex bootstrap `<script>`. The shell helper is used by the 4 NEW conversions; migrating the 5 existing
panels to it is a documented follow-up. The guard is implemented as a vitest test (rides CI, no tsx dep) rather
than a standalone `check:webview-convention.sh`.

**Resumes:** spec 278 (PAUSED) — now every surface is harness-able, so its Lane D catalog/smoke spans all 9.

> **Origin (owner):** Tachyon's webview UI is built two ways with NO enforced boundary — most surfaces are preact
> bundles (sidebar/activity/handoff/plugins/pin-studio), but four are hand-written inline-HTML panels
> (Agent Studio, inspector, probes, pin-preview). It's not "old vs new" (the inline `ProbeResultPanel` is the
> NEWEST panel of all). The split is part principle (simple panels skipped the bundle), part drift (no rule). Two
> consequences bit us: (1) the spec-278 preview harness + `visual-qa` ride the preact contract, so the inline panels
> — including **Agent Studio, the very surface whose button inconsistency motivated this work** — are unreachable;
> (2) the inconsistency is a maintenance tax. **Pause the spec-278 roadmap. Convert EVERYTHING to preact now, and
> codify the convention so the split can't recur.**
>
> **Codex dueto (2026-06-27) — SHIP-WITH-CHANGES, folded.** The decision to unify is NOT reopened; the plan tightened:
> (a) one convention, **two modes** — `preact-live` (handshake + listener + actions) and `preact-static` (render-once,
> no listener, no inbound actions) — so static panels (probes, pin-preview) aren't burdened with a message loop, WITHOUT
> reintroducing the split (same bundle shell, fixture route, CSS path, VM shape, guard). (b) `pin-preview` runs
> `enableScripts:false` by THREAT-MODEL choice (renders user pin text); flipping scripts-on is a real regression — it gets
> an EXPLICIT security decision (strict-CSP text-only conversion, OR a no-client-JS static artifact, OR a documented
> guard-allowlisted exception), never an implicit "confirm". (c) Agent Studio parity proof must cover HOST ROUND-TRIPS
> (cwd picker, kind inference, error display), not just "existing unit tests green". (d) the convention guard is a shared
> shell helper + a surface manifest + targeted forbidden-pattern checks, NOT a brittle `<!DOCTYPE` grep. (e) revised lane
> order: guard skeleton → probes → inspector (teaches the envelope) → Agent Studio (hardest) → pin-preview (after the
> security decision) → enforce → resume 278.

## Intent

Make EVERY Tachyon webview surface render through the SAME convention — a preact bundle fed a pure view-model over a
shared host↔webview message envelope (the spec-278 Lane A pattern) — and ELIMINATE the inline-HTML class entirely.
Then encode the convention as an enforced check so a future panel can't silently reintroduce the split.

Outcomes:
- One UI architecture (no "is this panel preact or inline?" coin-flip).
- The spec-278 harness + `visual-qa` reach every surface for free (Agent Studio finally QA-able — the original goal).
- A mechanical guard so the convergence holds.

## Inventory (the complete map)

Nine webview surfaces. Five already conform; four are the work.

| # | surface | panel id | current | interactivity | convert? |
|---|---|---|---|---|---|
| 1 | sidebar | `tachyonSidebar` (view) | preact `sidebar.js` | live | ✅ already |
| 2 | activity | `tachyonActivity` | preact `activity.js` | live | ✅ already |
| 3 | handoff | `tachyonHandoff` | preact `handoff.js` | editable | ✅ already |
| 4 | plugins | `tachyonPlugins` | preact `plugins.js` | flows | ✅ already |
| 5 | pin-studio | `tachyonPinStudio` | preact `pin-studio.js` | rich editor | ✅ already |
| 6 | **Agent Studio** | `tachyonAgentStudio` (`AgentForm.ts`, 753 ln) | inline HTML + inline `<script>` | **interactive** (validation, cwd picker, kind inference, errors) | ➡️ **convert** |
| 7 | **inspector** | `tachyonServerInspector` (`ServerInspector.ts`, 365 ln) | inline HTML + inline `<script>` | **interactive** (live model push, capture) | ➡️ **convert** |
| 8 | **probes** | `tachyonProbes` (`ProbeResultPanel.ts`, 154 ln) | inline HTML | **static** (read-only result table) | ➡️ **convert** |
| 9 | **pin-preview** | `tachyonPinPreview` (`SidebarPrototype.previewPin`) | inline HTML, `enableScripts:false` | **static** (read-only pin) | ➡️ **convert** |

## One convention, two modes (folded from Codex)

All surfaces share ONE architecture (bundle shell + VM shape + fixture route + CSS path + convention guard). They differ
only in RUNTIME contract — and that difference is declared, not ad-hoc:

- **`preact-live`** — ready handshake + a host→webview message listener + webview→host actions. For the live/interactive
  surfaces (Agent Studio, inspector, + the 5 existing).
- **`preact-static`** — a render-once entry: one initial VM (embedded or a single host post), render, NO continuing
  listener, NO inbound action protocol. For read-only surfaces (probes, and pin-preview if converted with client JS).

This is NOT the old split (inline-HTML vs bundle); it's the SAME bundle architecture with a lighter runtime contract, and
both modes pass the same convention guard. The mode is a field in the surface manifest (below).

## What "converted" means (the per-surface contract)

Each converted surface lands the spec-278 Lane-A shape, so it's indistinguishable from the existing preact views:

1. **Pure view-model** (`src/<area>/…ViewModel.ts`): all display/derivation logic, no vscode — unit-testable. (Some
   already exist as pure helpers, e.g. `formLogic.ts` for Agent Studio — reuse, don't rewrite.)
2. **Preact App** (`src/webview/<view>/App.tsx`) rendering the VM; **`main.tsx`** entry — `preact-live` adds the
   `acquireVsCodeApi` guard + ready-handshake (`signalReady`) + listener; `preact-static` renders the injected VM once.
3. **Shared message envelope** (`src/webview/<view>/messages.ts`): for `preact-live`, the host↔webview `type`s +
   constructors in BOTH directions, imported by the host sender, the webview listener, and the harness (drift breaks the
   build). The interactive panels' existing protocols (Agent Studio: `kindInferred`/`cwd`/`errors` + inbound `pickCwd`/
   `submit`/`inferKind`; inspector: `model`/`init`/`capture`) are formalized here. `preact-static` surfaces have only
   the initial VM contract — no inbound protocol.
4. **Extracted CSS** (`src/webview/<view>/<view>.css`) shared by the panel + the harness; esbuild copies it.
5. **Shared shell helper:** the host `*Panel.ts` emits its HTML ONLY via `renderWebviewShell({viewId, script, css,
   nonce, csp})` (the single place a `<!DOCTYPE>` lives) and becomes a thin shell (createPanel + shell + post the VM) —
   the "logic in the vscode layer escapes CI" surface shrinks to near-zero.
6. **esbuild entrypoint** → `dist/webview/<view>.js`.
7. **Harness wiring** (spec 278): a route + provenance-labeled fixture + a fidelity/host-shape test; `visual-qa` can now
   target it.
8. **Behavior parity** — proven, not assumed (folded from Codex). Existing unit tests stay green (logic relocated, not
   changed) AND:
   - a preact **component test** (fake `vscode.postMessage`) for the App's rendering/branches;
   - for `preact-live`, **host-adapter tests** for each inbound round-trip (the thin `*Panel.ts` handlers);
   - a **DOM/screenshot parity fixture** per surface so the faithful port can't silently churn the visuals;
   - for interactive surfaces, an e2e/harness path proving the round-trips (invalid submit, valid submit, cwd-pick
     request → response applied, kind-inference update applied, host error displayed). "Existing unit tests green" alone
     is NOT sufficient proof.

## pin-preview security — an EXPLICIT decision, not an implicit "confirm" (folded from Codex)

`pin-preview` runs `enableScripts:false` TODAY by deliberate threat-model choice: it renders pin content that can include
arbitrary user text/attachments. A preact bundle needs `enableScripts:true`, which is a real regression UNLESS hardened.
Decision rule for this surface:

- **Preferred — convert as `preact-static`, text/structured-safe:** pin body + attachments rendered as TEXT or structured
  preact components (preact escapes by default), with NO `dangerouslySetInnerHTML`, NO unsanitized markdown→HTML, NO inline
  scripts/handlers/remote scripts, and a STRICT CSP (`script-src 'nonce-…'` bundle-only, no broad `script-src`). Proven by
  injection tests with hostile pin text (`<img onerror=…>`, `<script>…`, `javascript:` URLs).
- **Fallback — keep scripts OFF:** if the hardening above can't be cleanly met, pin-preview stays a no-client-JS rendered
  artifact (a static HTML render of the safe VM with scripts disabled) OR remains the single DOCUMENTED guard-allowlisted
  exception. Either way the decision is recorded in this spec + the manifest, never left implicit.

CSP is an ACCEPTANCE criterion for EVERY newly-scripted surface, not just this one.

## Anti-recurrence — the convention guard (folded from Codex: not a doctype grep)

The root cause is an UNwritten convention. The guard is structural, not a brittle text grep:

1. **A shared shell helper** `renderWebviewShell({ viewId, script, css, nonce, csp, mode })` — the ONLY place a
   `<!DOCTYPE html>` is allowed to live. Every host emits its page through it.
2. **A surface manifest** (one entry per webview): `viewId`, host file, bundle entry, `mode: live|static`, fixture route.
3. **`scripts/check-webview-convention.sh`** (CI-wired like `check:engine-boundary`) asserts:
   - each manifest entry has a `src/webview/<view>/main.tsx`, an esbuild entrypoint, a fixture route, and uses the shell
     helper;
   - host `*Panel.ts` files contain NO forbidden patterns — `acquireVsCodeApi`, `<script`, inline `on*=` handlers, or a
     large HTML template emitted outside the shell helper;
   - `<!DOCTYPE html>` appears ONLY inside the shell helper.
4. The guard lands as a **non-enforcing skeleton FIRST** (allowlisting the not-yet-converted panels), and flips to
   **enforcing only after all four conversions land** — so it blocks NEW inline panels during the migration without
   failing on the in-flight ones.

## Sequencing (revised order, folded from Codex)

1. **Lane A — guard skeleton + manifest + shell helper** (non-enforcing/allowlisted): establishes the convention
   substrate so every later lane plugs into it.
2. **Lane B — probes** (`ProbeResultPanel`, static, 154 ln): the simplest port (model→render, no inline JS). Proves the
   `preact-static` pattern.
3. **Lane C — inspector** (`ServerInspector`, interactive, live model + capture): a SMALLER interactive bridge than the
   form — teaches the both-directions `preact-live` envelope before the hardest port.
4. **Lane D — Agent Studio** (`AgentForm`, interactive, 753 ln) — **THE dominant risk** (validation, cwd directory
   picker via vscode dialog, live kind-inference, error display; both are host round-trips). Reuse `formLogic.ts`.
   Executed in substeps: lock the protocol+VM types → port pure form state → component test (fake postMessage) →
   host-adapter tests (cwd pick, kind inference) → harness/e2e covering the round-trips. Parity is the gate.
5. **Lane E — pin-preview** — ONLY after its security decision (above) is proven (injection tests + strict CSP), or its
   documented exception is recorded.
6. **Lane F — flip the guard to enforcing** (remove the allowlist) once all four conform.
7. **Then resume spec 278** — its catalog/smoke becomes "over all 9 surfaces" (OQ5).

## Acceptance criteria

- [x] **All 9 surfaces share the convention** (preact bundle via the shared shell helper, pure VM, manifest entry); zero
  inline full-page HTML remains in any `src/webview/*.ts` host file (beyond the shell helper). Static surfaces use
  `preact-static`; interactive use `preact-live`.
- [x] **Behavior parity PROVEN (not assumed):** existing unit tests stay green AND each converted surface has a preact
  component test (fake `postMessage`) + a DOM/screenshot parity fixture; each interactive surface has host-adapter tests
  for its round-trips (Agent Studio: invalid submit / valid submit / cwd-pick request → response applied / kind-inference
  applied / host error shown; inspector: model push / capture).
- [x] **Harness + visual-qa reach every surface:** each converted surface has a route + provenance-labeled fixture +
  fidelity test and renders standalone (Agent Studio included).
- [x] **CSP hardened:** every newly-scripted surface ships a strict nonce'd, bundle-only CSP; the `pin-preview` security
  decision (convert-text-safe / no-client-JS / documented exception) is recorded + (if converted) proven by injection
  tests with hostile pin content.
- [x] **CSS shared, not inline:** each surface's styles live in a shared `.css` linked by both the panel and the harness.
- [x] **Convention enforced:** the shell helper + manifest + `check-webview-convention.sh` land; the check blocks a new
  inline panel, allows the shell helper's `<!DOCTYPE>`, and is flipped to enforcing after all four conversions.
- [x] **No regression:** full suite + typecheck + build + engine-boundary green at each lane.

## Open questions — RESOLVED (Codex dueto 2026-06-27, leans folded)

- **OQ1 — static panels:** **one convention, two modes.** All surfaces use the preact architecture; static surfaces
  (probes, pin-preview) use a `preact-static` render-once entry (no listener, no inbound actions), sharing the bundle
  shell / fixture route / CSS / VM / guard — not a reintroduced split, just a lighter runtime contract.
- **OQ2 — message protocols:** **both directions, interactive only.** Agent Studio + inspector get typed host→webview
  AND webview→host envelopes with constructors used by host, webview, and tests; static panels have only the initial-VM
  contract.
- **OQ3 — pin-preview trust:** **escaping alone is insufficient.** Convert only as `preact-static` text/structured-safe
  with a strict CSP + injection tests; else keep a no-client-JS path or a documented scripts-off exception. The decision
  is explicit + recorded (see the security section).
- **OQ4 — the guard:** **manifest + shared shell helper + targeted forbidden-pattern checks**, NOT a `<!DOCTYPE` grep;
  non-enforcing skeleton first, enforcing after all conversions land.
- **OQ5 — sequencing vs 278:** **279 owns the conversion + per-surface harness reachability** (a route/fixture/fidelity
  test each); 278 resumes AFTER as the catalog/smoke over all 9 surfaces.

## Non-goals

- **Redesigning** any surface — this is a faithful architecture port; FIXING the Agent Studio button inconsistency is the
  follow-up this UNBLOCKS (now QA-able), not part of the port. A DOM/screenshot parity fixture guards against accidental
  visual churn during the port.
- Changing what any panel DOES (same features, same host actions, same data).
- The spec-278 catalog/smoke and handoff/pin-studio onboarding — those resume after this (OQ5).
- New webview surfaces or features.
