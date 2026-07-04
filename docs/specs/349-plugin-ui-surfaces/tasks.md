# 349 — plugin-ui-surfaces — tasks

_Generated from `plan.md` on 2026-07-03. Hardened by Dueto review 2 (codex-plan-review). Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

**Architectural constraint (applies throughout):** `src/plugins/ui/projectionTypes.ts` and `broker.ts` MUST stay pure (no `vscode` import); `projectionBuilder.ts` may only `import type` from `FleetVM`. All `vscode`-bound wiring lives in `host.ts` + `src/webview/plugin-host/*`. Enforced by `scripts/check-engine-boundary.sh`.

## Implementation

### Phase 0 — De-risk the hard part (D4) — a HARD CONTRACT GATE, do this FIRST

- [x] **T1** Spike + **close** the opaque-origin iframe contract in `scripts/webview-preview/`: a first-party relay page mounting `<iframe sandbox="allow-scripts" srcdoc="…">`. Deliverables that must all be GREEN before Phase 4 starts: (a) the exact `renderWebviewShell` CSP change (minimal `frame-src`/`child-src` for a `srcdoc` frame) **proven by a parsed-CSP test** (extends `webviewConvention.test.ts` / `parseShellCsp`); (b) a test that the frame renders **without** `allow-same-origin`; (c) the frame reaches **no** parent DOM / storage / network; (d) the plugin document loads **no** `asWebviewUri`/`vscode-webview-resource` — `data:` sub-resources only; (e) two-way `postMessage` relay works. Capture a blank-vs-loaded screenshot. **Gate:** if `srcdoc` can't satisfy (a)–(d), fall back (blob:/served-origin) and revise D4 before proceeding.
  - **CLOSED 2026-07-04 — GATE PASSED, no fallback needed.** `frameSrc:"self"` opt-in on `renderWebviewShell` (`shell.ts`) + parsed-CSP unit tests (`test/unit/webviewShell.test.ts`) + a 9-test real-Chrome puppeteer gate (`test/browser/pluginFrameGate.test.ts`, served via a new `gateServer.ts` route) proving (a)-(e) + blank-vs-loaded, all green. Evidence: `.tachyon/evidence/spec349-t1-plugin-frame-{blank,loaded}.png`. Load-bearing finding for T10/D9 (a `srcdoc` doc's CSP is the union of its own meta policy + the INHERITED embedder policy, so the relay must nonce-stamp the plugin's script tag at assembly time) recorded in `notes.md` § Design decisions.

### Phase 1 — Declaration + gate (manifest + validator + engine + consent)

- [x] **T2** `ViewDecl` type + fail-closed parser in `src/plugins/manifest.ts` (path containment, byte/list caps, `KNOWN_FIELDS` entry). Tests: reject uncontained `entry`, unknown fields, over-cap `views`/`actions`.
  - **CLOSED 2026-07-04 —** `views` parser added with fail-closed caps/unknown-field checks; covered by `test/unit/pluginManifest.test.ts`.
- [x] **T2b** New `src/plugins/entryHtmlValidator.ts` (D9): reject an entry `.html` with URL-carrying attributes (`<script src>`, `<link href>`, remote/`vscode-webview-resource` URLs, `form action`, nested `<iframe>`, `<object>/<embed>`, workers, import maps); allow only inline scripts/styles + `data:` assets. Wire into preview/preflight so a hostile payload is refused **before** consent. Tests: each hostile form rejected; a clean self-contained doc passes.
- [x] **T3** Thread `views` through **every** engine gate (not just "register") — explicit checklist: (1) `loadPlugin` capability count (`engine.ts:410`) so a views-only plugin installs; (2) `InstallPreview.viewTargets` + `fingerprintOf` (`:776`); (3) install ack gate `checkInstallAckGates` (`:1053`); (4) no-op / "nothing to install" guard in `applyInstall` (`:1289`); (5) lockfile `MaterializedTarget` (removable identity); (6) `previewUpdate`/`previewRemove` + `applyRemove` cleanup (unregister + revoke). Tests: a views-only plugin installs; drift invalidates the fingerprint; remove/uninstall fully unregisters.
  - **CLOSED 2026-07-04 —** `viewTargets` now flow through preview/fingerprint/ack/no-op/lockfile/remove/update; `validateEntryHtml` is invoked during preview when entry HTML exists; covered by `test/unit/pluginEngine.test.ts` + `test/unit/pluginLockfile.test.ts`.
- [x] **T4** Extend `src/plugins/consentViewModel.ts`: `ConsentView` + `views` + `requiresViewConfirm` + per-action `requiresActionConfirm`, with honest copy incl. the reveal disclosure ("can reveal terminal contents to you"). Test the pure VM transform.
  - **CLOSED 2026-07-04 —** consent VM exposes `views`, `requiresViewConfirm`, `requiresFleetReadConfirm`, and per-action `requiresActionConfirm`; covered by `test/unit/pluginConsentViewModel.test.ts`.

### Phase 2 — The censored card (projection)

- [x] **T5** Split: `src/plugins/ui/projectionTypes.ts` (PURE — `PluginFleetProjectionV1` with ZERO `FleetVM` reference; includes `generation:number`) and `src/plugins/ui/projectionBuilder.ts` (`import type` `FleetVM` only) with `toPluginProjectionV1(fleet, generation, mintHandle)`. Pseudonymous per-session `label`, opaque `handle`, coarse `status`/`attention`/`badges`/`counts` only.
  - **CLOSED 2026-07-04 —** added pure projection types, a type-only FleetVM builder, and session-stable pseudonym support; covered by `test/unit/pluginProjection.test.ts`.
- [x] **T6** Canary test on the builder: poisoned `FleetVM` with sentinels in every sensitive field (`worktree`, `sub`/`cmd`, `runbooks[].steps`, `parent`, `persistenceHooks.path`, `pins`, `proposals`, `handoff`, `bridge.port`, `folder.hash`/`wsHash`) → assert none appear in `JSON.stringify(projection)`.
  - **CLOSED 2026-07-04 —** canary poisons every listed sensitive field plus raw names/topology-adjacent fields and asserts no sentinel appears in the serialized projection.
- [x] **T7** Projection provider: emit the versioned envelope (**carrying `generation`**) on fleet change (mirror `SidebarPrototype.push()`; reuse the `READY` handshake + a typed `messages.ts`). Bump `generation` on each fleet refresh.
  - **CLOSED 2026-07-04 —** added `src/plugins/ui/messages.ts` and a vscode-free `PluginFleetProjectionProvider` that posts typed projection envelopes, bumps generation on refresh, and republishes the last generation on `READY`.

### Phase 3 — The middleman (broker + generation-stamped handles)

- [x] **T8** New `src/plugins/ui/broker.ts` (PURE core): mint/resolve/expire per-(plugin,session) opaque handles → `{wsHash,agent}`, **each stamped with the current `generation`**. On `{handle,action,generation}`: reject stale generation, validate `action` ∈ consented allowlist, resolve handle→target (reject raw name/`wsHash`/path), invoke a narrow injected callback. Expose ONLY `focusAgent`; hold NO reference to `ACTION_CMD`/`executeCommand`. `focusAgent` fires **only on a user gesture** (never auto on load/message) and is **rate-limited/debounced** (the gesture+rate gate lives in `host.ts`, but the broker refuses non-gesture/over-rate calls it's told about).
  - **CLOSED 2026-07-04 —** added pure `PluginActionBroker`: `mintHandle` matches `PluginProjectionHandleMint`, resolves handles internally to `{wsHash,agent}`, tracks current generation from projection minting, rejects stale generations/raw authority/non-gesture/over-rate calls, and invokes only an injected `focusAgent` callback.
- [x] **T9** `broker.test.ts`: rejection driven by the **`ActionId` enum** (not hand-copied strings) so every current+future privileged id minus `focusAgent` is refused; rejects raw-authority inputs, stale generation, out-of-allowlist, malformed — all with no side effects; `focusAgent` on a valid gesture+handle resolves to the reveal callback; auto-fire-on-load and flood are refused.
  - **CLOSED 2026-07-04 —** `test/unit/pluginBroker.test.ts` covers opaque handles, valid `focusAgent`, enum-driven rejection for all sidebar `ActionId`s, raw-authority rejection, stale/revoked/malformed/out-of-allowlist no-side-effect paths, auto-fire refusal, flood debounce, and source guards against `vscode`/`ACTION_CMD`/`executeCommand`.

### Phase 4 — The glass room (surface host + relay)

- [x] **T10** New `src/webview/plugin-host/*` (thin first-party relay bundle) + esbuild entry + `surfaces.ts` registration; **apply the T1 CSP change to `renderWebviewShell`** and assemble the srcdoc iframe. Forwards projection pushes in and gesture-originated action requests out; no authority of its own.
  - **CLOSED 2026-07-04 —** `src/webview/plugin-host/{main.tsx,relay.ts,plugin-host.css}` now mounts `<iframe sandbox="allow-scripts" srcdoc=...>` with no `allow-same-origin`, strips author CSP meta, injects the host-owned CSP, and nonce-stamps inline plugin scripts with the shell nonce. Esbuild emits `dist/webview/plugin-host.js`; `surfaces.ts` registers editor + sidebar relay surfaces; `test/unit/pluginHostRelay.test.ts` covers nonce-stamping/CSP ownership/message caps.
- [x] **T11** New `src/plugins/ui/host.ts` (vscode-bound): surface lifecycle (register/unregister/revoke on install/update/uninstall/disable), editor panel via `createWebviewPanel` (lazy on command), the generic sidebar host wiring, and the `focusAgent` gesture+rate gate + reveal callback injection into the broker.
  - **CLOSED 2026-07-04 —** `PluginSurfaceHost` reads installed `view` lockfile targets, rehydrates view metadata from the installed payload manifest, opens editor panels via `tachyon.openPluginSurface`, serves the generic sidebar host, pushes `PluginFleetProjectionV1`, injects the broker reveal callback (`tachyon.openAgentTerminalItem`), and revokes sessions/handles when targets disappear. Plugin install/update/remove from the Plugins panel triggers host refresh; `refreshViews` also republishes/revokes.
- [x] **T12** `package.json`: pre-declared generic "Plugin Surfaces" `WebviewView` + `tachyon.openPluginSurface` command. **Decision gate (D7):** if the generic sidebar host proves heavy, ship editor-panel-only in v1 and record the deferral in `notes.md`.
  - **CLOSED 2026-07-04 —** generic sidebar view `tachyonPluginSurfaces` and command `tachyon.openPluginSurface` are contributed. No editor-only cut was needed.

### Phase 5 — Prove it, then dogfood

- [x] **T13** Adversarial plugin fixture + e2e test: attempts network egress, parent-DOM/storage access, sensitive-field read, out-of-allowlist action, **and focusAgent abuse (auto-fire-on-load + flood)** — assert every attempt fails.
- [x] **T14** Mundinho plugin fixture (functional dogfood): consumes `PluginFleetProjectionV1`, renders a character per agent keyed by `status`, and `focusAgent` **on click** opens that agent's terminal. (Art/engine deferred to `p-2ab0f3` — a placeholder render is fine here.)
- [x] **T15** Visual QA — opt-out (placeholder art, see § Visual QA).

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a scenario there._

- [ ] Manifest `views` parses fail-closed; entry-HTML validator refuses hostile payloads at preflight → **"declares a UI surface"** + non-goals.
- [ ] A views-only plugin installs, is fingerprinted, and fully uninstalls (capability/ack/no-op/lockfile/removal gates) → engine integration.
- [ ] Consent drawer shows separate UI / fleet:read / per-action acks incl. the reveal disclosure; nothing renders/brokers pre-consent → **"each scope is consented separately"**.
- [ ] Iframe runs at opaque origin, no `allow-same-origin`, `connect-src 'none'`, no `asWebviewUri` in the plugin doc; parsed-CSP test + isolation test green → **"origin-isolated in a falsifiable way"**.
- [x] `PluginFleetProjectionV1` has zero `FleetVM` derivation; canary green → **"purpose-built projection, leak-proof"**.
- [x] Action via opaque handle only; broker rejects raw authority, stale generation, and every `ActionId` privileged id; can't reach `executeCommand` → **"brokered, never raw-dispatched"**.
- [x] `focusAgent` fires only on gesture, is rate-limited, and its reveal is disclosed in consent → **abuse/non-leak proof**.
- [ ] Update/disable/uninstall closes frames + revokes handles; scope/asset change forces fresh consent → **"revokes the live channel"**.
- [ ] Flood is rate-limited + byte-capped + bounded-queue with no side effects → **"contained (hang, crash, AND flood)"**.
- [ ] Both surface types register/unregister/restore (or editor-only cut recorded per D7).
- [ ] Adversarial fixture's every attempt fails; Mundinho renders + gesture `focusAgent` works.

**Headless check:** `npm run typecheck && npm test && bash scripts/check-engine-boundary.sh`

**Verify:** `npm run typecheck`
**Verify:** `npm test`
**Verify:** `bash scripts/check-engine-boundary.sh`

## Dogfood

**Dogfood:** `vitest run test/integration/plugin-ui.e2e.test.ts`
<!-- Installs BOTH fixtures via the engine: the adversarial plugin (asserts every boundary breach + focusAgent
     abuse fails) and the Mundinho plugin (asserts projection push + gesture focusAgent reveal end-to-end).
     Distinct from the unit-level canary/broker tests under Verify. -->

**Human dogfood:** install the Mundinho fixture in a real VS Code window → open the editor-panel surface → see a character per agent reflecting live status → click a character and confirm that agent's terminal opens (and that it does NOT open on its own). Then install the adversarial fixture → confirm it renders inert (no egress, no data leak, no auto-focus) and the consent drawer disclosed exactly its scopes incl. the reveal.

## Visual QA

_UI-heavy spec: the consent drawer's new `views` section (incl. reveal disclosure), the relay surface, and the iframe'd plugin content in an editor panel and the sidebar host._

**Visual QA Opt-Out:** the v1 Mundinho render is an intentional PLACEHOLDER (a character-per-agent-by-status stand-in) — the real art/engine is deferred to pin `p-2ab0f3`, so there is no design intent to visually QA against yet. Functional rendering IS proven: `test/integration/plugin-ui.e2e.test.ts` asserts the projection renders characters in the real relay and gesture `focusAgent` brokers. The T1 iframe surface already has captured evidence (`.tachyon/evidence/spec349-t1-plugin-frame-{blank,loaded}.png`). A real pixel Visual QA pass belongs with the Mundinho art work under `p-2ab0f3`.
