# 349 — plugin-ui-surfaces

_Created 2026-07-03._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

**Closure:** v1 shipped 2026-07-04 (commits `ba073fb` T1 iframe gate · `72bd22e` Phase 1 declaration/engine/consent/validator · `2dbd97d` Phase 2 projection · `2f269c1` Phase 3 broker · `fec26c0` Phase 4 host+relay · `776e673` fix-up activation/guards · `efd740f` Phase 5 fixtures+gesture · `b6577c7` lifecycle hardening). The untrusted-plugin UI primitive: a plugin declares a `views` capability, consents per-scope, and renders in an opaque-origin `srcdoc` iframe (never `allow-same-origin`) fed a purpose-built `PluginFleetProjectionV1` (never `FleetVM`, canary-proven), with one non-destructive `focusAgent` action brokered via generation-stamped opaque handles and gated on trusted `navigator.userActivation` (empirically proven to cross the sandbox). Proven end-to-end by `test/integration/plugin-ui.e2e.test.ts` (real engine install → productionized relay → adversarial breach-all-fail + Mundinho render + gesture broker + relay teardown/recreate). Verified in an isolated worktree at HEAD: full typecheck + build + 737 tests + engine-boundary, all green. **Residuals (honest):** the sidebar surface is covered by relay-inheritance + the host registration-path unit test rather than a full `vscode-test` `WebviewView` e2e (the relay is byte-identical to the editor surface); the editor panel re-opens via command rather than a `WebviewPanelSerializer` window-reload restore. Real Mundinho art/engine is deferred to `p-2ab0f3`; v2 scope (destructive actions, egress, fine scopes, author SDK) is `p-af2b39`.

**Verify:** `npm run typecheck`
**Verify:** `npm test`
**Verify:** `bash scripts/check-engine-boundary.sh`
**Dogfood:** `vitest run test/integration/plugin-ui.e2e.test.ts`

> **DRAFT — ready for ratification.** Drafted from the design conversation + the Fase-0 research
> report (`notes.md`), then hardened by an adversarial dueto review (claude-2 + ad-hoc codex-review,
> 2026-07-03 — see `notes.md` § Dueto review). Q0 (v1 action scope) **resolved 2026-07-03**: one
> non-destructive, opaque-handle-targeted action. No blocking questions remain.

## Codex adversarial review fold-in (2026-07-04)

The 2026-07-04 Codex adversarial review raised three blockers against the draft intent. Each is
folded here in the house style as an explicit disposition:

1. **ACCEPT WITH RESOLUTION — Action broker v1 was underspecified.** The plugin→host channel is the
   central attack surface, so v1 is constrained to exactly one non-destructive action,
   `focusAgent`. The contract is: actions are declared in `views[].actions`, consented per action,
   invoked only by a trusted user activation observed by the first-party relay, rate-limited, and
   resolved through generation-stamped opaque handles minted by the host. The broker rejects raw
   names, `wsHash`/folder hashes, paths, stale generations, malformed payloads, unconsented action
   ids, flood attempts, and every privileged sidebar action id. The broker never imports or calls
   `ACTION_CMD`, `executeCommand`, or any first-party dispatch table.

2. **ACCEPT WITH RESOLUTION — The iframe/resource model was opaque.** v1 uses a first-party relay
   webview that mounts plugin HTML as a self-contained `srcdoc` iframe with
   `sandbox="allow-scripts"` and **never** `allow-same-origin`. The relay owns CSP assembly, strips
   author CSP, nonce-stamps inline plugin scripts, sets `connect-src 'none'`, and allows no network
   or VS Code resource fetches from the plugin document. Entry HTML is preflighted before consent so
   remote URLs, nested iframes, workers, forms, import maps, and external scripts/styles are rejected
   before render. The invariant is falsifiable: browser tests prove the frame renders, remains at an
   opaque origin, cannot reach parent DOM/storage/network, and still uses only postMessage.

3. **ACCEPT WITH RESOLUTION — FleetVM leakage needed adversarial proof.** Plugins never receive
   `FleetVM`, an `AgentVM`, or a denylist-filtered derivative. They receive only
   `PluginFleetProjectionV1`, a purpose-built positive contract containing pseudonymous labels,
   opaque handles, coarse status/attention/badges, counts, and a generation stamp. The projection
   type is split away from the builder so the plugin-facing type has no `FleetVM` reference; the
   builder may type-only-import the host model to translate it. A canary test poisons every sensitive
   fleet field (`worktree`, commands, runbook steps, topology, persistence paths, pins, proposals,
   handoff, bridge port, folder/workspace hashes, and raw names) and asserts that no sentinel appears
   in the serialized plugin projection.

## MAINTAINER DECISIONS NEEDED

> **RATIFIED by the maintainer 2026-07-06 — all four accepted as written** (the conservative v1
> options). v1 ships exactly one brokered action, the strict opaque-origin sandbox, the pseudonymous
> `PluginFleetProjectionV1`, and the adversarial security-proof bar. 349 is cleared for plan → tasks.

These decisions were recorded for explicit maintainer ratification. The implementation notes
below reflect these choices:

- Ratify that v1 is **not read-only**: it includes exactly one brokered action, `focusAgent`, because
  proving the bidirectional broker is part of the primitive; destructive actions remain v2.
- Ratify the render model: self-contained opaque-origin `srcdoc` under the first-party relay, no
  `allow-same-origin`, no network egress, no author-supplied CSP authority, and no external resource
  loading in v1.
- Ratify the data model: `fleet:read` in v1 means only `PluginFleetProjectionV1` with pseudonymous
  labels and opaque handles; no raw fleet identifiers, paths, commands, pins, handoff, or bridge
  routing keys are exposed.
- Ratify the security proof bar: adversarial fixture + browser isolation tests + projection canary +
  broker rejection tests are required for this primitive; the Mundinho render is dogfood, not the
  boundary proof.

## Intent

Today a Tachyon plugin (spec 250) can only contribute **headless** capabilities consumed by the
agent runtimes — skills, provisioned tools/binaries, data artifacts, external tools, git hooks,
config, MCP config. The `PluginManifest` has **no primitive for contributing a UI surface**: a
plugin cannot paint a webview in the editor, and it cannot read live fleet state. Painting pixels
is, today, exclusively a core-extension concern (`contributes.views` / `WebviewPanel` registered in
the extension host). This blocks a whole class of experiences — the motivating one being the
"Mundinho dos Agentes" (pin `p-2ab0f3`): a webview that materializes what each agent is doing right
now and calls the human's attention. We do not want that (opinionated, optional) UX baked into the
always-loaded core; it should ship as a plugin. And we expect more UI-plugins to follow.

The gap (pin `p-0828d6`) is a **new plugin primitive: an untrusted third-party plugin contributes a
webview UI surface into the Tachyon extension AND receives a curated, live view of the fleet — safely.**

The organizing constraint is the **trust boundary**, not the rendering. Tachyon already renders
webviews nine times over; what's new is doing it for an **untrusted marketplace author** who is
untrusted on *both* sides (the rendered HTML *and* the message handler). Unlike VS Code — which
trusts the extension's Node side and only sandboxes the HTML — Tachyon cannot let a plugin's message
handler run with Tachyon's authority. "Done" is: a plugin declares a UI surface + the data/action
scopes it wants; the human consents per-scope at install (reusing the existing two-phase consent
spine); the surface renders in an **origin-isolated iframe** (never `allow-same-origin`) with a strict
CSP and no network egress; it receives a **purpose-built, versioned projection** of the fleet (a type
that does not derive from `FleetVM`) over a host-brokered channel; and any action it requests is
resolved through **opaque, capability-bound handles** and a **curated allowlist brokered by the host**
— never Tachyon's raw privileged dispatch, never a raw agent name / `wsHash` / path as authority. The
"Mundinho dos Agentes" ships as the **first consumer**, alongside an **adversarial plugin fixture**
that actively tries to break the boundary, as the security proof.

## Acceptance criteria

_v1 scope hardened by the dueto. Action scope decided (Q0, 2026-07-03): exactly one non-destructive,
opaque-handle-targeted brokered action; destructive actions are v2._

- [x] **Scenario: A plugin declares a UI surface and each scope is consented separately**
  - **Given** a manifest declaring a `views` capability (surface type, entry asset, `fleet:read` scope, and — if any — a named action allowlist)
  - **When** the human installs the plugin
  - **Then** the existing two-phase consent drawer shows **separate acknowledgements** for (a) painting UI in the editor, (b) reading a curated view of the fleet, and (c) *each* requested action — and nothing renders or brokers until consent is granted

- [x] **Scenario: The surface is origin-isolated in a falsifiable way**
  - **Given** a consented UI plugin
  - **When** its surface opens (editor panel or sidebar view)
  - **Then** the plugin's HTML/JS runs in a nested iframe with a **unique/opaque origin** — the sandbox **never** includes `allow-same-origin` — under a strict nonce CSP with `connect-src 'none'`, loading assets only from the plugin's contained payload dir
  - **And** a test **fails** if the framed document can reach the parent DOM, shared storage, or the network

- [x] **Scenario: The plugin receives a purpose-built projection, leak-proof by construction**
  - **Given** an open UI plugin with `fleet:read`
  - **When** the fleet state changes
  - **Then** the plugin receives a host→UI push of a **`PluginFleetProjectionV1`** value — a dedicated type that does **not** import or structurally derive from `FleetVM` (allowlist by construction, never a denylist), stamped with a contract version
  - **And** a **canary test** feeds a poisoned `FleetVM` with sentinel values in every sensitive field (`worktree`, `sub`/`cmd`, `runbooks[].steps`, `parent`, `persistenceHooks.path`, `pins`, `proposals`, `handoff`, `bridge.port`, `folder.hash`/`wsHash`) and asserts **no sentinel appears** in the serialized projection

- [x] **Scenario: An action targets an opaque handle and is brokered, never raw-dispatched**
  - **Given** an open UI plugin consented for a specific non-destructive action
  - **When** the plugin requests that action against an **opaque, session-scoped handle** the host emitted (bound to the consented capability)
  - **Then** a host-side broker resolves the handle→workspace/agent internally, validates the request against the consented allowlist, and executes it
  - **And** the broker **rejects** any request that supplies a raw agent name / `wsHash` / path as authority, targets an id outside the allowlist, or is malformed — with **no side effects**; the plugin channel can never reach the first-party privileged `executeCommand` / `ACTION_CMD` dispatch (`SidebarPrototype.ts`)

- [x] **Scenario: Update / disable / uninstall revokes the live channel**
  - **Given** a consented, open UI plugin
  - **When** the plugin is updated (esp. adding an action or changing the entry asset), disabled, or uninstalled
  - **Then** open frames are closed, handles + channels are revoked, and any scope/asset change requires **fresh consent** before the surface reopens

- [x] **Scenario: A hostile asset payload is rejected before render**
  - **Given** a plugin whose entry asset references a resource outside the payload, an `http(s)`/`vscode-resource` URL, an oversized `data:`/worker, a form submit, or its own nested iframe
  - **When** the plugin is preflighted/installed
  - **Then** manifest preflight validates the entry (contained path, allowed MIME/extension, per-asset byte cap, expected CSP) and **refuses** the offending payload

- [x] **Scenario: A misbehaving surface is contained (hang, crash, AND flood)**
  - **Given** an open UI plugin
  - **When** it hangs, crashes, **or floods** the host with high-rate / oversized messages
  - **Then** Tachyon (holding source-of-truth) tears down / recreates the iframe without corrupting host state; host↔UI RPC is async-only with correlation-id + timeout; and inbound messages are **rate-limited + byte-capped with a bounded queue and drop policy** — no side effects under flood

- [x] The `views` capability rides the existing plugin machinery: fail-closed manifest parse (path containment, byte/list caps, `KNOWN_FIELDS` closure), payload preflight/stage/sha256/lockfile, and `preview→consent→apply` with the fingerprint TOCTOU guard — no new trust-boundary code paths that bypass them.
- [x] The primitive supports **both** an editor-area panel surface and a sidebar/panel view surface, declared per-plugin, each with explicit register/unregister/restore behavior.
- [x] An **adversarial plugin fixture** ships in the test suite: it attempts network egress, parent-DOM/storage access, reading sensitive fields, and out-of-allowlist actions — and every attempt is proven to fail.
- [x] The "Mundinho dos Agentes" (`p-2ab0f3`) is implemented **as a plugin** against this primitive and renders live fleet state end-to-end (the functional dogfood proof — distinct from the adversarial fixture above).

## Non-goals

- **Not** exposing `FleetVM`/`AgentVM` (or any denylist-filtered derivative) to plugins — only the purpose-built `PluginFleetProjectionV1`.
- **Not** accepting a raw agent name, `wsHash`, `folder.hash`, or path from a plugin as routing authority — only opaque host-emitted handles.
- **Not** giving plugin UI access to `vscode.commands.executeCommand` or the sidebar `ACTION_CMD` dispatch.
- **Not** including **destructive** actions (stop / kill / restart / delete / removeWorktree / createPr) in v1 — deferred to v2 regardless of Q0's outcome.
- **Not** allowing network egress from plugin surfaces in v1 (`connect-src 'none'`). A Figma-style `networkAccess` allowlist is deferred.
- **Not** compiling plugin-authored TypeScript — plugins ship prebuilt, integrity-pinned assets served read-only.
- **Not** solving cross-plugin composition, plugin↔plugin messaging, or a plugin-UI marketplace/discovery UX.
- The **art/engine** of the Mundinho (2D vs 3D isometric, canvas vs engine) is out of scope here — tracked in `p-2ab0f3`.

## Open questions

- **Q0 — v1 action scope. RESOLVED 2026-07-03 → option (a):** exactly one non-destructive, opaque-handle-targeted brokered action, with rejection tests for every sidebar id. Keeps the bidirectional channel (proves the broker) without a destructive surface. Destructive actions are v2.
- **Iframe hosting mechanics:** the *mechanism* (opaque-origin `srcdoc` / `blob:` / distinct served origin) and how contained assets reach the frame **without** `allow-same-origin`. The spec pins the invariant (above); the mechanism is a `plan` decision. → `plan`
- **Projection granularity:** whether `fleet:read` is one curated scope in v1 or splits into `fleet:summary` (counts/status) vs `fleet:agents` (per-agent). Leaning summary-first for least-privilege. → `plan`
- **Action vocabulary & consent tier:** if Q0=(a), which single action, how it's named/declared, and the consent tier relative to MCP/tool/git-hook. → `plan`
- **Asset build story for authors:** how authors build/preview their surface (reuse `scripts/webview-preview/` against fixture VMs) given Tachyon won't compile their TS. → `plan`
- **Local action audit:** whether v1 keeps a local per-plugin/action/target/outcome audit log (nice-to-have from the dueto). → `plan`
