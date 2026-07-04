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

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- See `spec.md` § Open questions — all routed to `plan`.
