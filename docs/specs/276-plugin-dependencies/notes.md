# 276 — notes

## Honesty correction
Earlier (spec 275 + dogfood) I claimed Tachyon has NO plugin-dependency mechanism — WRONG (a shell-truncated grep).
`PluginManifest.dependencies: PluginDep[]` (`{name, range}`) exists in the TYPE but is never parsed/wired. Codex
was right the field exists; I was right it isn't enforced. This spec implements the behavior + corrects 275.

## Integration points (verified)
- `PluginManifest.dependencies: PluginDep[]` (`{name:string, range:string}`) — declared, NOT parsed (manifest.ts).
- `Lockfile.plugins: Record<pluginName, PluginLock>`; `PluginLock.version: string` exists → semver check feasible.
- `semver` is require-able (works); not yet imported in src (may need a direct dep or an existing version util).
- `previewInstall` (engine.ts) reads the lockfile → the place to compute dep states.
- `consentViewModel.ts` has the `requiresXConfirm`/`warnings` pattern → add a `requires` section there + the drawer.

## Codex design dueto — SHIP-WITH-CHANGES (`…20260627T204143Z`), folded
- Word it "declared requirement surfaced at install", NOT installer-enforced; UI copy "may not work until installed".
- DIRECT-only + explicit (no transitive walk).
- Lockfile HAS `version` → v1 checks semver (satisfied / out-of-range / missing), not presence-only.
- Lifecycle: install/update-time only; stale-after-removal documented; runtime hint a follow-up; no cascade-remove.
- Trust: declarations are plugin-AUTHOR claims, not endorsements; no "trusted" copy, no install-by-name bypass.
- Dedicated REQUIRES drawer section (not generic warnings).

## Build plan
manifest.ts (parse) → a pure `dependencyStates(deps, lockfile)` helper (semver) + tests → previewInstall wires it →
consentViewModel `requires` → drawer webview REQUIRES section → visual-qa manifest dep + correct 275 wording.
