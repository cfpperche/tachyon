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
- [ ] **Step 3 — materialization engine + install/remove + security diff preview** (real claude workspace smoke).
- [ ] **Step 4 — codex-adapter** (proves the multi-runtime thesis on the second runtime).
- [ ] **Step 5 — updater (3-way merge) + agent0-core meta-plugin + Plugins View.**

## Closure
_(filled at v1 ship)_
