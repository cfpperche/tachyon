# 349 — plugin-ui-surfaces — plan

_Drafted from `spec.md` on 2026-07-03. Hardened by a second adversarial dueto (codex-plan-review, 2026-07-03 — see `notes.md` § Dueto review 2). The approach, not the steps (those go in `tasks.md`)._

## Approach

Seven components, sequenced so the **trust-boundary skeleton lands and is adversarially proven before** the Mundinho is built on top:

1. Manifest — a new `views` capability block **+ a self-contained entry-HTML validator** (D9).
2. Engine — view targets threaded through **every** `preview → consent → apply` gate (D2), not just "registered".
3. Consent — a `views` section + per-scope / per-action acknowledgements (incl. the terminal-reveal disclosure, D6).
4. Rendering — the opaque-origin iframe, delivered as a **tested CSP contract** (D4).
5. Projection — a pure type module + a builder + the canary test (D5).
6. Broker — generation-stamped opaque handles + one gesture-gated, rate-limited action (D6).
7. Author story + the adversarial fixture + the Mundinho dogfood.

The plugin ships prebuilt, self-contained assets; **Tachyon never compiles plugin code**. Every new trust-sensitive path reuses the existing fail-closed engine (parse → preflight → stage → hash → consent → fingerprint → apply) rather than inventing a parallel one.

## Key decisions

- **D1 — `views` is a runtime-agnostic, top-level manifest block** — chosen because a UI surface isn't tied to the Claude/Codex agent runtimes, so it sits at the manifest top level like `gitHooks`/`tools`/`data`, not under `blocks` (`Partial<Record<Runtime,string>>`). Shape: `views?: ViewDecl[]`, `ViewDecl = { id, title, surface:"editor"|"sidebar", entry:<contained .html path>, icon?, fleet:"summary", actions?: string[] }`, parsed fail-closed like the existing block parsers (`validContainedPath`, byte/list caps, `KNOWN_FIELDS` closure — `manifest.ts`). Rejected putting it in `blocks` because that couples UI to a runtime (a UI plugin may declare zero runtimes).

- **D2 — View targets thread through EVERY two-phase engine gate (not just "registered")** — chosen to inherit the TOCTOU guard AND remain installable/removable. *(Dueto-2 blocker: a views-only plugin currently dies in the "nothing to install" / ack / lockfile gates that only know hooks/skills/MCP/git-hooks — `engine.ts:410/1053/1289`.)* The build MUST wire `views` into, explicitly: (1) `loadPlugin`'s **capability count** (`engine.ts:410`) so a views-only plugin is a valid install; (2) `InstallPreview.viewTargets` + `fingerprintOf(...)` (`:776/858/994`); (3) the **install ack gate** (`checkInstallAckGates`, `:1053`); (4) the **no-op / "nothing to install" guard** in `applyInstall` (`:1289`); (5) a **lockfile `MaterializedTarget`** so the surface has a removable identity; (6) `previewUpdate`/`previewRemove` + `applyRemove` **cleanup** (unregister + revoke). The entry `.html` is a content-addressed payload file — validated by the existing preflight **and** the new D9 validator.

- **D3 — Consent gets a `views` section with layered, honest acknowledgements** — reuse the blocking drawer + token TOCTOU (`consentViewModel.ts:7`). Extend `ConsentVM` (`:154`) with `views?: ConsentView[]` plus `requiresViewConfirm` and per-action `requiresActionConfirm` (alongside `requiresMcpConfirm`/etc. `:188-206`). Copy is honest and includes the reveal semantics from D6: *"draws UI in your editor, reads a name-free summary of your fleet, and can ask Tachyon to open (reveal) an agent's terminal to you."*

- **D4 — Rendering is a TESTED CSP CONTRACT, not a promise (the #1 gate)** — chosen for strong isolation with no asset server. The outer surface is a first-party Tachyon webview acting as a dumb, authority-less relay; the plugin's prebuilt document mounts as `<iframe sandbox="allow-scripts" srcdoc="…self-contained html…">` — `sandbox` **without `allow-same-origin`** ⇒ opaque origin (no parent DOM, storage, or network; the Fase-0 footgun is exactly `allow-scripts`+`allow-same-origin`, never set). *(Dueto-2 blocker: `renderWebviewShell` today has NO `frame-src` and only adds `child-src blob:` on request — `shell.ts:51`. Left abstract, an implementer reaches T10 with a blank frame and relaxes the sandbox to "fix" it.)* Therefore T1 is a **contract gate** whose deliverable is: (a) the exact `renderWebviewShell` CSP change (adding the minimal `frame-src`/`child-src` for a `srcdoc` frame) **proven by a parsed-CSP test**; (b) a test that the `srcdoc` frame renders **without** `allow-same-origin`; (c) the plugin document loads **no** `asWebviewUri`/`vscode-webview-resource` — sub-resources inline as `data:` only (under opaque origin + `connect-src 'none'` it can't fetch). Message path is two hops, host holds authority: `plugin iframe → Tachyon relay (postMessage) → extension host (broker+projection)`. Rejected: `blob:` document (equivalent isolation, extra object-URL lifecycle); a **separate served origin** (needs an asset server + port mgmt per session — too much surface for v1).

- **D5 — Projection: a PURE type module + a builder that type-only-imports `FleetVM`** — chosen to make "allowlist not denylist" structural without a TS contradiction. *(Dueto-2: a `toPluginProjectionV1(fleet: FleetVM)` builder must reference `FleetVM`, so the type can't literally "not import it" if they share a file.)* Split: `src/plugins/ui/projectionTypes.ts` (PURE — `PluginFleetProjectionV1` with **zero** `FleetVM` reference, so its shape can never structurally derive from it) and `src/plugins/ui/projectionBuilder.ts` (a **type-only** import of `FleetVM`, erased at compile — respects `check-engine-boundary.sh` since it stays vscode-free). Type: `{ v:1, generation:number, agents:{handle,label,status,attention?,badges}[], counts:{...} }` — no real names/paths/commands/ports/hashes; `label` is a stable per-(plugin,session) pseudonym so the Mundinho renders distinct characters without learning real fleet naming (`sidebar/types.ts:22` stays host-side); `handle` is the opaque routing token; `generation` stamps the projection (D6). Guarded by a **canary test** on the builder: a poisoned `FleetVM` (sentinels in every sensitive field) → assert none appear in `JSON.stringify(projection)`.

- **D6 — Broker: generation-stamped opaque handles + ONE gesture-gated, rate-limited action** — chosen so the action channel physically cannot reach privileged dispatch and cannot be auto-fired. New `src/plugins/ui/broker.ts` (PURE core) mints per-(plugin,session) opaque handles → `{wsHash,agent}`, **each stamped with the current projection `generation`**; on `{handle,action,generation}` it (1) rejects a **stale generation** (handle from an old projection after update/remove/churn — *Dueto-2 should-fix*); (2) requires `action` ∈ consented allowlist; (3) resolves handle→target internally (rejects any raw name/`wsHash`/path); (4) invokes a **narrow callback injected by `host.ts`** — the broker holds NO reference to `ACTION_CMD`/`executeCommand` (`SidebarPrototype.ts:59/340`). v1's single action = **`focusAgent`** → `tachyon.openAgentTerminalItem` (`SidebarPrototype.ts:334`). *(Dueto-2 blocker: this reveals the agent's RAW tmux session content to the user — `Terminals.open`, `Terminals.ts:40` — so it is a plugin-driven reveal, abusable via auto-focus-on-load or flood-focus DoS.)* Mitigations, mandatory: it fires **only on a user gesture inside the surface** (never auto on load/message), is **rate-limited/debounced**, and the consent copy says "can reveal terminal contents to you" (D3). Destructive ids (stop/kill/restart/delete/removeWorktree/createPr) are v2 non-goals; broker carries a rejection test **driven by the `ActionId` enum** (not hand-copied strings — *Dueto-2 should-fix*), asserting each is refused.

- **D7 — Two surfaces: editor panel is runtime; sidebar needs a pre-declared generic host** — editor panel via `createWebviewPanel` at runtime, lazy on a command (`SidebarPrototype.ts:239`), no static contribution. But VS Code requires `contributes.views` with `"type":"webview"` **statically in package.json** — a dynamically-installed plugin can't add one. So Tachyon pre-declares **one generic "Plugin Surfaces" WebviewView host** (mirroring `tachyonSidebarPrototype`) that dynamically renders active sidebar surfaces; the plugin registers *into* it. **Possible cut (Dueto-2 nice-to-have):** if T1/T10 slip, ship **editor-panel-only in v1** — the trust-boundary proof stays smaller.

- **D8 — Author story + adversarial fixture** — authors build a self-contained `.html` and develop against `scripts/webview-preview/` with a fixture `PluginFleetProjectionV1` (`routes.ts`/`preview.ts` reuse shared envelope constructors). v1 ships a documented postMessage contract + the fixture; a formal SDK is deferred. The **adversarial plugin fixture** attempts: network egress, parent-DOM/storage access, sensitive-field reads, out-of-allowlist actions, **and focusAgent abuse (auto-fire-on-load + flood)** — each proven to fail.

- **D9 (new, Dueto-2 should-fix) — a strict self-contained entry-HTML validator at preflight** — chosen as defense-in-depth so egress is blocked at INSTALL, not only caught by CSP at runtime + the adversarial test "too late". The existing payload preflight only rejects symlink/special/size/depth (`engine.ts:207`). Add a validator that rejects an entry `.html` bearing URL-carrying attributes: `<script src>`, `<link href>`, remote/`vscode-webview-resource` URLs, `form action`, nested `<iframe>`, `<object>/<embed>`, workers, and import maps — allowing only inline scripts/styles and `data:` assets. Runs at preview/preflight so a hostile payload is refused before consent.

## Files touched

- `src/plugins/manifest.ts` — `ViewDecl` type + fail-closed parser + `KNOWN_FIELDS` entry.
- `src/plugins/entryHtmlValidator.ts` (new, D9) — the self-contained-HTML validator + tests.
- `src/plugins/engine.ts` — `views` in the capability count (`:410`), `viewTargets` in `InstallPreview`/`fingerprintOf`/ack gate (`:1053`)/no-op guard (`:1289`)/lockfile target/`previewUpdate`/`previewRemove`/`applyRemove`.
- `src/plugins/consentViewModel.ts` — `ConsentView` + `views`/`requiresViewConfirm`/`requiresActionConfirm` + reveal copy.
- `src/plugins/ui/projectionTypes.ts` (new, PURE) + `projectionBuilder.ts` (new, type-only FleetVM) + `projection.test.ts` (canary on the builder).
- `src/plugins/ui/broker.ts` (new, PURE) + `broker.test.ts` (enum-driven `ACTION_CMD` rejection + raw-authority + stale-generation + focusAgent-abuse).
- `src/plugins/ui/host.ts` (new) — surface lifecycle (register/unregister/revoke), injects the `focusAgent` reveal callback + gesture/rate-limit gate.
- `src/webview/shared/shell.ts` — the D4 CSP change (frame-src/child-src for the srcdoc frame), guarded by a parsed-CSP test.
- `src/webview/plugin-host/*` (new) — the thin first-party relay bundle + esbuild entry + `surfaces.ts` registration.
- `package.json` — the generic "Plugin Surfaces" sidebar view + a `tachyon.openPluginSurface` command (D7).
- `scripts/webview-preview/` — a projection fixture for author dev + our own preview.
- Test fixtures — the adversarial plugin + the Mundinho plugin (dogfood).

## Risks & unknowns

1. **srcdoc / opaque-origin CSP contract (D4)** — highest. T1 is a hard gate: no downstream task starts until the CSP change + isolation tests are green. If `srcdoc` can't render without `allow-same-origin`, fall back (blob:/served origin) before Phase 4.
2. **Engine gate integration (D2)** — a views-only plugin must survive capability-count, ack, no-op, lockfile, and removal gates; missing one = uninstallable or unremovable. Enumerated in T2/T3.
3. **`focusAgent` reveal semantics (D6)** — a plugin-driven reveal of raw terminal content; mitigated by gesture-gating + rate-limit + honest consent, proven by the adversarial fixture.
4. **Projection leak-by-regression (D5)** — mitigated structurally (pure type module + canary); every future field addition must keep the canary green — call it out in the module header.
5. **Scope size** — large spec; tasks must keep skeleton-before-Mundinho and the single-action / summary-scope / editor-first cuts firm.

## Visual impact

This spec renders UI: the consent drawer's new `views` section (incl. the reveal disclosure), the outer relay surface, and the iframe'd plugin content in an editor panel and the sidebar host. Visual risk = the consent copy must legibly disclose UI + fleet + reveal-action scopes, and the surfaces must render in light/dark. Also capture the T1 blank-vs-loaded iframe trace (CSP bugs on this path masquerade as "UI didn't render"). Proof via `scripts/webview-preview/` screenshots + a real install of the Mundinho/adversarial fixtures.

## Sources consulted

- `src/plugins/manifest.ts` — `PluginManifest` blocks, fail-closed parse, `validContainedPath`, `loadPlugin` "≥1 capability" (:372/410).
- `src/plugins/engine.ts` — `previewInstall:858`, `applyInstall:1026`, `fingerprintOf:776`, the ack gate `:1053`, the no-op guard `:1289`, payload preflight `:207`, two-phase contract (:9-10).
- `src/plugins/consentViewModel.ts` — `ConsentVM:154`, per-capability arrays + `requires*Confirm:188-206`, token echo (:7).
- `src/webview/SidebarPrototype.ts` — `renderWebviewShell` use (:110/280), `resolveWebviewView:103`, `push:136`, `createWebviewPanel:239`, `ACTION_CMD:59` / `executeCommand` dispatch (:340), `openAgentTerminalItem` reveal (:334).
- `src/presentation/Terminals.ts:40` — `Terminals.open` attaches/reveals the raw tmux session (the focusAgent reveal semantics).
- `src/webview/shared/shell.ts:51` — the nonce CSP shell (no `frame-src` today; the D4 change site).
- `src/sidebar/types.ts:22` — `AgentVM`/`FleetVM` sensitive fields feeding the projection audit.
- Fase-0 research report + Dueto reviews 1 & 2 — `notes.md`.
