# Spec 250 — tasks (v1 build order)

**Verify:** `env -u TMUX npx vitest run && npm run -s typecheck`

Each step is implemented then adversarially code-reviewed by a codex dueto before the next.

- [x] **Step 1 — manifest schema + parser/validate + compat resolution** (pure, unit-tested).
  `src/plugins/manifest.ts` + `test/unit/pluginManifest.test.ts` (38 tests). Codex review dueto
  (NEEDS-REVISION → 7 findings folded: cross-platform path containment by segment, blocks-keys-⊆-runtimes
  closure, proto-pollution defense (null-proto + key whitelist), self-dependency reject, range sanity,
  resource caps, unknown-top-level-field reject; tightened NAME_RE). 1014 suite green, tsc clean.
- [x] **Step 2 — claude-adapter merge/un-merge (pure) + lockfile.** `src/plugins/{lockfile,paths}.ts` +
  `src/plugins/adapters/claude.ts` + 3 test files (82 plugin tests). Codex review dueto (NEEDS-REVISION → 9
  findings folded): the central one — marker-by-name was fragile (claude could strip it; a copied/edited group
  could be wrongly deleted) — drove a **redesign to content-based un-merge via the lockfile** (no inline marker:
  Tachyon writes PURE claude groups; the lockfile's `removal` records the exact groups; un-merge removes by
  count-aware deep-equal, order-preserving in place). Plus: contained-path validation (shared `paths.ts`),
  fail-closed `normalizeClaudeSettings` (corrupt on-disk hooks no longer throws/clobbers), unsafe-pluginRoot
  reject, byte/size caps, stricter lockfile (dedupe runtimes, target.runtime ∈ runtimes, malformed optionals).
  1058 suite green, tsc clean. (NOTE: `paths.ts` is the shared containment helper going forward; `manifest.ts`
  still has an equivalent inline check — migrate in a later cleanup.)
- [x] **Step 3 — materialization engine (I/O) + install/remove + security preview.** `src/plugins/engine.ts`
  + `test/unit/pluginEngine.test.ts` (17 integration tests on real temp workspaces). claude-only (codex = Step 4).
  Two-phase: `previewInstall`/`previewRemove` (read-only security surface: diff + wired commands + orphan count +
  consent fingerprint); `applyInstall`/`applyRemove` (writes). Codex review dueto (BLOCK → 7 findings folded):
  fail-closed reads (corrupt lockfile / invalid settings are ERRORS, not silently-empty — they'd orphan a
  plugin's removal identity or clobber a user file); `priorClaudeOwned` re-validates the opaque lockfile
  `removal` + rejects dup refs; `preflightPayload` (no symlinks/special files, bounded bytes/files/depth +
  content hash); consent `fingerprint` (apply refuses a stale preview = TOCTOU guard); transactional order
  payload→lockfile→settings (settings activates hooks last); refuse 0-step install (no `runtimes:[]` lock).
  1087 suite green, tsc clean. A confirming re-review (NEEDS-REVISION) folded 4 more: payload TOCTOU closed by
  copy-to-staging→re-preflight+hash-match→promote; settings lost-update guards (re-check `before` snapshot
  before writing) on install + remove; remove reuses the planned lockfile (no swallowed second read).
  DEFERRED (noted): (a) STEP-4 — `priorClaudeOwned` is claude-hardcoded + groups by event only; codex/multi-file
  needs runtime-owned reconstruction keyed by `{runtime,kind,file,ref}` + adapter dispatch. (b) PRODUCTION —
  a corrupt lockfile fail-closes ALL ops (safe but wedged); needs a `doctor`/repair/force-remove path (Step 5).
- [x] **Step 4 — codex-adapter + engine multi-runtime generalization.** Extracted the generic hooks-map core
  to `adapters/hooks.ts` (parse/merge/remove parametrized by knownEvents + allowStatusMessage); `claude.ts`
  thin + re-exports old names (zero churn); new `adapters/codex.ts`; `engine.ts` generalized — ADAPTERS registry,
  `loadPlugin` reads every declared runtime, `priorOwned` keyed by `{runtime,kind,file,ref}`, multi-file
  install/remove. THESIS PROVEN: a test wires the SAME plugin into claude (`.claude/settings.json`) + codex
  (`.codex/hooks.json`), codex `statusMessage` + native `^Bash^` matcher preserved, per-runtime payload root.
  Codex review dueto (NEEDS-REVISION → 4 folded): `readFile` discriminates ENOENT (genuine absence) from an
  unreadable-but-present file (EISDIR/EACCES → fail-closed); **CODEX_HOOK_EVENTS corrected to include
  SubagentStart/SubagentStop** (verified against a live `.codex/hooks.json` — codex genuinely exposes these,
  so a delegation-style plugin can wire them on codex), excludes only claude-only PostToolUseFailure; multi-file install partial-failure returns a
  structured repair error; claude REJECTS `statusMessage` (fail-closed, not lossy-drop). 1096 suite green, tsc clean.
- [ ] **Step 5 — pure infra, no content:** updater (3-way merge — update an installed plugin without clobbering edits) + sourcing (plugins from a local path / git / marketplace; the engine today loads from a dir) + the **Plugins View** (extension UI: browse → install/update/remove). The Tachyon repo ships NO bundled plugins; a bundle/meta-plugin is content for a plugin repo, demand-gated.

## Closure
_(filled at v1 ship)_
