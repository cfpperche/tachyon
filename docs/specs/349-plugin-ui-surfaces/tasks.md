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

- [ ] **T5** Split: `src/plugins/ui/projectionTypes.ts` (PURE — `PluginFleetProjectionV1` with ZERO `FleetVM` reference; includes `generation:number`) and `src/plugins/ui/projectionBuilder.ts` (`import type` `FleetVM` only) with `toPluginProjectionV1(fleet, generation)`. Pseudonymous per-session `label`, opaque `handle`, coarse `status`/`attention`/`badges`/`counts` only.
- [ ] **T6** Canary test on the builder: poisoned `FleetVM` with sentinels in every sensitive field (`worktree`, `sub`/`cmd`, `runbooks[].steps`, `parent`, `persistenceHooks.path`, `pins`, `proposals`, `handoff`, `bridge.port`, `folder.hash`/`wsHash`) → assert none appear in `JSON.stringify(projection)`.
- [ ] **T7** Projection provider: emit the versioned envelope (**carrying `generation`**) on fleet change (mirror `SidebarPrototype.push()`; reuse the `READY` handshake + a typed `messages.ts`). Bump `generation` on each fleet refresh.

### Phase 3 — The middleman (broker + generation-stamped handles)

- [ ] **T8** New `src/plugins/ui/broker.ts` (PURE core): mint/resolve/expire per-(plugin,session) opaque handles → `{wsHash,agent}`, **each stamped with the current `generation`**. On `{handle,action,generation}`: reject stale generation, validate `action` ∈ consented allowlist, resolve handle→target (reject raw name/`wsHash`/path), invoke a narrow injected callback. Expose ONLY `focusAgent`; hold NO reference to `ACTION_CMD`/`executeCommand`. `focusAgent` fires **only on a user gesture** (never auto on load/message) and is **rate-limited/debounced** (the gesture+rate gate lives in `host.ts`, but the broker refuses non-gesture/over-rate calls it's told about).
- [ ] **T9** `broker.test.ts`: rejection driven by the **`ActionId` enum** (not hand-copied strings) so every current+future privileged id minus `focusAgent` is refused; rejects raw-authority inputs, stale generation, out-of-allowlist, malformed — all with no side effects; `focusAgent` on a valid gesture+handle resolves to the reveal callback; auto-fire-on-load and flood are refused.

### Phase 4 — The glass room (surface host + relay)

- [ ] **T10** New `src/webview/plugin-host/*` (thin first-party relay bundle) + esbuild entry + `surfaces.ts` registration; **apply the T1 CSP change to `renderWebviewShell`** and assemble the srcdoc iframe. Forwards projection pushes in and gesture-originated action requests out; no authority of its own.
- [ ] **T11** New `src/plugins/ui/host.ts` (vscode-bound): surface lifecycle (register/unregister/revoke on install/update/uninstall/disable), editor panel via `createWebviewPanel` (lazy on command), the generic sidebar host wiring, and the `focusAgent` gesture+rate gate + reveal callback injection into the broker.
- [ ] **T12** `package.json`: pre-declared generic "Plugin Surfaces" `WebviewView` + `tachyon.openPluginSurface` command. **Decision gate (D7):** if the generic sidebar host proves heavy, ship editor-panel-only in v1 and record the deferral in `notes.md`.

### Phase 5 — Prove it, then dogfood

- [ ] **T13** Adversarial plugin fixture + e2e test: attempts network egress, parent-DOM/storage access, sensitive-field read, out-of-allowlist action, **and focusAgent abuse (auto-fire-on-load + flood)** — assert every attempt fails.
- [ ] **T14** Mundinho plugin fixture (functional dogfood): consumes `PluginFleetProjectionV1`, renders a character per agent keyed by `status`, and `focusAgent` **on click** opens that agent's terminal. (Art/engine deferred to `p-2ab0f3` — a placeholder render is fine here.)
- [ ] **T15** Visual QA pass (see § Visual QA).

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a scenario there._

- [ ] Manifest `views` parses fail-closed; entry-HTML validator refuses hostile payloads at preflight → **"declares a UI surface"** + non-goals.
- [ ] A views-only plugin installs, is fingerprinted, and fully uninstalls (capability/ack/no-op/lockfile/removal gates) → engine integration.
- [ ] Consent drawer shows separate UI / fleet:read / per-action acks incl. the reveal disclosure; nothing renders/brokers pre-consent → **"each scope is consented separately"**.
- [ ] Iframe runs at opaque origin, no `allow-same-origin`, `connect-src 'none'`, no `asWebviewUri` in the plugin doc; parsed-CSP test + isolation test green → **"origin-isolated in a falsifiable way"**.
- [ ] `PluginFleetProjectionV1` has zero `FleetVM` derivation; canary green → **"purpose-built projection, leak-proof"**.
- [ ] Action via opaque handle only; broker rejects raw authority, stale generation, and every `ActionId` privileged id; can't reach `executeCommand` → **"brokered, never raw-dispatched"**.
- [ ] `focusAgent` fires only on gesture, is rate-limited, and its reveal is disclosed in consent → **abuse/non-leak proof**.
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

- [ ] Evidence: `scripts/webview-preview/` screenshots of the consent `views` section + a fixture-fed relay surface (light + dark) + the T1 blank-vs-loaded iframe trace, plus a real-install screenshot of the Mundinho panel.
- [ ] Verdict:
