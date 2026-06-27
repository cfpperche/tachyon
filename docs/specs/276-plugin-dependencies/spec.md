# 276 — plugin-dependencies

_Created 2026-06-27._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **Honesty correction (twice over — shell-truncated greps):** spec 275 claimed "no plugin-dependency mechanism"
> (wrong); this spec's first draft then claimed it's "never parsed" (also wrong). REALITY (codex-confirmed against
> the code): a manifest declares `dependencies` as a STRING array `["name@range"]`, and `manifest.ts parseDep`
> ALREADY parses each into `PluginDep {name, range}`. The FORMAT and the PARSE both exist — what's MISSING is the
> CHECK (against installed plugins) + the SURFACE (consent drawer). This spec adds ONLY those two. (Surfaced by the
> owner: the visual-qa install drawer showed nothing about its agent-browser reliance.)
>
> **Codex design dueto (2026-06-27) — SHIP-WITH-CHANGES, folded** (`…20260627T204143Z-…`): word it as a DECLARED
> requirement surfaced at install, NOT an installer-enforced gate; DIRECT-only + explicit; the lockfile DOES store
> plugin `version` so v1 checks semver (`semver` is available); install/update-time only (stale-after-removal is
> documented, runtime warning a follow-up); dependency declarations are plugin-AUTHOR CLAIMS, not endorsements;
> a DEDICATED "requires" section (not folded into generic warnings).

## Intent

Implement the dormant manifest `dependencies` field: **parse** it, **check** the declared DIRECT dependencies
against installed plugins (+ their versions) at install/update time, and **SURFACE** them in the consent drawer —
so the human sees "requires agent-browser ^2.1.0 — not installed" BEFORE confirming, instead of discovering it as a
runtime `unable_to_judge`.

**Declared requirement surfaced at install — NOT an enforced gate, NOT an npm cascade.** `dependencies` is a
DECLARED runtime requirement the drawer SHOWS; it is not installer-enforced. Tachyon does NOT auto-install deps
(a cascade would silently multiply the consent/trust surface — one install pulling N others). The human installs the
dependency themselves; this spec makes the requirement VISIBLE. The UI copy is "Declared requirement / may not work
until installed", never "cannot install". Declarations are the plugin AUTHOR's claims, NOT trusted endorsements.

## Components

1. **Parse — ALREADY DONE** (`manifest.ts parseDep`): a manifest declares `dependencies: ["name@range"]` (string
   array) and the parser ALREADY turns each into `PluginDep { name, range }`, fail-closed. No parse work needed —
   just consume `plugin.manifest.dependencies`.
2. **Check** (`previewInstall`, `engine.ts`): for each DIRECT declared dependency, look up `lockfile.plugins[name]`.
   Classify: `satisfied` (present AND `semver.satisfies(lock.version, range)`), `out-of-range` (present, version not
   in range), or `missing`. NO transitive walk (deps-of-deps are NOT inspected).
3. **Surface** (`consentViewModel` + Install drawer webview): a DEDICATED **REQUIRES** section listing each direct
   dependency as ✓ satisfied / ⚠ out-of-range / ⚠ missing, with its range. Non-blocking — install proceeds on
   confirm. No "trusted" copy; no install-by-name affordance that bypasses the normal provenance/consent flow.
4. **Wire the real consumer:** add `"dependencies": ["agent-browser@^2.1.0"]` (string form) to the visual-qa
   manifest; correct spec 275's "no mechanism" wording.

## Lifecycle (folded from codex)

- Checked at **install/update time only** (the drawer reads the current lockfile). NO background enforcement.
- **Stale-after-removal is known + documented:** removing a dependency later can leave a dependent's requirement
  unmet, and the drawer won't retroactively warn. A runtime "declared dependency missing" hint when a dependent
  plugin RUNS is a cheap FOLLOW-UP, not v1.
- Removing a plugin **does NOT cascade-remove dependents** (no reverse-dependency action).

## Acceptance criteria

- [ ] **Parsed fail-closed:** `dependencies: [{name, range}]` parses (kebab name + non-empty range); malformed
  rejected; omitted → `[]`.
- [ ] **Direct-only check, 3 states:** for each DIRECT dep — `satisfied` (in lockfile + version in range),
  `out-of-range`, or `missing`. No transitive walk.
- [ ] **Surfaced, non-blocking:** the drawer's REQUIRES section shows each dep's state; a missing/out-of-range dep
  does NOT block install (install proceeds on confirm); copy says "declared requirement / may not work until
  installed", not "cannot install".
- [ ] **No auto-install:** confirming installs ONLY the chosen plugin; no dependency is fetched.
- [ ] **visual-qa wired:** visual-qa declares `agent-browser@^2.1.0`; its drawer shows the requirement (missing when
  agent-browser isn't installed, ✓ when it is at a compatible version); spec 275's "no mechanism" wording corrected.

## Open questions — RESOLVED (codex leans folded)

- **OQ1 (range):** check semver — `PluginLock.version` exists + `semver` is available, so v1 evaluates the range
  (satisfied / out-of-range), not presence-only.
- **OQ2 (block vs warn):** non-blocking SURFACE in v1; do not oversell as enforced. A future `optional`/`recommends`
  vs hard-`requires` distinction is out of scope.
- **OQ3 (placement):** a DEDICATED "REQUIRES" section in the drawer (not folded into generic warnings — satisfied
  vs missing must be scannable).
- **OQ4 (transitive):** DIRECT deps only; no transitive walk, no cascade; the UI/docs state this explicitly.

## Non-goals

- npm-style automatic / transitive dependency INSTALLATION (the cascade — explicitly rejected).
- Blocking/gating an install on a missing dependency (v1 surfaces, never blocks).
- A registry / version-resolution service; conflict resolution; reverse-dependency (cascade-remove) actions.
- Background/runtime dependency enforcement (a runtime "missing dep" hint is a possible cheap follow-up).
