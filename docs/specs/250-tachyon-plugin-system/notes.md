# Spec 250 — notes

## Codex dueto (2026-06-22) — NEEDS-REVISION
Transcript: `Agent0/.agent0/.runtime-state/codex-exec/20260622T235813Z-dueto-250-plugin-system/`.

D1 (adopt-and-extend Claude Code's shape, not green-field) is directionally right. Four things block shippability: state portability, runtime adapter boundaries, uninstall/idempotency, trust model.

### Revisions that change a MAINTAINER-stated position (surface before folding)
- **D2 REVISED — "Tachyon is a runtime-dumb wiring executor" is FALSE.** The maintainer said "wiring is the plugin author's problem; Tachyon just executes the declared mapping." The dueto: that's a leaky abstraction — Tachyon MUST know where/how to write `.claude/settings.json`, `.codex/hooks.json`, gemini config, MCP blocks, hook matchers, removal markers; codex/gemini differ at the event/tool surface (codex keys off `apply_patch` + JSON hook output, not Claude's `Edit`/stderr). **Resolution: per-runtime ADAPTERS** (`claude-adapter`/`codex-adapter`/`gemini-adapter`). The author declares **portable capability + optional runtime overrides**; the adapter owns filesystem targets, schema validation, idempotent merge, conflict detection, uninstall, safety preview. (Honors "author declares" but Tachyon is NOT dumb.)
- **OQ2 RESOLVED — "don't pollute the repo" (pin p-16058c) YIELDS for v1.** The "installer-not-runtime-dep" goal and p-16058c are in DIRECT conflict for codex/gemini (no native re-hydrator). No clean resolution exists; pick one. **v1 = committed *managed* materialization for non-claude runtimes**: a narrow, clearly-marked generated area + a manifest header + uninstall support + an explicit repo-diff preview before write. p-16058c (own external store / supabase) becomes a LATER alternative only if Tachyon owns an external rehydration store. → claude rides its native cache+settings; non-claude commits a managed area.

### BLOCKERs
1. **OQ2 state portability** — resolved above (committed managed materialization for non-claude).
2. **OQ5 runtime adapters** — resolved above (not dumb; per-runtime adapters).
3. **Security/trust model — MISSING ENTIRELY (the draft's real gap).** Installing a plugin wires arbitrary shell hooks + MCP servers from a marketplace = code execution on future agent events inside repos with secrets. v1 MUST require: trust prompts, source provenance, a permission summary, hook/MCP **diff preview** before write, dangerous hooks disabled-by-default, signed/pinned source metadata where possible, a workspace trust boundary. **No silent auto-enable from a remote marketplace.**

### HIGH
4. **Lockfile needed** (`tachyon.plugins.lock.json`): source, resolved commit/version, integrity hash, generated targets, adapter versions, enabled capability set. Claude survives without one (it owns the rehydrator); Tachyon can't (reproducibility + uninstall + drift detection across runtimes).
5. **Agent0 dissolution fragments invariants.** handoff + delegation + memory + lifecycle hooks are a coupled contract today; as loose plugins you can install `/sdd` without the substrate it assumes. **Ship an `agent0-core` bundle/meta-plugin** with a dependency graph; `/sdd` DEPENDS on core capabilities, not merely documents them.
6. **Uninstall must be first-class.** If Tachyon can't remove exactly what it installed without clobbering user edits, the system rots. (Ties to the lockfile's `generated targets`.)

### Folded OQ answers
- **OQ1 — dueto said "CC superset"; MAINTAINER OVERRODE 2026-06-22 → Tachyon-NATIVE format, CC = inspiration only.** The dueto's superset argument (install CC plugins for free) is weak: a CC plugin is claude-rendered + claude-only by construction, so it advances the multi-runtime thesis zero, and a superset couples Tachyon to claude's schema churn + conflates two abstraction levels. A Tachyon plugin declares **capability-intent + per-runtime materialization** (higher abstraction); a CC plugin is a bag of pre-rendered claude files (lower). Borrow CC's *patterns* (manifest fields, hook-declaration shape, marketplace, cache+enablement, lockfile-gap), own the format. The dueto's "own a portable intermediate model internally" survives — it just becomes the WHOLE model, with no CC-compat boundary to maintain (simpler).
- **OQ2** — no clean resolution; "no pollution" yields for v1 (committed managed materialization for non-claude). 
- **OQ3** — yes, lockfile required.
- **OQ4** — yes, fragmentation is real; `agent0-core` meta-plugin + dependency constraints.
- **OQ5** — per-runtime adapters; author owns high-level mapping + overrides, Tachyon owns targets/validation/idempotent-merge/uninstall/preview.

### The simpler v1 the dueto recommends (scope cut)
**Claude-compatible package ingestion + a CODEX adapter ONLY + committed managed materialization + lockfile + security prompts. Defer GEMINI until one non-claude path is proven end-to-end.** Prove the multi-runtime thesis on exactly one non-claude runtime first.

## Decisions — RATIFIED by maintainer 2026-06-22
- **D-FORMAT (overrides dueto OQ1)** — Tachyon-NATIVE plugin format; CC = inspiration only, not a superset/compat target.
- **D-POLLUTION** — accepted with flexibility: **committed materialization in the repo, OR declaration-in-repo + external cache** (hybrid). v1 may pick committed materialization (simplest, honors installer-not-runtime-dep); the external-cache variant is a valid alternative the design can offer. p-16058c (external store) is no longer a blocker — it's one of the accepted shapes.
- **D-DUMB** — accepted: Tachyon owns per-runtime adapters; the plugin author declares portable intent + optional runtime overrides.
- **D-SCOPE** — accepted: claude + codex for v1; gemini deferred until one non-claude path is proven end-to-end.
- **Security/trust model** — folded into v1 scope (was a BLOCKING omission): trust prompt + provenance + permission summary + hook/MCP diff preview + dangerous-disabled-by-default + no silent remote auto-enable.
