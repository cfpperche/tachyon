# 280 — webview-convention-consistency

_Created 2026-06-27._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **Origin (owner):** spec 279 made all 9 webview surfaces share the preact-bundle ARCHITECTURE and killed the
> inline-HTML class. But it left two consistency refinements on the 5 PRE-EXISTING panels (a recorded deviation):
> (1) sidebar/activity/handoff/plugins/pin-studio still hand-roll their own `html()` shell (each its own
> `<!DOCTYPE>` + bespoke CSP) instead of the shared `renderWebviewShell`; (2) handoff + pin-studio still post raw
> `{type:"…"}` message literals instead of a shared envelope (the drift-prone pattern the envelope guards). Close
> the consistency: ONE shell, an envelope per view. Nothing is broken — this is DRY + drift-proofing, not a fix.
>
> **Codex dueto (2026-06-27) — SHIP-WITH-CHANGES, folded.** Framed as future-regression PREVENTION, not DRY for its
> own sake (and only valid because the shell can now faithfully express the 5 CSP shapes). Tightened: (a) NO raw
> `bootstrap?: string` — use STRUCTURED `bootstrapGlobals: Record<string,string>` emitted via `JSON.stringify` (the
> shell owns the nonce; callers never author JS → no new escape hatch, no injection); (b) NO arbitrary
> `cspExtra: string[]` — STRUCTURED CSP fields (`connectSrc?`, `workerSrc?`, `childSrc?`); (c) the parity gate is
> NORMALIZED shell assertions (CSP directives as parsed SETS, script/link ORDER, body class, bootstrap-before-bundle,
> expected resource URIs) — stronger than visual-only, not brittle like a byte-diff; (d) pin-studio is CONDITIONAL —
> migrate only if the structured options stay small + its parity tests pass (incl. excalidraw resource loading, not
> just CSP), else keep it a documented guard-allowlisted exception; do it LAST, never the first proof; (e) the
> pin-studio envelope is a discriminated UNION both directions + constructors only at message-creation boundaries
> (not 15 constructors); (f) sequencing: parity tests FIRST → extend shell → handoff/plugins → sidebar → activity →
> pin-studio last; (g) guard scoped to `src/webview/*.ts` host emitters, the shell file allowlisted.

## Intent

Finish the spec-279 convergence so the 5 pre-existing panels match the 4 converted ones exactly:
1. **One shell:** every host emits its page via `renderWebviewShell` — the single `<!DOCTYPE>`/CSP site.
2. **An envelope per view:** handoff + pin-studio get a shared `messages.ts` (typed host↔webview constructors),
   imported by host + webview, so a `type`/shape drift breaks the build.

Then the convention guard can additionally assert "no host file hand-rolls a `<!DOCTYPE>`" — closing the last gap
the spec-279 guard deliberately left open.

## The shell-shape gradient (grounding)

The 5 panels' CSPs differ — the shell must absorb the variation WITHOUT becoming a config-bag:

| panel | delta vs the standard CSP | other |
|---|---|---|
| **handoff** | none (identical to the shell's current output) | — |
| **plugins** | none (identical) | — |
| **sidebar** (view) | `img-src … blob:` + `script-src 'nonce-…'` (NO `cspSource`) | a `WebviewView`, not a panel |
| **activity** | none | + a nonce'd bootstrap `<script>` (`window.__mermaidSrc`/`__katexSrc`/…) + `<body class>` (code theme) |
| **pin-studio** | + `connect-src`, `worker-src blob:`, `child-src blob:` (excalidraw) | + excalidraw asset bootstrap |

`renderWebviewShell` already handles `imgBlob` + `bodyClass`. The remaining needs: a `script-src` without
`cspSource` (sidebar), extra CSP directives (pin-studio), and a nonce'd bootstrap script (activity, pin-studio).

## Design

### Item 1 — extend `renderWebviewShell` (STRUCTURED options), migrate the 5

Add narrowly-scoped, TYPED options — no raw string escape hatches (folded from Codex):
- `scriptCspSource?: boolean` (default `true`; sidebar passes `false` → `script-src 'nonce-…'` only).
- structured CSP extension fields: `connectSrc?: boolean`, `workerSrc?: "blob"`, `childSrc?: "blob"` (pin-studio).
  The shell composes the directive string; callers never pass raw CSP text.
- `bootstrapGlobals?: Record<string, string>` — emitted as a nonce'd inline `<script>` of `window.<key> = <JSON>;`
  assignments BEFORE the bundle (activity: `__mermaidSrc`/`__katexSrc`/`__katexCssUri`/`__codeThemeForced`;
  pin-studio: excalidraw asset URIs). The shell `JSON.stringify`s each value (no caller-authored JS, no injection),
  owns the nonce, and is the ONE sanctioned inline-script site — host `*.ts` files stay script-free.

Migrate handoff, plugins, sidebar, activity, then pin-studio (conditional, last) to `renderWebviewShell(...)` and
delete their `html()` functions. Output must be semantically identical (same stylesheet set + ORDER, same CSP
directive set, same body class, bootstrap emitted BEFORE the bundle with the same nonce).

### Item 2 — shared envelopes for handoff + pin-studio

- **handoff** (`src/webview/handoff/messages.ts`): host→webview `handoffMessage(vm)`; webview→host
  `readyAction`/`refreshAction`/`openFileAction`. Small, mirrors the spec-279 inspector pattern.
- **pin-studio** (`src/webview/pin-studio/messages.ts`): the richest surface — a discriminated UNION both
  directions (`PinStudioHostMessage` = `pinStudio`/`error`/`attachmentStored`; `PinStudioAction` = the editor action
  set save/cancel/new/edit/import/importImage/attachImage/storeSketch/…), with constructors ONLY at actual
  message-creation boundaries (the 3 host→webview messages + the webview helpers that build actions) — not 15
  constructors (folded from Codex: enforce boundary shape + exhaustiveness, not constructor maximalism).

### Item 3 — tighten the guard (optional, gated on items 1+2)

Once all hosts use the shell, the convention guard adds: **no `<!DOCTYPE` literal in any `src/webview/*.ts`** (it
now lives only in `renderWebviewShell`). This is the assertion spec 279 said was too brittle WHILE panels still
hand-rolled — it becomes safe once they don't.

## Parity gate (folded from Codex — the real guard)

"Existing tests + a harness re-render" is too weak: a CSP or load-order regression renders blank only LATER. A byte
diff is too brittle (nonce/URI values vary). The gate is NORMALIZED `renderWebviewShell` assertions per migrated
surface:
- **CSP as a parsed SET** of directives (order-independent), matching the panel's pre-migration CSP semantics.
- **stylesheet + script ORDER** (codicon → design-system → `<view>.css`; bootstrap `<script>` BEFORE the bundle
  `<script>`).
- **body class** present when expected (activity theme).
- **the same nonce** on the bootstrap script AND the bundle script.
- **expected resource URIs** present (the bundle + each stylesheet). For pin-studio, additionally assert the
  excalidraw asset roots are reachable (CSP parity alone doesn't prove resources LOAD).

## Acceptance criteria

- [ ] **One shell:** handoff/plugins/sidebar/activity (+ pin-studio if migrated) emit via `renderWebviewShell`;
  their `html()` functions are deleted; no `<!DOCTYPE` literal remains in any migrated `src/webview/*.ts` host file.
- [ ] **CSP preserved (parsed-set parity):** each migrated panel's rendered CSP directive set is identical to before
  (sidebar keeps `img blob:` + nonce-only script-src; pin-studio keeps connect/worker/child-src) — asserted via the
  normalized parity test, NOT a byte-diff.
- [ ] **Bootstrap preserved + safe:** activity's mermaid/katex globals (+ pin-studio's excalidraw URIs if migrated)
  emit via `bootstrapGlobals` (JSON-encoded values, the shell's nonce), BEFORE the bundle; on-demand vendor loading
  still works.
- [ ] **Envelopes:** handoff + pin-studio have a shared `messages.ts` (discriminated unions both directions, host
  constructors); host + webview import them; a `type`/shape drift breaks the build. Per-view envelope unit test.
- [ ] **Guard tightened, scoped:** the convention test additionally fails on a `<!DOCTYPE` literal in a migrated
  `src/webview/*.ts` host emitter; the shared shell file (the one sanctioned site) is allowlisted.
- [ ] **No regression:** full suite + typecheck + build + engine-boundary green; the normalized parity test passes
  for every migrated surface; a harness re-render confirms each still paints.
- [ ] **pin-studio decision recorded:** migrated (with structured options + passing parity incl. resource loading)
  OR a documented guard-allowlisted exception — explicit, not implicit.

## Open questions — RESOLVED (Codex dueto 2026-06-27, leans folded)

- **OQ1 — pin-studio:** migrate **only** with the STRUCTURED CSP/bootstrap options + passing normalized parity tests
  (incl. excalidraw resource loading); otherwise keep it a documented guard-allowlisted exception. Do it LAST, never
  the first proof. (The exotic CSP + excalidraw assets are the stress test for whether the shell is the right
  abstraction for it.)
- **OQ2 — bootstrap:** **structured `bootstrapGlobals: Record<string,string>`** (`window.k = JSON.stringify(v)`), NOT
  a raw JS string; no 2nd esbuild bundle (overkill for static URI globals). The shell owns the nonce.
- **OQ3 — pin-studio envelope:** a discriminated UNION both directions + constructors only at message-creation
  boundaries (the 3 host→webview + the webview action builders) — enforce boundary shape + exhaustiveness, not 15
  constructors.
- **OQ4 — parity gate:** **normalized shell/CSP/load-order parity tests** (the section above) — the cheapest gate
  that actually catches a CSP/order regression; "tests + re-render" alone is insufficient.
- **OQ5 — harness routes:** add **handoff's** route here (cheap, reduces blind spots); **defer pin-studio's** harness
  onboarding to the paused spec 278 unless its migration parity depends on it.

## Sequencing (folded from Codex — parity tests first; pin-studio last)

1. **Lane A** — extend `renderWebviewShell` (structured `scriptCspSource`/`connectSrc`/`workerSrc`/`childSrc`/
   `bootstrapGlobals`) + the normalized parity-test helper (parse CSP to a set, assert order/nonce/URIs).
2. **Lane B** — migrate the trivial pair (handoff, plugins; CSP already identical) + parity tests; add handoff's
   shared envelope + its harness route.
3. **Lane C** — migrate sidebar (`img blob:` + nonce-only script) + activity (`bootstrapGlobals` + body class) with
   parity tests.
4. **Lane D** — pin-studio: migrate with the structured options IFF parity (incl. excalidraw resource loading)
   passes; else record the documented exception. Add its shared envelope (union both directions) regardless.
5. **Lane E** — tighten the guard (forbid `<!DOCTYPE` in host emitters, allowlist the shell) once all migrations land.

## Non-goals

- Any behavior/visual change to the 5 panels (pure plumbing — a DOM-parity expectation guards against churn).
- Redesigning the shell into a generic template engine (narrow named options only).
- The spec-278 harness catalog/smoke over all 9 (resumes separately; this only optionally adds routes).
- Touching the 4 spec-279 conversions (already on the shell + envelopes).
