# 401 — pi-private-home — notes

## Decisions and measurements

- Pi's shipped `dist/config.js` defines `PI_CODING_AGENT_DIR` as the root for settings, auth, models, resources, sessions and debug logs. `PI_CODING_AGENT_SESSION_DIR` has explicit precedence over settings and the home-derived sessions path.
- Pi `FileAuthStorageBackend` writes `auth.json` in place with mode `0600` and uses `proper-lockfile` with the provided pathname (`realpath: false`). Multiple private symlink paths to one real auth target would therefore use different locks while writing the same bytes. SDD 401 uses regular per-agent copies instead.
- The local real Pi home currently has OAuth records for multiple providers. Expiry metadata was inspected without reading token values; the planned human dogfood window is before expiry, avoiding a forced refresh while validating the new layout.
- The private snapshot allowlist is `auth.json`, `settings.json`, `models.json`, `models-store.json`, `trust.json`, and `keybindings.json`. `settings.json` is sanitized to remove `packages`, `extensions`, `skills`, `prompts`, and `themes`; global executable/instruction resources do not cross the boundary implicitly.
- Missing `auth.json` is valid because Pi supports environment-backed provider credentials. Existing malformed or unsafe sources still fail closed.
- Phase 2's resolver keeps `resume.configHome` meaning “exact session directory.” Under Phase 3 that is `<PI_CODING_AGENT_DIR>/sessions`, avoiding a ledger-wide semantic migration.
- Pi remains ineligible for opt-in Tachyon `harness:` capability declarations. Default private-home isolation and agent-scoped resource harnesses are separate capabilities; parity documentation marks the latter partial.

## Automated evidence

- Focused suite: 617 tests passed across Pi session/home, HarnessManager, AgentManager lifecycle, resume, config, runtime profile and Bridge onboarding.
- Real Pi RPC dogfood passed: process A wrote under private home A, process B resumed the exact ID in A, a sibling wrote only under private home B, and an ambient-home sentinel remained byte-identical.
- Build passed.
- Engine boundary passed (`vscode`-free daemon closure, 249 files).
- Product invariants passed (1 invariant, 2 tests).
- Full suite: 4,866 passed, 3 skipped, with only the two inherited baseline failures already recorded in SDD 399/400:
  - generated `grokauthfixBehavior` invokes `npm run typecheck`, which fails because `test/unit/verifyFullLock.test.ts` lacks a declaration for `../../scripts/verify-full.mjs`;
  - `verifyFullQuiet.test.ts` expects the pre-`t-6a9bc4` `verify:full` script.
- Direct typecheck likewise reports only the inherited `verifyFullLock.test.ts` declaration defect.

## Review notes

- SDD 401 deliberately does not synchronize OAuth refresh across homes. This is an honest `✓/~` credential boundary, not a claim that copied rotating credentials have shared freshness.
- The private `.tachyon/harness` root and each Pi home/session directory are mode `0700`; copied JSON state is mode `0600`. The existing workspace `.tachyon` directory is validated as real but its mode is not changed.
- Managed Pi rename remains refused because tmux name, ledger authority and private home would need an atomic migration contract.

## Human dogfood

### 2026-07-18 — pass — Dev Host worktree target

- Commit `df2c9701`, isolated fixture `/tmp/tachyon-pi-private-home-dogfood`.
- `pi-a` reported `PI_CODING_AGENT_DIR` under `.tachyon/harness/pi-a`; home and sessions were real mode-0700 directories and `auth.json` was a regular non-symlink mode-0600 file.
- `pi-b` reported its distinct `.tachyon/harness/pi-b` home, proving sibling runtime-home separation.
- Maintainer confirmed `pi-a` Stop → Resume preserved the conversation and `/tachyon-bridge-status` remained connected after relaunch.
- This proves the integrated default private-home + exact continuity + Bridge lifecycle path for SDD 401.
- Dev Host pointer was cleared immediately after confirmation; its private engine was stopped.

## Verification log

### 2026-07-18T15:52:32Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/piSession.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts test/unit/config.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — pass

## Dogfood log

### 2026-07-18T15:52:39Z — pass (1/1) — source: tasks.md — commit: 5fb1bcbfe13d240ee5b00975bc676c8f685a634d
- `node scripts/dogfood/pi-private-home.mjs` — pass
