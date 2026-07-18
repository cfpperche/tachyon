# 400 — pi-private-home — plan

_Drafted from `spec.md` on 2026-07-18. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Fold Phase 2's `.tachyon/pi-sessions/<agent>` namespace into the standard Tachyon private-home root `.tachyon/harness/<agent>`. Pi receives both official environment surfaces: `PI_CODING_AGENT_DIR=<home>` and `PI_CODING_AGENT_SESSION_DIR=<home>/sessions`. The explicit session override keeps transcript resolution deterministic and preserves the Phase 2 resolver contract while the full-home override redirects all other global Pi state.
2. Add a Pi-specific home materializer to `HarnessManager`. It creates/checks every owned directory without following symlinks, snapshots an allowlist of top-level JSON files from the effective real Pi home on first materialization, validates each source as a regular no-follow JSON object, and forces private permissions. `auth.json` is copied, never linked. Existing private files are preserved after validating their shape so Pi owns its later mutations.
3. Classify Pi as a default `private-home` runtime in `runtimeProfile`. Route every spawn/restart/resume—including commands that explicitly own session flags—through the same pre-tmux materialization pipeline. Keep Bridge projection additive through the bundled extension.
4. Make the Pi session helper target `<harnessHome>/sessions`, retaining canonical workspace containment and no-follow cleanup. Full canonical forget already removes `harnessHome`; retain session cleanup only as an idempotent compatibility layer while this stacked branch folds the unreleased Phase 2 path.
5. Reject user-provided Pi home/session environment overrides during config validation. Add `--session-dir` to Pi's explicit session-ownership flags so Tachyon never mints an ID in one directory and resolves another.
6. Extend docs, unit coverage and real-Pi RPC dogfood. Dogfood uses deterministic local providers to prove private-home environment semantics, exact resume in home A, isolation from home B, and no write to a sentinel real home.

## Key decisions

- **Use Pi's two official environment variables** — `PI_CODING_AGENT_DIR` is the full-home boundary and `PI_CODING_AGENT_SESSION_DIR` gives the existing resolver an explicit transcript root; rejected mutating `~/.pi/agent`, project `.pi`, or generated argv because those are shared/user-owned surfaces.
- **Reuse `.tachyon/harness/<agent>`** — this gives Pi the same lifecycle, GC and no-follow cleanup boundary as default Codex/private harness homes; rejected another `.tachyon/pi-homes` tree because duplicate cleanup and rename authority caused the Phase 2 lifecycle concern.
- **Copy credentials as a private regular file** — Pi writes auth in place and locks by pathname. Symlinking many private paths to one target would create distinct locks around a shared file and permit write races. Rejected a shared symlink despite Claude/Codex precedent; OpenCode's mode-0600 copy is the closer mutation model.
- **Seed once, then preserve private mutation** — later spawns validate but do not overwrite existing private files. Rejected copying global auth/settings on every launch because that would erase refreshed credentials and agent-local settings.
- **Allow missing real auth** — Pi supports environment/API-key providers, so absence is not proof of an unauthenticated launch. Rejected Codex-style mandatory auth; malformed existing auth still fails closed.
- **Copy only regular top-level JSON state** — `auth.json`, sanitized `settings.json`, `models.json`, `models-store.json`, `trust.json`, and `keybindings.json` preserve login/preferences/catalog/trust without inheriting executable global trees. Resource keys (`packages`, `extensions`, `skills`, `prompts`, `themes`) are removed from the private settings snapshot. Rejected recursive copy/symlink or settings-based loading of those resources, tools and bin because executable/instruction resources need an explicit future harness policy.
- **Do not auto-trust cwd** — copying `trust.json` preserves user decisions while Pi's native project-trust rules remain authoritative. Rejected silently adding a trust grant.
- **Keep self-managed session commands private-home** — explicit session flags opt out only from Tachyon continuity authority, not runtime-home isolation.

## Files touched

- `src/agents/piSession.ts` — full-home/session paths and no-follow materialization helpers.
- `src/harness/HarnessManager.ts` — Pi private-home snapshot materializer and real-home resolution.
- `src/agents/AgentManager.ts` — default private-home derivation and lifecycle env persistence.
- `src/workspace/Workspace.ts` — wire Pi materialization through the shared harness pipeline.
- `src/runtime/runtimeProfile.ts` — declare verified private-home isolation.
- `src/resume/adapters.ts` — recognize explicit `--session-dir` ownership.
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json` — reserve Pi-owned environment variables and document the boundary.
- `src/agents/forgetAgent.ts` — update canonical footprint wording after sessions move under the full home.
- `test/unit/{piSession,harness,agentManager,resume,config,runtimeProfile}.test.ts` — permissions, copies, isolation, lifecycle and fail-closed tests.
- `scripts/dogfood/pi-private-home.mjs` — real Pi RPC private-home/continuity/isolation proof.
- `docs/runtimes/pi.md`, `docs/runtimes/parity.md` — capability and limits.

## Risks & unknowns

- Copied OAuth refresh tokens can diverge across simultaneously active private homes. This is preferable to an unsafe shared-write race, but long-running multi-agent OAuth refresh needs real dogfood and possibly a future credential coordinator.
- Sanitizing global resource keys changes ambient Pi customization intentionally. Project `.pi` remains the explicit native route until Pi harness capabilities are designed.
- Existing tests may assume only Codex is default private-home. Update expectations without weakening other runtime boundaries.
- Phase 2 ledger `configHome` means session directory, not full agent home. Preserve that meaning to avoid a broad ledger migration.

## Visual impact

No new UI surface. Runtime behavior is visible only in the Pi process environment and filesystem. **Visual QA Opt-Out:** private runtime-state change with no rendered Tachyon UI.

## Sources consulted

- Pi `README.md`, `docs/settings.md`, `docs/packages.md`, `docs/session-format.md`, and shipped `dist/config.js`, `dist/core/auth-storage.js`, `pi-ai/dist/auth/*`.
- `src/harness/HarnessManager.ts`, `src/runtime/runtimeProfile.ts`, `src/agents/AgentManager.ts`, `src/workspace/Workspace.ts`, `src/config/loadConfig.ts`.
- SDD 298 (Codex isolated homes), SDD 357/358 (default private-home profiles), SDD 398 (Pi Bridge), and SDD 399 (Pi continuity).
