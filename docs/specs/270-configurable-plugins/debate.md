# 270 — debate

_Adversarial review, 2026-06-26. Participant: codex (repo-grounded red-team), adversarial mode (the prior design
review had largely agreed). Cross-checked against the 271 red-team, since 270's first consumer is 271's security
policy._

## Verdict: **SHIP-WITH-CHANGES** (generic config) — but do **not** let it carry 271 security-policy semantics.

## Strongest objection

**Wrong abstraction boundary.** The spec frames "plugin-declared schema/default" as a harmless UX primitive, but
the first real consumer is a **security policy**. The spec says generic config is not a security input and the
security lane is separate (`spec.md:28`), yet also says 271 rides this same editor/metadata path and may set the
resolved policy path via the lockfile descriptor (`spec.md:117`). That invites a confused implementation where an
**untrusted plugin manifest** (the marketplace boundary, `manifest.ts:7`) owns the **schema + default** for a
launcher-enforced policy.

Concrete failure: `agent-browser` ships a permissive/confusing trust-policy schema+default; Tachyon
auto-materializes it and opens the editor after install (`spec.md:76`); the human closes it; the launcher later
treats that plugin-authored default as "human policy". The agent never edited the policy — but the **plugin author
shaped the security decision**.

## The change insisted on

**Remove manifest-declared `schema`/`default` from the 271 path.** The agent-browser trust-policy **schema and
fixed path must be first-party, Tachyon-owned code** — never derived from the (untrusted) plugin manifest. Generic
convenience config may stay plugin-declared; a security-relevant artifact may not.

## Simpler alternative (codex argues for it)

Do **not** ship a manifest-embedded JSON-Schema engine in v1. A configurable plugin ships: a **default config file
in its payload**, an optional **docs URL**, and maybe a **display label**. Tachyon copies + opens the file (with
whatever schema association the editor can provide). No generic schema engine, no manifest `default`, no lockfile
schema refs. For `agent-browser`, Tachyon owns the schema + path in first-party code. This still delivers the
owner's want — low-friction, human-owned config + a Docs button — with far less machinery and no
untrusted-manifest-in-the-security-path risk.

## Under-specified (will bite at implementation)

- **Config-only plugins won't install today:** `loadPlugin` requires at least one capability
  (hooks/skills/MCP/git-hooks/tools) — `engine.ts:406`. Does "ships config" count as a capability? Undefined.
- **Lifecycle gaps:** committed vs gitignored config (`spec.md:111`, still OQ2); **update** behavior for a
  user-edited config (does a plugin update clobber it?); **remove** behavior (delete the human's config?); JSON
  Schema **draft/`$ref`/remote-ref** handling; the lockfile stores a "schema ref/hash" but live editor validation
  needs the **schema bytes** — where do they live?
- Current installed-state types have **no config field**: `PluginLock` (`lockfile.ts:64`) and the card VM
  (`viewModel.ts:18`) are status-only — both must gain config/docs metadata for the buttons to render from the
  lockfile-driven view.

## What changes for the spec

- Add an explicit invariant: **security-relevant config schema + path are first-party-only** (type-enforced), never
  manifest-derived. This is the structural fix the 271 redesign depends on.
- Decide v1 scope: full manifest JSON-Schema engine vs the simpler payload-file + docsUrl + label. (Lean: start
  simpler; add a schema engine only if a second consumer needs it.)
- Close the lifecycle gaps (install eligibility for config-only, update/remove of user-edited config, schema-bytes
  storage) before tasks.

**Status:** spec.md to be revised (first-party-only security lane + v1-scope decision + lifecycle) — folded with the
271 redesign as one vertical slice, pending owner ratification.
