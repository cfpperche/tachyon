# Spec 250 — Tachyon multi-runtime plugin system (capabilities become installable plugins)

**Status:** shipped
**Closure:** Plugin system v1 shipped end to end; commit `538dde82` reconciles the header and parent checkboxes with the existing task closure.
**Status detail:** SHIPPED (v1) → **the build skeleton lives in [`system-design.md`](./system-design.md)**. After the codex dueto (NEEDS-REVISION, folded in `notes.md`) the maintainer **simplified away the abstraction layer**: a Tachyon plugin is an **aggregate of each runtime's NATIVE config block** (parity, no abstraction — "runtimes never reach 100% parity, so don't abstract"), it **depends on Tachyon**, persists in the workspace **committed by default**. v1 = **runtime blocks only (claude + codex)**, own claude/codex layouts; engine-bindings (`tachyon/`) + gemini deferred to v2. Security/trust + lockfile + first-class uninstall are in v1. All steps (1-5) are SHIPPED — engine + adapters + updater + sourcing + Plugins View; v1 complete end to end (see **Closure** in `tasks.md`).
**Superseded framing below:** the original DRAFT's "capability-intent + per-runtime materialization" abstraction and "installer-not-runtime-dep" goal were dropped — kept only as decision history.
**Original status:** DRAFT (pre-codex dueto)
**Follows:** 245/246/214 (existing capability chokepoints), pins p-0e8a06 (configure env w/ skills/rules/hooks), p-45a846/p-af7105 (marketplace), p-54cdb8 (agents author skills), p-16058c (don't pollute the repo / state location)
**Surface (new subsystem):** a manifest format, an install/update/remove engine, a per-runtime wiring executor, a Tachyon **Plugins view**
**UI impact:** flow (a new Plugins view: browse marketplace → install/update/remove → runtimes gain the capability)

> **Origin.** Tachyon's roadmap — a plugin/agent marketplace (p-45a846/p-af7105), an agent/pipeline builder (p-5e0ff3), agents that author their own skills/tools (p-54cdb8), and configuring a workspace's skills/rules/hooks through the UI (p-0e8a06) — all need one thing that does not exist yet: a **packaged, installable, multi-runtime capability unit**. A plugin bundles a runtime's native config (hooks/skills/MCP) for one or more runtimes; Tachyon owns the install/update/remove **lifecycle** and executes each plugin's **declared** wiring into each runtime's own config. Capabilities run in the runtime's own layer (hooks wired into `.claude`/`.codex`, skills read by the agent) — Tachyon is the package manager, not the reimplementer. Plugins are **content** that lives in their own repos / the marketplace; this spec is the **engine + format** in the Tachyon repo, which ships with **no bundled plugins**.

## Problem

Today, giving a workspace's agents a capability (a hook, a skill, an MCP server) is manual and per-runtime: you hand-edit `.claude/settings.json` or `.codex/hooks.json`, with no record of what came from where and no clean way to undo it. There is no packaged unit you can pick, install through the Tachyon UI, declare which runtimes it supports, and update/remove without clobbering your own edits. Tachyon's roadmap (marketplace, builder, agents-author-skills) needs exactly that **packaged, installable, multi-runtime capability unit** — which doesn't exist.

## Goal

A **plugin** = a manifest + bundled capabilities (skills / rules / hooks / tools / MCP / commands) that **declares, per capability, which runtimes it supports** (claude / codex / gemini / …). Through a Tachyon **Plugins view**, a user installs/updates/removes a plugin into a workspace; Tachyon **executes the plugin's declared wiring** into each present, compatible runtime's config so **the runtimes gain the capability** — including when Tachyon is later closed (Tachyon is the *installer*, not a runtime dependency). The `sync-harness` reconciliation becomes the plugin **updater** (don't clobber local edits). Multi-runtime **without forcing a runtime**: a plugin honestly declares `claude+codex+gemini`, or `codex`-only, or `claude`-only.

## Prior art (researched 2026-06-22 — Claude Code's plugin system; verified vs live docs)

Claude Code already ships a plugin model — **study it as INSPIRATION for proven patterns, NOT as a compat target or superset (maintainer-corrected; see D1). A Tachyon plugin is its own, higher-abstraction multi-runtime artifact, not a CC plugin.**
- **Manifest** `.claude-plugin/plugin.json` (name/version/description/components). Components: skills, agents, hooks, MCP, commands, …, by directory convention.
- **Hooks (the key precedent):** a plugin declares hooks in `hooks/hooks.json` (or inline) — **event + script** — and the runtime **auto-wires** them at session start, *no manual settings editing*. This IS the "plugin declares, the runtime executes the wiring" model. **Claude auto-wires; codex/gemini have NO native plugin loader → Tachyon performs that wiring for them.** ← the multi-runtime differentiator.
- **Install model = hybrid:** plugin files in an out-of-repo cache (`~/.claude/plugins/cache/`) + **committable enablement** (`enabledPlugins` in `.claude/settings.json`) + a **marketplace source** → **re-hydrate on clone**. No lockfile; updates clobber the cache.
- **Marketplace** `marketplace.json`; sources = relative path / GitHub / git URL / git-subdir / npm; `/plugin` installs.
- **Claude-specific bits to generalize:** hook event surface, hook types, settings/credential shape, `.mcp.json` format, directory conventions, skill namespacing, marketplace `strict` mode.

## Decisions (proposed — to pressure-test)

- **D1 — Tachyon-NATIVE plugin format; Claude Code's plugin system is INSPIRATION only, NOT a compat target/superset.** (OQ1 — maintainer-corrected 2026-06-22, overriding the dueto's superset recommendation) A Tachyon plugin is a *different artifact* at a *higher abstraction* than a CC plugin: a CC plugin is a bag of **claude-rendered** files (its hook already says `PostToolUse`); a Tachyon plugin declares **capability-intent + per-runtime materialization rules** that the adapters render into each runtime. So Tachyon does NOT ingest CC plugins or maintain a CC-compat boundary — it borrows CC's proven *patterns* (manifest fields, hook-declaration shape, marketplace sourcing, cache+committed-enablement, the lockfile gap) and designs its own, multi-runtime-first. ("Install CC plugins for free" is weak value — a CC plugin is claude-only by construction and advances the multi-runtime thesis zero.)
- **D2 — The plugin declares the wiring; Tachyon mechanically executes it.** Per the maintainer: incompatibilities/wiring details are the **plugin author's** responsibility; Tachyon only applies the declared mapping (event+script → `.claude/settings.json` / `.codex/hooks.json` / gemini-equivalent). Tachyon is a dumb, reliable wiring executor — never a per-runtime-semantics expert.
- **D3 — Per-capability `runtimes:` in the manifest.** A plugin lists supported runtimes per capability; the Plugins view greys-out/​warns on a capability whose runtimes aren't present in the workspace. Honest degradation, never silent.
- **D4 — `sync-harness` 3-way-merge becomes the updater.** Its "stale auto-update / customized-refuse-without-force" intelligence is the plugin update engine — the hard part is already solved.
- **D5 — The Tachyon repo ships NO bundled plugins; plugins are content that lives elsewhere.** The engine + format live here; concrete plugins (first-party or third-party) live in their own repos / the marketplace, each declaring its supported `runtimes:`. The agentskills.io tiers + a conformance check are the **plugin-author contract**. What any first-party plugin contains is a separate, later, content decision — not part of this engine.

## Open questions for the codex dueto

- **OQ1 — build-vs-adapt (the central design fork).** "Design our own manifest" vs "adopt Claude Code's plugin format + extend it to multi-runtime." Claude Code's plugin system already does manifest+hooks+commands+skills+MCP+marketplace for claude. Is a Tachyon-native manifest justified, or should Tachyon's plugin literally BE a Claude-Code-plugin superset (so claude plugins install as-is, and the `runtimes:` extension adds codex/gemini)? Weigh dev cost + ecosystem compatibility (a CC-plugin would install in Tachyon for free) vs control. *(memory discipline: explicitly weigh build-own vs adapt.)*
- **OQ2 — state-in-repo / portability (the crux that gates everything).** Claude Code's hybrid (cache out-of-repo + committed enablement + marketplace re-hydrate) works for claude because **claude re-hydrates natively**. **codex/gemini have no native re-hydrator** → for them, either (a) the materialized wiring+files are **committed** to the workspace (teammate inherits on clone, works without Tachyon — but "pollutes" the repo, the p-16058c concern), or (b) Tachyon must re-hydrate them (Tachyon becomes a runtime dependency for non-claude — contradicting "installer, not runtime dep"). Resolve precisely, likely **per-runtime**: claude rides its cache+settings; non-claude materializes committed. Is committed-for-non-claude acceptable, or does p-16058c (own-subrepo/supabase) force a different store?
- **OQ3 — what exactly is "committed" vs "managed"?** Minimal committed unit = the enablement/marketplace-source declaration (so intent travels by clone) + the non-claude wiring. Heavy payloads (plugin bodies) = cache/re-fetch. Is a **lockfile** needed (Claude Code has none — a real gap for reproducibility)?
- **OQ4 — do cross-plugin invariants fragment?** If a set of capabilities is genuinely coupled (e.g. a handoff + delegation + memory triad), loose plugins could be half-installed. A **bundle/meta-plugin** (a plugin whose only content is `dependencies: [...]`) can group them so they install together — but that is *content* in a plugin repo, demand-gated, and out of this engine's scope (the engine already supports `dependencies`). *Resolved: not an engine concern.*
- **OQ5 — the wiring executor's reliability across runtimes.** Even with declared wiring, the engine needs per-runtime knowledge (WHERE each runtime's config lives, codex's tool-name matchers vs claude's, idempotent re-apply, exact removal). *Resolved by per-runtime adapters (Step 4): the author declares the native block; the adapter owns targets/merge/uninstall.*

## Non-goals

- Reimplementing capabilities in Tachyon's code (the migration finding: they stay runtime-wired; Tachyon manages lifecycle).
- A magic visual plugin *builder* (p-5e0ff3) — authoring stays file/manifest-based for v1; the view installs/updates/removes.
- The marketplace *monetization* (p-45a846) — this spec is the plugin + install mechanics; the paid marketplace is a later layer on top.
- Forcing any runtime — a plugin honestly declares its supported runtimes (D3).

## Risks

- **R1 — reinventing Claude Code's plugin system** at high cost for marginal gain (OQ1). Mitigation: adopt-and-extend (D1); justify every Tachyon-native divergence.
- **R2 — repo pollution vs portability** unresolved → either dirty repos or Tachyon-locked non-claude runtimes (OQ2). Mitigation: per-runtime materialization policy, decided in the dueto.
- **R3 — the wiring executor silently mis-wires** a runtime (wrong event, non-idempotent re-apply, orphan on uninstall) (OQ5). Mitigation: a tight executor contract + idempotent apply/remove + tests per runtime.
- **R4 — coupled capabilities half-installed** as loose plugins (OQ4). Mitigation: an optional bundle/meta-plugin (content in a plugin repo, not the engine) if real invariants need it.

## Acceptance (v1 shape — pending dueto)

- [ ] A manifest format (CC-superset or Tachyon-native, per OQ1) with a per-capability `runtimes:` declaration; a verbatim example plugin (e.g. the `/sdd` skill) round-trips through it.
- [ ] Install/update/remove from a Tachyon Plugins view: install wires the declared capabilities into each present compatible runtime; **a claude+codex workspace gains the capability in both**; removal leaves no orphan wiring (idempotent).
- [ ] The installed capability **works with the Tachyon extension closed** (proves installer-not-runtime-dep), per the OQ2 materialization policy.
- [ ] Update reuses the 3-way-merge (stale auto-updates; a locally-edited plugin file refuses without force).
- [ ] OQ1 (build-vs-adapt), OQ2 (state/portability), OQ5 (executor contract) resolved + recorded in `notes.md`.
- [ ] Pure parts (manifest parse/validate, runtime-compat resolution, wiring diff) unit-tested; one real install→use→update→remove cycle smoke-tested against a real claude + a real codex in a real workspace.
