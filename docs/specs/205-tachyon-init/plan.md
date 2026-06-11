# 205 — tachyon-init — plan

_Drafted 2026-06-10. (Built in ~/tachyon before the Agent0 harness was injected — SDD discipline held by hand: artifacts + npm typecheck/build/vitest/xvfb, no /sdd automation.)_

## Approach

A pure `src/init/initLogic.ts`: given a `DetectedProject` (which manifest files
exist + their parsed/relevant content + which AI CLIs are installed), produce a
commented `tachyon.yml` STRING. Detection of "what's present" is the only I/O,
isolated in the command handler; everything that decides the config is pure and
unit-tested. The command `tachyon.init` reads the folder, builds the detection
input, calls initLogic, refuses if a config exists, writes the file, and opens
it. A `viewsWelcome` block gives the empty Agents view an "Initialize" button.

## Files to touch

**Create:**
- `src/init/initLogic.ts` — STACKS table (manifest → detector + terminal recipes), `buildStarterYaml(input)` → commented yml string
- `test/unit/init.test.ts` — per-stack generation, Node scripts → terminals, no-manifest minimal, round-trip through parseConfig

**Modify:**
- `src/extension.ts` — `tachyon.init` command (folder QuickPick when multi-root, refuse-if-exists, write+open); register
- `package.json` — command contribution + `viewsWelcome` for `tachyonAgents` when no config; 0.5.0 (new command, no tool-schema change so no upgrade-notice)
- nls (en + pt-BR) + l10n bundle
- `test/integration/extension.test.js` — Init writes a valid config in a temp folder and refuses on re-run

## Stack recipes (v1, 6)

- **node** (package.json): agent + shell; terminals from scripts.dev/start (watch: src/**) and scripts.test; dep hints (next/vite/etc) only flavor the comment.
- **php** (composer.json): `php artisan serve` if laravel/laravel in require, else `php -S localhost:8000`.
- **rust** (Cargo.toml): `cargo run` (watch: src/**).
- **go** (go.mod): `go run .` (watch: **/*.go).
- **python** (pyproject.toml | requirements.txt): `python main.py` / generic, commented to adjust.
- **ruby** (Gemfile): `bin/rails server` if rails present, else `ruby main.rb`.
- **fallback** (none): agent + shell only.

## Alternatives considered

### Interactive QuickPick before writing
Rejected (user call): generate-direct + open-for-review is lower friction; the commented yml teaches and is trivially editable. A wizard adds steps for a file you'll read anyway.

### A webview wizard
Overkill for an S onboarding command; the file IS the surface.

## Risks and unknowns

- Detected scripts/commands are best-effort guesses — mitigated by heavy comments telling the user to adjust, and a valid-by-construction minimum.

## Research / citations

- VSCode `contributes.viewsWelcome` (empty-view onboarding button).
- Reuses existing `detectInstalledClis` (cliDetect) + `parseConfig` round-trip.
