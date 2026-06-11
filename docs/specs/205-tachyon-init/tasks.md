# 205 — tachyon-init — tasks

_Generated 2026-06-10._

## Implementation

- [x] 1. initLogic.ts: DetectedProject type, STACKS recipes, buildStarterYaml → commented string
- [x] 2. Unit tests: 6 stacks + node-scripts + no-manifest minimal + parseConfig round-trip
- [x] 3. extension.ts: tachyon.init command (multi-root pick, refuse-if-exists, write + open)
- [x] 4. package.json: command + viewsWelcome (empty tachyonAgents) + 0.5.0; nls/l10n
- [x] 5. Integration: Init writes valid config in a temp folder; refuses on re-run
- [x] 6. Manual validation (no harness): npm typecheck + build + vitest + xvfb integration

## Verification

- [x] Unit suite green (init generation + round-trip)
- [x] xvfb integration: Init scenario green
- [x] Generated yml for each stack parses clean (parseConfig errors == [])

## Notes

Built in ~/tachyon pre-harness; SDD artifacts authored by hand.
