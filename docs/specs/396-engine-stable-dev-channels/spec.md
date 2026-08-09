# 396 — engine-stable-dev-channels

_Created 2026-07-17._

**Status:** shipped
**Closure:** Shipped in `3aec3223` + `c0df667d`: production is stable-only from exact clean `main`, worktree builds are isolated dev-only, same-version stable byte drift refuses, and Dev Host upgrade/rollback plus cleanup passed dogfood; final `npm test` passed 4,742 tests with 3 skipped.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm exec vitest run test/unit/packageCleanGate.test.ts test/unit/engineServiceProtocol.test.ts test/unit/engineBundleStore.test.ts test/unit/engineSupervisor.test.ts test/unit/devHostBoundary.test.ts test/unit/devHostPointer.test.ts test/unit/devHostLauncher.test.ts test/unit/controlInspector.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run check:engine-boundary`
**Verify:** `npm test`
**Dogfood:** `scripts/dev-host/cli.sh headless`

## Intent

Tachyon currently records a clean Git commit in every packaged engine bundle, but it does not distinguish a
production build from a clean worktree build.  A VSIX produced from an isolated candidate can therefore become
the maintainer's day-to-day engine, while a same-version bundle with different bytes is silently treated as a
compatible engine.  This makes the origin of the persistent backend ambiguous and lets Dev Host artifacts cross
the production installation boundary by accident.

Introduce two explicit engine channels.  `stable` is the only channel accepted by an installed production
extension and can only be built from a clean primary checkout whose `HEAD`, local `main`, and cached
`origin/main` are identical.  `dev` is the default local/worktree build, is accepted only by an Extension
Development Host rooted in a marked Dev Host fixture, and uses isolated cache/state/data roots.  The user still
installs one VSIX; the embedded stable engine remains zero-step and upgrades with the existing rollback path.

## Acceptance criteria

- [x] **Scenario: stable packaging comes only from canonical main**
  - **Given** a dirty checkout, linked worktree, non-`main` branch, or a `HEAD` different from local/cached remote `main`
  - **When** stable engine packaging is requested
  - **Then** the build fails before emitting or packaging a stable bundle and explains the violated source invariant
- [x] **Scenario: installed production accepts only stable**
  - **Given** a production extension containing a `dev`, legacy-unmarked, malformed, or provenance-mismatched engine manifest
  - **When** the extension stages its packaged engine
  - **Then** staging is refused before the running production engine is changed
- [x] **Scenario: worktree development stays in Dev Host**
  - **Given** a normal worktree build
  - **When** it runs through the marked Dev Host lane
  - **Then** its manifest is `dev`, its state/data/cache roots are private to that lane, and it can start or refresh a dev engine without touching the stable engine
- [x] **Scenario: development cannot attach to an ordinary workspace**
  - **Given** an Extension Development Host pointed at an unmarked production workspace
  - **When** Tachyon attempts to connect its packaged dev engine
  - **Then** it fails with an actionable Dev Host isolation error before engine supervision
- [x] **Scenario: same version cannot hide different production bytes**
  - **Given** a stable engine is running and a different stable bundle declares the same version
  - **When** the supervisor classifies the desired bundle
  - **Then** it refuses with a version/content conflict instead of silently reusing either bundle
- [x] **Scenario: iterative dev rebuilds remain usable**
  - **Given** a dev engine and a different dev bundle with the same version
  - **When** the marked Dev Host reconnects
  - **Then** the existing controlled transition adopts the new dev bundle and retains rollback behavior
- [x] **Scenario: migration preserves the installed zero-step flow**
  - **Given** the current legacy-unmarked stable engine is running
  - **When** a strictly newer stable VSIX built from `main` is installed
  - **Then** the extension upgrades it automatically and can still reopen the legacy bundle for rollback
- [x] The engine manifest and live identity expose `stable` or `dev`; absence remains readable only for legacy migration/rollback.
- [x] Stable packaging embeds commit/tree/channel provenance matching the exact source checkout.
- [x] The standard user flow remains install extension → open workspace; no CLI or second installer is introduced.

## Non-goals

- Cryptographically attest that a local same-UID builder is trustworthy; this is an operational provenance boundary.
- Build the broader governed outward-release system from spec 371.
- Make the engine execute source files directly from `main`.
- Automatically merge the implementation branch or install a candidate worktree VSIX into the daily environment.
- Add non-Linux persistent-engine support.

## Open questions

- None.  The maintainer selected `stable` from `main` and `dev` via Dev Host in the originating conversation.
