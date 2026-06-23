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
- [ ] **Step 5 — pure infra, no content.** The Tachyon repo ships NO bundled plugins; a bundle plugin is content for a plugin repo, demand-gated.
  - [x] **Updater (3-way merge).** `previewUpdate`/`applyUpdate` in `engine.ts`: lockfile=baseline, on-disk=current, plugin dir=new. Two conflict kinds refuse without `force` — an EDITED baseline group (current ≠ baseline) and a user-ADDED group that would DUPLICATE a new-version group; a lower version is a `force`-gated downgrade. With force, proceeds (edited groups kept as conservative orphans, never deleted). Reuses planRemove + previewInstall/applyInstall. Codex review dueto (NEEDS-REVISION → 3 folded: would-duplicate collision detection, downgrade gate, `runtime` carried on RemoveStep). 29 engine tests; 1104 suite green.
  - [ ] **Sourcing** — where plugins come from (git-based, remote-only v1; registry = v2). Design + decisions in `sourcing.md` (codex design dueto, 2 blockers folded: `@ref` required + `#path=` subdir grammar).
    - [x] **Resolver (pure)** — `src/plugins/source.ts` `parseSource(spec)` → a `GitSource` (kind/spec/remote/ref/refKind/subdir), fail-closed, no I/O. `github:` sugar + `git+https://`; required `@ref` (sha/named/head); `#path=` containment (reuses `paths.ts`); rejects ssh/local-path/the `org/repo/path@ref` shorthand. 25 tests; 1129 suite green.
    - [x] **Fetcher (I/O)** — `src/plugins/fetcher.ts` `fetchSource(source, git, {cacheRoot})`: ls-remote resolves the ref → SHA (a 40-hex sha-ref verbatim) → shallow clone to a staging dir → checkout the SHA → atomic rename into a GLOBAL content-addressed cache (`~/.tachyon/plugin-cache/git/<remoteHash>/<sha>/`, workspace stays clean) → returns the plugin dir (subdir via `#path=`). Injectable `GitRun` (argv array, no shell — the resolver already blocked dash-refs). Submodules/gitlinks rejected; LFS pointer files fail closed; AUTH_REQUIRED surfaced (git with prompts disabled, never hangs). `loadPluginFromSource(spec)` bridges resolve→fetch→loadPlugin into the engine. 9 fetcher tests (incl. real-git smoke: clone a local repo, tag→SHA, subdir, cache-hit) + an engine end-to-end (`github:o/r@v1` → install). 1160 suite green.
    - [x] **lockfile `source`+`integrity` provenance** — `PluginLock.source` is a `SourceLock` struct (type/spec/remote/ref/resolvedCommit/subdir) + `integrity` an `IntegrityLock` (algorithm/payload), fail-closed parsed. `loadPluginFromSource` returns the `provenance`; `applyInstall`/`applyUpdate` accept `{provenance}` and pin it in the lockfile → a teammate's clone re-hydrates the exact bytes. e2e: a remote `github:o/r@v1` install records the resolved commit + payload hash. 1165 suite green.
  - The plugin ENGINE is now feature-complete (manifest · adapters claude+codex · install/remove/update · sourcing resolve+fetch+cache · provenance). Remaining = the UI only.
  - [ ] **Plugins View** — extension UI: an editor webview panel opened by a sidebar title button (sibling of `tachyon.inspectServer`); browse installed → install-by-source / update / reinstall(force) / remove, with a BLOCKING consent drawer (provenance · permission summary · diff preview · dangerous-disabled-by-default) before any write. Design mock (`/tmp/plugins-view-mock.html`) maintainer-approved: Marketplace tab = "coming in v2" placeholder; per-plugin runtime pills (NOT a workspace-global pill); Reinstall action on drift. Decomposed VM-pure → provider → HTML, codex dueto between steps.
    - [x] **Step A — pure view-model.** `src/plugins/viewModel.ts` `buildPluginsViewModel({lockfileText, present, updateChecks})` → render-ready `PluginsViewModel` (installed cards: name/version/sourceSpec/shortCommit/localInstall · runtime pills in SUPPORTED_RUNTIMES order with present-vs-vanished state · status from injected update-checks · actions derived deterministically). PURE — all I/O (lockfile read, detectRuntimes, update-checks) injected by the provider (honors "logic in the vscode layer escapes CI"). Corrupt lockfile → `parseError` banner + suppressed list, never throws; no-file = cold/empty. Pill `present:false` = installed-for-but-runtime-vanished (the "declared-but-skipped" case is a preview/drawer concern — the lockfile records only MATERIALIZED runtimes). 10 tests; tsc clean; 1175 suite green. Codex review dueto (SHIP-WITH-CHANGES → 2 folded: exhaustive `actionsFor` + `assertNever`; locale-independent sort).
    - [x] **Step B — webview provider + registration.** `src/webview/PluginsPanel.ts` (host manager, mirrors HandoffPanelManager): `tachyon.openPlugins` command + sidebar title button (`navigation@2`, after inspect-tmux) → editor webview panel (one per root, reveal/dispose lifecycle). `gather()` = `detectRuntimes` + read committed lockfile (ENOENT→cold; non-ENOENT read failure→`readError` banner, never masqueraded as "no plugins") → `buildPluginsViewModel` → postMessage. Preact frontend `src/webview/plugins/{main.tsx,App.tsx}` renders read-only: header + workspace-runtime subtitle, cold/empty + corrupt-lockfile banners, one card per plugin (provenance · per-plugin runtime pills with present/vanished state · status badge). Frontend imports the VM **type only** (`import type` → esbuild erases it; engine boundary verified clean in `dist/webview/plugins.js`). esbuild `plugins` bundle + nls (en + pt-BR). No update-checks yet → status `unknown`. UI proven via a standalone harness driving the real built bundle (`/tmp/plugins-stepB.png`). 12 VM tests; tsc ×2 clean; 1177 suite green. Codex review dueto (SHIP-WITH-CHANGES → 1 folded: discriminate ENOENT from real read errors; independently re-verified engine boundary + CSP nonce + escaping + package contract).
    - [ ] **Step C — webview HTML + consent drawer.** Render the VM; install-by-source input; the BLOCKING consent drawer fed by `previewInstall`/`previewUpdate`/`previewRemove`; confirm → `applyInstall`/`applyUpdate`/`applyRemove`.

## Closure
_(filled at v1 ship)_
