# 349 — plugin-ui-surfaces — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Fase 0 — prior-art research (grounding, 2026-07-03)

Full research done before design. Three fronts. Sources cited inline.

### Front 1 — VS Code's own webview model (the pattern we mirror one level down)

- **Two surfaces:** `WebviewPanel` (editor tab, created imperatively via `window.createWebviewPanel`, extension owns the ref) vs `WebviewView` (sidebar/panel container, registered via `registerWebviewViewProvider` + declared in `package.json` `contributes.views` with mandatory `"type":"webview"`). Tachyon's `SidebarPrototypeProvider` is a `WebviewView`; other surfaces are `WebviewPanel`s.
- **Security model (load-bearing):** `enableScripts` (JS off by default); `localResourceRoots` (only dirs the webview loads from; `[]` blocks all); `webview.asWebviewUri()` (rewrite `file:`→loadable scheme, required per resource); `webview.cspSource` (interpolate, don't hardcode); CSP via `<meta>` with `default-src 'none'` baseline + per-render **nonce** for scripts; `enableForms`/`enableCommandUris`/`portMapping` all opt-in. `default-src 'none'` is *why* external network is blocked.
- **Isolation:** the webview is a sandboxed iframe — no VS Code API, no extension-host Node, no other extensions, no arbitrary fs/network. Only channel out = `acquireVsCodeApi()` bridge.
- **Messaging/state:** `postMessage`/`onDidReceiveMessage`, JSON-only; `getState/setState` preferred over `retainContextWhenHidden`; `WebviewPanelSerializer` restores panels across reload.
- **KEY ASYMMETRY for us:** VS Code trusts the *extension code* (Node side) and only sandboxes the *rendered HTML*. Our plugin author is untrusted on **both** sides → we cannot give a plugin an `onDidReceiveMessage` handler running with Tachyon's authority. Sources: code.visualstudio.com/api/extension-guides/webview, /api/references/vscode-api, /api/references/contribution-points.

### Front 2 — sandboxing & capability prior art

- **iframe `sandbox`:** `sandbox=""` = all restrictions; tokens re-enable individually. Without `allow-same-origin` → **opaque origin** (can't read parent DOM/storage/cookies). **Footgun:** `allow-scripts`+`allow-same-origin` together lets the frame remove its own sandbox → "no more secure than not using sandbox." Mitigation: serve untrusted UI from a **distinct/opaque origin**. Restrictions cascade to nested iframes. (MDN iframe, web.dev "Play safely in sandboxed iframes")
- **Capability declaration + consent:** Chrome MV3 `permissions`/`optional_permissions` (install + runtime consent). **Figma plugins = closest analog:** two-realm split — plugin logic in a sandbox with NO browser APIs; UI via `figma.showUI()` which creates an **iframe**; sandbox touches the scene but not network, iframe touches network but not scene; they talk only via `postMessage`; manifest requires `networkAccess.allowedDomains` allowlist. (developers.figma.com)
- **Host-proxied broker / reference monitor:** host owns real state, exposes only a curated/redacted/read-only **versioned** VM over postMessage. VS Code's webview API is itself a production instance. **Trail of Bits lesson (2023-02-23):** XSS in a webview is contained only if `localResourceRoots` tight + CSP strict + **the host `onDidReceiveMessage` handler treats every message as hostile** — that handler is the real trust boundary. Comlink = reference for structured-clone postMessage RPC with `expose()` + `allowedOrigins`.
- **Object-capability / POLA:** authority = the unforgeable refs an object holds; justifies "hand the plugin a redacted VM and nothing else."
- **Failure isolation:** iframe/Worker gives plugin UI its own event loop; host must never make a *synchronous* call into untrusted UI; wrap RPC in correlation-id + timeout; host holds source-of-truth so a leaking iframe can be torn down and recreated.

### Front 3 — internal reuse catalog (this repo)

- **`src/webview/shared/shell.ts` — `renderWebviewShell`** = the ONE sanctioned CSP assembler (strict nonce'd `default-src 'none'`, parameterized from `cspSource`). Sidebar VIEW uses nonce-only (`scriptCspSource:false`) = strictest baseline. `webviewNonce()`/`parseShellCsp()` helpers. **Most reusable security primitive.**
- **`src/webview/surfaces.ts`** — `WEBVIEW_SURFACES[]` canonical registry `{viewId, view, hostFile, mode:"live"|"static"}` + convention guard (`scripts/check-webview-convention.sh`). `live`/`static` mode maps to read-only vs interactive.
- **`esbuild.mjs` + `tsconfig.webview.json`** — per-surface browser IIFE bundles from `src/webview/<view>/main.tsx`. NOTE: this compiles *first-party* surfaces; plugin-shipped assets need a *different* story (prebuilt, not compiled by Tachyon).
- **`src/webview/shared/ready.ts`** — shared `READY` handshake imported by every side. `sidebar/main.tsx` = canonical retry-until-first-push (250ms, stop 5s, re-request on focus).
- **Typed envelopes** (`*/messages.ts`, e.g. `sidebar/messages.ts` `FLEET`+`fleetMessage`) — type string + shape + constructor live once, imported by host sender + webview listener + preview harness; drift breaks the *build*. = the "versioned contract" discipline, already institutionalized.
- **`src/sidebar/types.ts`** — `FleetVM`/`AgentVM`, framework-agnostic, already decoupled ("UI decoupled from rules"). Built + pushed by `src/webview/SidebarPrototype.ts` `gatherOne(ws)` → `fleetMessage`.
- **Sensitivity audit (must redact for untrusted consumer):** `AgentVM.worktree` (branch/fs path); `AgentVM.sub`/`FleetVM.commands[].cmd`/`runbooks[].steps` (raw command lines — paths/flags/secrets); `persistenceHooks.path`/`.reason`; `parent`/`sub`/`name` (topology + intent); `FleetVM.bridge.port` (attack surface); `pins[]`/`proposals[].reason`/`handoff` (human content); `folder.hash`/`wsHash` (routing key). **Safe-ish subset:** coarse `status`, badge enums (`verify`/`continuity`/`evidence` counts), capability booleans. → treat as **opt-in allowlist per scope, NOT FleetVM-minus-denylist**.
- **DANGER:** `SidebarPrototype.handleMessage`/`runAction` maps webview messages straight to privileged `vscode.commands.executeCommand` (stop/kill/restart/spawn/delete). Safe today ONLY because the bundle is first-party. An untrusted surface must NOT reach this dispatch — separate read-only-default broker.
- **Plugin consent spine (extend this):** `src/plugins/manifest.ts` (`PluginManifest`, fail-closed, 64KB cap, `MAX_LIST=64`, `KNOWN_FIELDS` closure, null-proto accumulators, path containment `validContainedPath`, https-only, sha256 pins — a `views` capability slots in as a new `KNOWN_FIELDS` entry + parser); `src/plugins/engine.ts` (two-phase `preview*` read-only vs `apply*` re-derive-on-drift with `fingerprint` TOCTOU + payload preflight reject-symlinks/bound-bytes/hash; `MAX_PAYLOAD_BYTES=50MB`/`FILES=5000`/`DEPTH=32` — plugin UI assets ride this); `src/plugins/consentViewModel.ts` (`ConsentVM` with per-capability sections + `requiresMcpConfirm`/`ToolConfirm`/etc. — add `ConsentView[]` + `requiresViewConfirm`).
- **Preview harness `scripts/webview-preview/`** — routes/fixtures (`mission-control.ts`), reuses shared envelope constructors; a plugin-UI author could develop against fixture VMs with zero Tachyon internals.

### Reuse-ready (lift directly)
1. `renderWebviewShell` + `webviewNonce` + `parseShellCsp` (nonce-only baseline).
2. `READY` handshake + retry-until-first-push.
3. Typed-envelope + shared-constructor drift discipline (= versioned contract).
4. `FleetVM`/`AgentVM` (as the redacted-projection *starting point*, not raw).
5. Plugin consent spine (manifest parser + two-phase engine + `ConsentVM`).
6. Surface registry + convention guard + `live`/`static` mode.
7. Preview harness for isolated plugin-UI prototyping.

### Recommended v1 (research) vs ratified v1
- **Research recommended the safest intersection:** read-only, egress-blocked, nested-opaque-origin, redacted versioned FleetVM projection, host→UI push only, no inbound actions.
- **Human ratified a more ambitious v1 (2026-07-03):** bidirectional broker (include a **minimal consented action allowlist**) + support **both** surface types (editor panel + sidebar view). The action path and dual-surface lifecycle are therefore v1 work, not deferred — this raises the trust-boundary bar (the broker is bidirectional from day one) and the design must be extra careful that the action channel can never reach the raw `executeCommand` dispatch.

## Dueto review (2026-07-03) — claude-2 + ad-hoc codex-review

Adversarial spec review by an ad-hoc Codex agent (`codex-review`, gpt-5.5, 1m29s, read-only), then reconciled by claude-2. Codex verdict: **NEEDS-REVISION**. Full critique preserved at `.tachyon/evidence/spec349-adversarial-review-codex.md` (agent since dismissed). Findings + claude-2's independent disposition:

**BLOCKING**
1. *Action broker v1 too big/underspecified* — could be confused into stop/kill/restart/delete via name confusion or dispatcher reuse (`SidebarPrototype.ts:59/154`). → **ACCEPTED.** Converged fix: v1 = one non-destructive, opaque-handle-targeted action + rejection tests for all sidebar ids; destructive → v2. (Q0 in spec — human ratifies.)
2. *Iframe origin-isolation is a requirement but its proof is an open question* — impl could pick srcdoc/blob/data forcing `allow-same-origin`. → **ACCEPTED WITH ALTITUDE REFINEMENT (claude-2):** the *mechanism* is a `plan` decision, but the spec now pins a **falsifiable invariant** (no `allow-same-origin`; test fails if frame reaches parent/storage/network). Does not block ratification.
3. *Allowlist projection lacks structural anti-regression* — someone reuses FleetVM "temporarily", leaks via denylist. → **ACCEPTED + STRENGTHENED (claude-2):** new `PluginFleetProjectionV1` type that does NOT import FleetVM + a **canary/taint** test (poisoned FleetVM with sentinels in every sensitive field; assert none appear in JSON) — stronger than Codex's snapshot test.
4. *No opaque identifiers → action + projection conflict* — spec excludes wsHash but actions need a target; raw name = internal routing. → **ACCEPTED (best insight — caught a real internal contradiction in the draft).** Host emits opaque, capability-bound, session-scoped handles; broker resolves handle→target; never accepts raw name/hash/path.

**SHOULD-FIX** (all folded into acceptance)
1. No update/disable/uninstall revocation scenario → ADDED.
2. No hostile HTML/asset payload scenario → ADDED (preflight validates entry/MIME/roots/size/CSP).
3. Misbehaving-surface covers hang/crash but not **flood** → ADDED rate-limit + byte-cap + bounded queue.
4. Consent doesn't separate read-state from request-action → ADDED per-scope + per-action acks.
5. Both surfaces raises lifecycle risk; suggested cutting sidebar view → **REJECTED (claude-2):** both surfaces is lifecycle, not trust-boundary; the right risk cut is actions (Q0), not surfaces. Kept both + explicit register/unregister/restore.

**NICE-TO-HAVE**
1. Split `fleet:read` into `fleet:summary`/`fleet:agents` → PROMOTED to a `plan` open question (least-privilege, leaning summary-first).
2. Mundinho shouldn't be the only security proof → PROMOTED to acceptance: a dedicated **adversarial plugin fixture** ships alongside the Mundinho functional dogfood.
3. Local audit log of brokered actions → recorded as a `plan` open question.

Process note: `codex-review` was spawned with `parent=claude` but the coordinator's real name is **claude-2** → the completion poke misrouted to `claude`, who forwarded it. Lineage/authorship bug logged by `claude`; fixed going forward.

## Dueto review 2 (2026-07-03) — claude-2 + ad-hoc codex-plan-review (plan + tasks)

Adversarial review of `plan.md` + `tasks.md` (not spec.md) by `codex-plan-review` (gpt-5.5, 1m53s, read-only, `parent=claude-2` — lineage fixed). Verdict: **BLOCKING — refine plan/tasks before starting T1.** claude-2 concurred with essentially all of it (each finding grounded in real `file:line`); dispositions:

**BLOCKING — all ACCEPTED**
1. *D4 is not yet an implementable contract* — `renderWebviewShell` has no `frame-src`, only `child-src blob:` on request (`shell.ts:51`); left abstract, an implementer reaches T10 with a blank frame and relaxes to `allow-same-origin` to "fix" it. → **T1 is now a hard contract gate**: deliver a tested `renderWebviewShell` CSP change + srcdoc-renders-without-`allow-same-origin` + no-`asWebviewUri`-in-plugin-doc tests; T10 applies it (D4 rewritten).
2. *Views-only plugin dies in the "nothing to install" / ack / lockfile gates* that only know hooks/skills/MCP/git-hooks (`engine.ts:410/1053/1289`). → **D2 rewritten + T3 now enumerates all six gates** (capability count, preview/fingerprint, ack, no-op guard, lockfile target, remove cleanup).
3. *focusAgent not proven non-leaking/anti-abuse* — `openAgentTerminalItem → Terminals.open` reveals RAW tmux session content to the user (`Terminals.ts:40`); abusable via auto-focus-on-load / flood-DoS. claude-2 refinement: it's a plugin-driven *reveal to the human*, not a leak to the plugin. → **D6 + T8/T9/T13**: gesture-only, rate-limited, honest consent copy ("can reveal terminal contents to you"), adversarial fixture tests auto-fire + flood.

**SHOULD-FIX — all ACCEPTED**
1. Asset policy ambiguous; egress caught "too late" by the adversarial test → **new D9 + T2b**: a strict self-contained entry-HTML validator at preflight (rejects `<script src>`/`<link href>`/remote URLs/`form action`/nested iframe/worker/import maps).
2. `reject-every-ACTION_CMD` test fragile if strings hand-copied → **T9 driven by the `ActionId` enum** so future ids are auto-covered.
3. Projection "doesn't import FleetVM" contradicts a `FleetVM` builder (TS) → **D5/T5 split**: `projectionTypes.ts` (pure, zero FleetVM) + `projectionBuilder.ts` (`import type` only), canary on the builder.
4. Handle revocation coupled only to install lifecycle → **generation-stamped handles**: projection carries `generation` (T7); broker rejects stale generations (T8) so a stale iframe's handle can't resolve after churn.

**NICE-TO-HAVE** — local action audit log (kept as a `plan` open question), T1 blank-vs-loaded screenshot (folded into T1/Visual QA), editor-only cut if T1/T10 slip (D7 cut noted).

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### T1 — the opaque-origin iframe contract gate: CLOSED, srcdoc works (2026-07-04)

**Gate result: PASS.** `srcdoc` satisfies every D4 invariant with no fallback needed. Delivered:

- `src/webview/shared/shell.ts` — new opt-in `frameSrc?: "self"` on `WebviewShellOptions`. Adds `frame-src 'self'`
  + merges a `child-src 'self'` token into the (possibly-already-present) `child-src` directive — refactored
  the directive builder to token-collect `child-src` sources (`childSrc:"blob"` + `frameSrc:"self"`) before
  joining, since a duplicate directive NAME is invalid CSP (only the first occurrence is honored) and a future
  surface could plausibly want both. No existing surface sets `frameSrc`, so no surface's CSP changed.
- `test/unit/webviewShell.test.ts` — parsed-CSP parity tests: absent by default, `'self'` only (never a
  wildcard/plugin-origin — there is none), merges cleanly with `childSrc:"blob"`, leaves every other directive
  untouched.
- `scripts/webview-preview/pluginFrameGate.ts` + `plugin-frame-relay.js` — the spike page + relay bundle. The
  relay mounts `<iframe sandbox="allow-scripts" srcdoc="…">` (no `allow-same-origin`, ever) housing a stand-in
  untrusted plugin doc, wires a two-way `postMessage` ping/pong, and surfaces the plugin doc's own probe
  results verbatim (no interpretation by the trusted relay).
- `test/browser/support/gateServer.ts` — new `/plugin-frame-gate` route (mirrors the existing `/ui-gate` route),
  renders via the REAL `renderWebviewShell`/`renderPluginFrameGatePage` — not a hand-copied CSP string, same
  anti-drift reasoning as `ui-gate/gatePage.ts`.
- `test/browser/pluginFrameGate.test.ts` — THE gate, 9 tests, real headless Chrome (puppeteer-core), all green:
  (a) the CSP shape itself; (b) sandboxed w/o `allow-same-origin` + the frame actually renders (not blank); (c)
  the framed doc can reach **none** of parent DOM / localStorage / network (network probe fetches a real,
  always-200 same-server URL — not a non-resolving hostname — so the block is proven to be CSP, not incidental
  DNS failure); (d) no `asWebviewUri`/remote sub-resource, fully self-contained; (e) the postMessage channel
  still works despite (c)'s isolation; plus a blank-vs-loaded fail-loud proof (request-interception holds the
  relay bundle, asserts `#root` is genuinely empty first, then mounted). Evidence screenshots captured once and
  kept: `.tachyon/evidence/spec349-t1-plugin-frame-{blank,loaded}.png` (the loaded shot's JSON readout shows all
  four probes `blocked:true` + `pong:1`).

**FINDING, load-bearing for T10/D9 (not obvious from spec/plan, discovered empirically):** a `srcdoc` document's
enforced CSP is the **union** of its own `<meta http-equiv="Content-Security-Policy">` policy AND the embedder's
CSP, inherited — not a replacement. Chrome enforces **both simultaneously**. First attempt gave the plugin doc
its own `script-src 'unsafe-inline'` meta tag and its inline script was still blocked, by the OUTER shell's
`script-src 'nonce-…'` (no `'unsafe-inline'` there, correctly). Fix: the doc's own CSP declares
`script-src 'nonce-${nonce}'` where `${nonce}` is the SAME nonce the outer shell issued for its own bundle
script that render — read via `document.currentScript.nonce` **synchronously at top-level** (it is `null` once
you're inside any later callback/event listener — `DOMContentLoaded` included). The relay (trusted, first-party,
the one assembling the final `srcdoc` string at render time) stamps this nonce onto the plugin's script tag; the
plugin AUTHOR never sees or supplies it, and could not predict it (fresh per render). **Consequence for T10/D9:**
the real production relay (`src/webview/plugin-host/*`) MUST do the same nonce-stamping when it assembles a
plugin's prebuilt entry `.html` into a `srcdoc` string — a plugin's shipped markup should carry NO nonce of its
own (D9's entry-HTML validator should not require or even accept an author-supplied `nonce` attribute, since it
would be meaningless/discardable — the relay owns nonce injection, matching how it owns the outer bundle's).

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **T1's "página" lives only in `scripts/webview-preview/` + the ephemeral `test/browser/support/gateServer.ts`
  route, not a persistent `npm run preview:webview` (serve.mjs) route** — matches the existing `ui-gate`
  precedent exactly (also test-only-reachable). Investigated wiring a live route into `serve.mjs` (a plain
  `.mjs`, no build step) using Node 24's native TS execution (confirmed working for simple cases), but Node's
  native loader does NOT do TypeScript's "`.js` specifier resolves to a sibling `.ts` file" rewrite — only
  vitest/tsc's own resolution does that — so a multi-file relative-import chain (`pluginFrameGate.ts` →
  `shell.ts`) can't be live-rendered by plain `node serve.mjs` without either a build step or literal `.ts`
  extensions in every import (which would fight `tsconfig.webview.json`'s Bundler-mode convention, matching
  `routes.ts`'s existing extensionless style). Not worth the friction for a T1 spike; "como rodar" is
  `npm run test:browser -- pluginFrameGate` (or `npx vitest run --config vitest.browser.config.ts
  test/browser/pluginFrameGate.test.ts`), same as how one reproduces the `ui-gate` compat gate today.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### Lifecycle hardening gaps closed (2026-07-04)

Added coverage for the three remaining lifecycle edges without expanding the trust boundary:

- `test/unit/pluginSurfaceHost.test.ts` opens a real installed editor fixture through `PluginSurfaceHost`, removes the `kind:"view"` lockfile target, and proves the panel/session is disposed and the old opaque handle no longer triggers `tachyon.openAgentTerminalItem`. This caught and fixed a real lifecycle recursion bug in `host.ts`: `revoke()` now removes session bookkeeping before calling `panel.dispose()`, so the panel's own `onDidDispose` callback cannot re-enter the same live session.
- The same unit test exercises the generic sidebar registration path with two installed sidebar fixtures. Removing the first sorted target forces re-registration to the next live target, and an action with the old session handle is rejected as `unknown_handle` with no command side effect. This is the cheap/real coverage for sidebar lifecycle; no theatrical `vscode-test` WebviewView harness was needed because the relay is identical to editor and the difference is the registration path in `host.ts`.
- `test/integration/plugin-ui.e2e.test.ts` now covers relay teardown/recreation: a nonresponsive plugin iframe ignores projection pushes, the first-party relay document is reloaded from host source-of-truth, and the recreated opaque iframe renders the Mundinho projection. This covers the practical hang/stuck-frame recovery path without introducing a new watchdog API.

Verification: `npm run build` passed; `npx vitest run test/unit/pluginSurfaceHost.test.ts test/integration/plugin-ui.e2e.test.ts` passed (6 tests); `bash scripts/check-engine-boundary.sh` passed. Full `npm run typecheck` and `npm test` are currently blocked by unrelated dirty Task Studio changes (`src/webview/task-studio/messages.ts`, `types.ts`) that removed/renamed `TaskStudioVM`, `taskStudioMessage`, `errorMessage`, and `saveConflictMessage`; the Spec 349 focused tests are green.

### T2-T4 — view declaration through manifest, engine, and consent (2026-07-04)

`views` landed as a runtime-agnostic manifest capability and a runtime-agnostic lockfile target (`kind:"view"`, no
`runtime`, `file:.tachyon/plugins/<plugin>/<entry>`, `ref:<view.id>`). This avoids pretending an editor/sidebar
surface belongs to Claude or Codex while still giving preview/remove/update a concrete removable identity. The
engine now counts views as a capability, exposes `InstallPreview.viewTargets`, binds view id/title/surface/entry/
fleet/actions into the install fingerprint, requires separate UI + fleet-read + per-action acknowledgements, and
invokes `validateEntryHtml` during preview so hostile entry HTML is refused before consent. Consent VM exposes the
same scopes via `views`, `requiresViewConfirm`, `requiresFleetReadConfirm`, and `requiresActionConfirm`.

Verification: `npm run typecheck`; `npm test`; `bash scripts/check-engine-boundary.sh` — all passed.

### T5-T7 — curated fleet projection and typed push provider (2026-07-04)

The plugin-facing projection now lives under `src/plugins/ui/` and remains separate from both the raw sidebar
model and VS Code. `projectionTypes.ts` is a pure allowlist contract (`PluginFleetProjectionV1`) with no host
fleet type reference; `projectionBuilder.ts` is the only projection file that type-only imports the raw sidebar
model so it can translate `FleetVM` into coarse agent cards. The builder emits only opaque handles supplied by
the host-side caller, session-stable pseudonymous labels, coarse status/attention, safe badge enums, and counts.

`test/unit/pluginProjection.test.ts` carries the canary: a poisoned fleet injects sentinel strings into raw
names, workspace hashes, command strings, runbook steps, topology, persistence hook paths, pins, proposals,
handoff, bridge port, and terminal data, then asserts the serialized projection contains none of them.

T7 is intentionally still host-agnostic: `messages.ts` defines the typed `pluginFleetProjection` envelope and
reuses the shared `READY` handshake; `projectionProvider.ts` posts to an abstract sink, bumps `generation` on
each fleet refresh, and republishes the last projection on `READY` without importing `vscode` or creating the
Phase-4 relay/host.

Verification: `npx vitest run test/unit/pluginProjection.test.ts`; `npm run typecheck`; `npm test`; `bash
scripts/check-engine-boundary.sh` — all passed.

### T8-T9 — broker puro de ação com handles opacos (2026-07-04)

`src/plugins/ui/broker.ts` now provides the Phase-3 action reference monitor without importing VS Code or the
first-party sidebar dispatcher. `PluginActionBroker.mintHandle` has the same `PluginProjectionHandleMint`
signature expected by `projectionBuilder.ts`, so Phase 4 can pass `broker.mintHandle` into the projection
provider. Each mint records only an opaque token -> `{wsHash?, agent}` target plus the projection `generation`;
the broker observes the latest generation during minting and also exposes `bumpGeneration()` for future host
lifecycle churn.

The only exposed plugin action is `focusAgent`. `dispatchAction()` rejects raw authority fields (`agent`, `name`,
`wsHash`, path/worktree/workspace forms), malformed payloads, out-of-allowlist sessions, stale generations,
revoked/unknown handles, non-gesture requests, and focus floods before invoking the narrow injected callback.
The callback is intentionally just `focusAgent(target)`; the future host layer owns translating that into the
VS Code reveal command and still must perform the outer gesture/rate gate.

`test/unit/pluginBroker.test.ts` drives privileged-action rejection from `ACTION_META` (the exported `ActionId`
catalog) instead of hand-copied strings, so adding a new sidebar action keeps the rejection test meaningful.
It also guards the broker source against `vscode`, `ACTION_CMD`, and `executeCommand` references.

Verification: `npx vitest run test/unit/pluginBroker.test.ts`; `npm run typecheck`; `npm test`; `bash
scripts/check-engine-boundary.sh` — all passed.

### T10-T12 — host + relay da sala de vidro (2026-07-04)

Phase 4 connected the already-shipped contract pieces without moving their trust boundaries. The browser relay is
first-party and thin: `src/webview/plugin-host/main.tsx` mounts a nested iframe with `sandbox="allow-scripts"`
only, forwards projection messages into the iframe, and forwards action requests back out. `relay.ts` owns the
`srcdoc` assembly detail discovered in T1: it strips any author CSP meta, injects the relay-owned `connect-src
'none'`/`frame-src 'none'` policy, and stamps the shell nonce onto every inline plugin `<script>` before Chrome
sees the document. The plugin author never supplies or predicts the nonce.

`src/plugins/ui/host.ts` is intentionally the only new `vscode`-bound plugin-UI file. It reads installed
lockfile `kind:"view"` targets as the authority that a surface is active, then rehydrates title/surface/actions
from the installed payload's `tachyon-plugin.json`. Editor surfaces open lazily via `tachyon.openPluginSurface`;
sidebar surfaces render inside the pre-declared generic `tachyonPluginSurfaces` webview view. Sessions hold a
`PluginActionBroker` plus `PluginFleetProjectionProvider`; updates/removes/reinstalls refresh the host from the
Plugins panel and revoke sessions whose view target disappeared, clearing handles through `broker.expireAll()`.

The generic sidebar host proved small enough, so D7's editor-only cut was not taken. `scripts/check-engine-boundary.sh`
now allowlists only `src/plugins/ui/host.ts` as shell; `projectionTypes.ts`, `projectionBuilder.ts`, and
`broker.ts` remain `vscode`-free.

Verification: `npx vitest run test/unit/pluginHostRelay.test.ts test/unit/webviewConvention.test.ts
test/unit/webviewPreviewCatalog.test.ts`; `npm run typecheck`; `npm test`; `bash scripts/check-engine-boundary.sh`
— all passed. SDD verify logged the three declared gates below.

### Gesture blocker — parent-side userActivation gate: CLOSED, PASS (2026-07-04)

The relay gesture gate was empirically re-tested in a real Chrome/Puppeteer harness after discovering the T10
implementation was listening for `pointerdown`/`click` on the outer `<iframe>` element. Clicks inside the opaque
`srcdoc` document do not bubble to that element, so the old `recentGestureUntil` relay state was never a reliable
signal and `focusAgent` could be rejected as `user_gesture_required`.

`test/integration/plugin-ui.e2e.test.ts` now includes a browser-level proof at the exact host boundary: the
plugin frame first sends a delayed programmatic `postMessage` claiming `userGesture:true`, then the test performs
a real mouse click inside the sandboxed `srcdoc` iframe. The parent relay stamps the outgoing host message from
`navigator.userActivation.isActive`, not from the plugin's claimed field. Verdict: **PASS** — the delayed
programmatic post leaves `userGesture:false`; the real click inside the opaque sandbox reaches the parent with
`userGesture:true`. No `allow-same-origin` was introduced.

Implementation change is intentionally surgical: `src/webview/plugin-host/main.tsx` removed the ineffective
outer-iframe event listeners and now computes `userGesture` while handling the plugin action message in the
parent relay:
`message.userGesture === true && navigator.userActivation.isActive === true`.

Testing gotcha: direct CDP reads such as `page.evaluate(() => navigator.userActivation.isActive)` can themselves
observe an active state in automated Chrome. The e2e therefore lets the programmatic iframe timer fire without
polling the parent first, then reads the already-stamped relay message.

Verification: `npm run build`; `npx vitest run test/integration/plugin-ui.e2e.test.ts`; `npm run typecheck`;
`npm test`; `bash scripts/check-engine-boundary.sh` — all passed.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- See `spec.md` § Open questions — all routed to `plan`.

## Verification log

### 2026-07-04T19:42:01Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm test` — pass
- `bash scripts/check-engine-boundary.sh` — pass

### 2026-07-04T19:43:10Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm test` — pass
- `bash scripts/check-engine-boundary.sh` — pass

### 2026-07-04T19:56:25Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm test` — pass
- `bash scripts/check-engine-boundary.sh` — pass

### 2026-07-04T19:57:40Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm test` — pass
- `bash scripts/check-engine-boundary.sh` — pass

## Dogfood log

### 2026-07-04T21:43:30Z — fail (0/1) — source: tasks.md — commit: b6577c74194ea8353101f22387e86f8e4299e23b
- `vitest run test/integration/plugin-ui.e2e.test.ts` — fail

### 2026-07-04T21:45:07Z — fail (0/1) — source: tasks.md — commit: b6577c74194ea8353101f22387e86f8e4299e23b
- `vitest run test/integration/plugin-ui.e2e.test.ts` — fail

### 2026-07-04 — pass (1/1) — MANUAL record (auto-runner false-negative), commit b6577c7
- `vitest run test/integration/plugin-ui.e2e.test.ts` — **pass (4/4 sub-tests)**: userActivation click-vs-programmatic · adversarial breach-all-fail in the real relay · Mundinho install+render+focusAgent · relay teardown/recreate.
- The two `fail` entries above are false-negatives from the `sdd-dogfood.sh` wrapper: at the time it ran, the shared main working tree's `npm run build` / `dist/` was non-deterministic because of a **concurrent, unrelated** in-flight Task Studio refactor (a dangling `taskStudioMessage` import in `scripts/webview-preview/routes.ts` after another agent removed the export), which fails the whole `npm run build` before `dist/webview/plugin-host.js` is reliably present for the e2e's `beforeAll` bundle check.
- The e2e itself passes **4/4 on every direct run** with the bundle present — proven at HEAD `b6577c7` in an isolated `git worktree` (full typecheck + `npm run build` OK + 737 tests + e2e 4/4) AND directly in the main checkout. The failure is purely the wrapper × shared-tree build-state race, not the dogfood behaviour.
