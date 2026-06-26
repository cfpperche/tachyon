# 270 — configurable-plugins

_Created 2026-06-26._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **Debate (2026-06-26) — verdict: SHIP-WITH-CHANGES; ratified.** See `debate.md`. Folded below: the
> security-relevant lane (271's trust policy) is **not** carried by the untrusted plugin manifest — its **schema +
> path are first-party, Tachyon-owned code** (§ Two lanes). Open v1-scope call (OQ6) + lifecycle gaps (config-only
> install eligibility `engine.ts:406`, update/remove of user-edited config, schema-bytes storage) tracked in Open
> questions. Co-developed with the 271 redesign as one vertical slice.

## Intent

Let a plugin declare **human-facing configuration** and a **documentation URL**, and give the Plugins view the
surface to view/edit that config — so a plugin can ship knobs the human owns instead of being a fixed black box.
This is the spec-250-family primitive that turns "install a plugin" into "install + configure a plugin". Its first
real consumer is the `agent-browser` per-site trust policy (spec 271), which rides this editing UX while keeping
its **enforcement** in a separate, launcher-owned lane (see § Two lanes).

Today `PluginManifest` (`src/plugins/manifest.ts:112-130`) has no `config`, config-schema, or `docsUrl` field; the
Plugins webview card (`src/plugins/viewModel.ts:38-52`) exposes only update/remove/reinstall actions derived from
status — no Config button, no Docs button; install (`src/webview/PluginsPanel.ts`) has no post-apply navigation; and
the card view-model is **lockfile-driven**, so any config/docs metadata it shows must be persisted in the lockfile,
not re-derived from the payload at render time.

**Governance invariant (non-negotiable, owner-stated):** the human OWNS configuration. A plugin *declares* the
shape of its config (schema + default + docs); the human *authors* the values through Tachyon. Manifest parsing is
the **untrusted marketplace boundary** (`src/plugins/manifest.ts:7`) — every new field validates fail-closed, and
nothing a plugin declares may become a channel the **agent** uses to relax a security decision. Configurable
plugins must EXTEND the consent/lockfile/launcher trust spine, never open a new agent-reachable bypass.

**Two lanes (the A5 separation — folded from codex review 2026-06-26):**
- **Generic config** — convenience config a plugin declares (schema/default/format). Editable by the human (and, as
  an accepted same-user residual, by the agent); validated fail-closed on load; **not** a security input.
- **Security-relevant config** — a launcher-enforced policy artifact (spec 271's trust profiles). Its **schema AND
  storage path are first-party, Tachyon-owned code — NOT derived from the plugin manifest** (debate, 2026-06-26): an
  untrusted manifest must never shape a security schema/default, or the plugin author silently shapes the policy the
  human "owns". It lives at a Tachyon-owned fixed path the plugin may not choose, is read+validated by the launcher,
  and is never a runtime-readable file the plugin/agent can repoint. This spec ships the **editing UX + metadata**
  (the Config button can open a first-party-managed file); spec 271 ships the **schema + enforcement**. The UI is
  shared; the trust schema/semantics are not.

**Done** = a plugin can declare `config?: { format, schema, default? }` + top-level `docsUrl?`; install validates
them fail-closed, surfaces them in consent, and records the config descriptor + docsUrl in the lockfile; the
Plugins card shows a **Config** button (opens the real config file in an editor with schema-validation) and a
**Docs** button (`https://`-only, via `vscode.env.openExternal`); and after a **successful** apply of a
config-declaring plugin the view auto-opens its config editor (with the `default` seeded so the plugin works even
if the human closes it immediately).

## Acceptance criteria

- [ ] **Scenario: a plugin declares config + docsUrl; the manifest validates fail-closed**
  - **Given** a manifest with `config: { format: "json", schema: <JSON Schema>, default?: <value> }` and
    `docsUrl: "https://…"`
  - **When** the manifest loads
  - **Then** it validates: `format` ∈ {`"json"`} in v1 (YAML deferred — see Non-goals), `schema` is a well-formed
    JSON Schema within size caps, `default` (if present) validates against `schema`, `docsUrl` is `https://` only
    (reject `command:`/`file:`/extension URIs and non-https), no control chars, size-capped. Unknown/malformed
    fields are rejected (a pre-270 Tachyon already rejects unknown manifest fields — forward-safe).

- [ ] **Scenario: consent surfaces config/docs; the lockfile records them**
  - **Given** an install of a config-declaring plugin
  - **When** the consent drawer renders and the install applies
  - **Then** consent states the plugin ships configuration + a docs link; and the lockfile records the config
    descriptor (format + resolved config-file path + a hash/ref to the schema) and `docsUrl`, so the
    lockfile-driven card view-model can render the buttons without re-reading the payload.

- [ ] **Scenario: the Plugins card shows Config + Docs buttons (conditional)**
  - **Given** an installed plugin
  - **When** the card renders
  - **Then** a **Config** button appears **only** if the plugin declared config, and a **Docs** button appears
    **only** if `docsUrl` is present; Docs opens the URL via `vscode.env.openExternal` and is `https://`-guarded at
    click time (defense in depth, not only at parse).

- [ ] **Scenario: editing config opens the real file with live schema validation**
  - **Given** the human clicks **Config**
  - **When** the editor opens
  - **Then** it opens the actual on-disk config file in a VS Code editor tab with the plugin's JSON Schema
    associated (live validation), **not** a webview form (deferred). Editing config does **not** re-run install
    consent and is **not** part of the install fingerprint (config is meant to change — an edit must not read as
    "drift").

- [ ] **Scenario: post-apply auto-navigation (only on success, default seeded)**
  - **Given** a successful apply of a plugin that declares config
  - **When** the install completes
  - **Then** the view auto-opens that plugin's config editor; the `default` was materialized so the plugin
    functions if the human closes the editor immediately. Auto-nav never fires on a failed/aborted apply.

- [ ] **Scenario: config fails closed, not open**
  - **Given** a config file that is missing or fails schema validation at load
  - **When** the plugin's consumer reads it
  - **Then** the consumer sees an **invalid** result (the engine surfaces it — e.g. a card status — never a silent
    "open/permissive" fallback). Malformed convenience config degrades safely; a security-relevant config (spec
    271) fails **closed** (deny/confirm, never bypass).

- [ ] **Scenario: the security lane is reserved, not opened (the 271 hook)**
  - **Given** the generic config mechanism
  - **Then** a plugin may **not** point its config at an arbitrary path for a security-relevant artifact, nor
    inject a runtime-readable policy file the launcher would trust; security-relevant config is assigned a
    **Tachyon-owned fixed path** (defined + enforced by spec 271). This spec only guarantees it does **not** create
    a generic agent-reachable policy-relaxation channel.

## Non-goals

- A schema-driven **webview form** builder — v1 edits the raw file in an editor with schema validation (deferred).
- **YAML** with live schema validation — JSON only in v1 (YAML may open in an editor later, but equal live
  validation is not guaranteed; deferred).
- Runtime config **hot-reload** beyond "applies on next plugin launch/read".
- The agent-browser **trust-policy semantics + launcher enforcement** — that is spec 271 (this spec is the generic
  config/docs/nav primitive it builds on).
- Any per-plugin config that becomes a generic agent-writable input to a security decision (forbidden by the
  governance invariant; the security lane is Tachyon-owned, spec 271).

## Open questions

- **OQ1 — invalid-config surfacing.** A new card status kind (`config-invalid`) vs reusing `error`/`unknown`? Lean:
  a distinct, non-blocking status so a bad config is visible but doesn't masquerade as an install failure.
- **OQ2 — generic config storage.** Exact path (`.tachyon/plugins/<name>/config.json`?) and whether it is committed
  (consistent with the committed payload) vs gitignored per-machine. Lean: committed under the payload root, like
  the rest of the plugin's materialized state.
- **OQ3 — schema association mechanism.** How VS Code associates the plugin's JSON Schema with an arbitrary on-disk
  file: a `json.schemas` settings contribution (workspace) vs an in-memory schema provider vs opening with a
  `yaml`/`json` language mode + injected schema. Determine the least-invasive VS Code API path.
- **OQ4 — coupling to 271.** Does 270 ship a "this config is Tachyon-owned/security-relevant" marker in the config
  descriptor (so the editor opens the fixed path), or does 271 special-case the agent-browser open-target entirely?
  Lean: 270 records the resolved config path in the lockfile; 271 sets that path to the Tachyon-owned location and
  wires the launcher — minimal coupling, co-developed as a vertical slice.
- **OQ5 — docsUrl trust.** Beyond `https://`-only, do we warn before opening an external URL the plugin author
  controls (consistent with how Tachyon treats other plugin-supplied strings)? Lean: open directly (the human
  clicked), but never auto-open docs without a click.
- **OQ6 — v1 scope: schema engine vs simpler (debate + reinforced by 271's scope reduction).** Codex argues v1
  should NOT ship a manifest-embedded JSON-Schema engine at all — a configurable plugin ships a **payload default
  config file + `docsUrl` + an optional display label**, and Tachyon copies/opens it (associating whatever schema
  the editor can use). The only v1 consumer, 271 (reduced to "expose agent-browser's native config"), brings its
  **own published schema** (`agent-browser.dev/schema.json`, pinned per tool version) — so Tachyon needs **no
  authored schema and no generic schema engine** for v1. Strong lean: v1 = config-file + `docsUrl` + label +
  optional editor schema-association from a plugin-supplied schema **file**; add a manifest schema engine only when
  a real second consumer needs it. Resolving this also closes the lifecycle gaps (config-only install eligibility at
  `engine.ts:406`; update/remove of a user-edited config; where the schema **bytes** live — a plugin-supplied file,
  not a manifest field).
