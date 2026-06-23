# Spec 250 — tasks (v1 build order)

**Verify:** `env -u TMUX npx vitest run && npm run -s typecheck`

Each step is implemented then adversarially code-reviewed by a codex dueto before the next.

- [x] **Step 1 — manifest schema + parser/validate + compat resolution** (pure, unit-tested).
  `src/plugins/manifest.ts` + `test/unit/pluginManifest.test.ts` (38 tests). Codex review dueto
  (NEEDS-REVISION → 7 findings folded: cross-platform path containment by segment, blocks-keys-⊆-runtimes
  closure, proto-pollution defense (null-proto + key whitelist), self-dependency reject, range sanity,
  resource caps, unknown-top-level-field reject; tightened NAME_RE). 1014 suite green, tsc clean.
- [ ] **Step 2 — claude-adapter merge/un-merge + lockfile** (idempotent; the one-runtime path end-to-end).
- [ ] **Step 3 — materialization engine + install/remove + security diff preview** (real claude workspace smoke).
- [ ] **Step 4 — codex-adapter** (proves the multi-runtime thesis on the second runtime).
- [ ] **Step 5 — updater (3-way merge) + agent0-core meta-plugin + Plugins View.**

## Closure
_(filled at v1 ship)_
