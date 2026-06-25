# 263 — plugin-install-declared-runtimes — plan

_Drafted from `spec.md` on 2026-06-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

The engine is already parameterized on a runtime set — `previewInstall(plugin, ws, present)`, `applyInstall(..., present)`, `previewUpdate(..., present)`. The whole change is a **policy + provenance** shift, not an architectural rewrite:

1. **Reinterpret the set from "present in the workspace" to "the runtimes to materialize" (the *target* set).** The caller stops passing `detectRuntimes(ws)` as a gate and passes the **selected target runtimes** instead: default = `manifest.runtimes` (all declared), minus any the installer deselects. `detectRuntimes` is demoted to a *hint* used only to label each runtime "already present" vs "will be created" in the drawer. `resolveCompat`'s `missingFromWorkspace`→`skipped` split is retired as a gate; `skipped` becomes "declared but deselected".

2. **Consent/TOCTOU — bind the selection EXPLICITLY (BLOCKER 1, revised).** The "fingerprint covers it for free" shortcut is unsafe: a declared runtime that produces **no** per-runtime artifact (no hooks, no skills, no MCP) would yield identical `steps`/`skillTargets`/`mcpTargets` whether selected or not, so selecting vs deselecting it gives the same hash. Fix: add an explicit normalized `targetRuntimes: Runtime[]` to `InstallPreview` and to the `fingerprintOf` basis. The selected set is threaded through `PendingOp` + the `confirm` message; `applyInstall` recomputes the plan from **exactly** that set and the fingerprint check rejects any drift between consented and applied selection.

3. **Lockfile records what it created (BLOCKER 2 / D3, revised).** Add an **optional** `createdAncestors: string[]` to `PluginLock` — paths the install created that did NOT pre-exist (`.claude/`, `.agents/skills/`, …). Ancestors are created during **activation** (settings `atomicWrite`, skills `mkdirSync(dirname)`, MCP `writeMcpConfig`), so a preview-time stat is stale authority. Compute it **inside `applyInstall`, immediately before the lockfile write**, from the fresh selected plan: stat each ancestor of every planned target; those absent now are the ones activation will create → record them. If the directory state has drifted from the consented preview, treat it as a re-preview condition (don't silently record the wrong fact). Bind `createdAncestors` into the **remove** fingerprint.
   `applyRemove` removes the plugin's `targets`, then deletes recorded `createdAncestors` — each first **validated** (contained, normalized, deduped, sorted **deepest-first**, derivable from valid recorded targets / known adapter dirs, exactly as `skill-dir`/`mcp-server` targets are validated today) — via non-recursive **`rmdir`** so the empty-check is enforced atomically by the filesystem; `ENOENT`/`ENOTEMPTY` are safe no-ops, never errors. Never a dir that pre-existed or holds unrelated content.

4. **Update/reinstall symmetry (HIGH 1, revised).** `previewUpdate`/`applyUpdate` stop reading `detectRuntimes` (`previewUpdate` already has the lockfile via `planRemove`); the target set is `lockfile.plugins[name].runtimes` **intersected with the NEW `manifest.runtimes`**. If an installed runtime is no longer declared by the new version (`installedRuntimes ⊄ new manifest.runtimes`), update/reinstall **fails with an incompatible-runtime error** requiring a fresh install/selection — it never silently drops a runtime.

5. **Partial-failure contract (HIGH 2, revised).** Keep the transactional order (payload → lockfile → activation); `createdAncestors` is written in the lockfile phase (predicted from the pre-activation stat in step 3), before any activation, so a claude-ok/codex-fail still has a complete removal record. **Also harden `atomicWrite`** with a `try/finally` that cleans its temp file on a failed `writeFileSync`/`renameSync` — otherwise a write that fails *after* creating the runtime dir leaves a temp file, making the recorded ancestor non-empty and un-removable. Recorded-cleanup is chosen over full rollback (smaller, consistent with today's partial-install model); the atomicWrite hardening + failure tests are what make it complete.

6. **Consent drawer (MEDIUM 1 + UX).** `consentViewModel` + `App.tsx` render each declared runtime as a toggle row labelled *present* / *will be created*; deselecting recomputes the preview (new fingerprint). **All runtimes deselected ⇒ confirm disabled** (or the action is cancel) — never a payload-only no-op.

## Key decisions

- **Explicit `targetRuntimes` in the fingerprint** (revised after review) — the "implicit/for-free" binding is unsafe for a runtime with no artifacts; bind the selected set explicitly.
- **`createdAncestors` as an OPTIONAL field, `schemaVersion` STAYS 1** — chosen over a 1→2 bump. The committed lockfile + the current parser hard-rejecting non-1 means a bump would fail-close older Tachyon installs (multi-machine/team break). The old parser ignores unknown plugin-object fields, so an optional `createdAncestors` is forward/backward compatible. Recorded **inside `applyInstall`** (not preview) since ancestors are created at activation.
- **Recorded-cleanup over full rollback** for partial failure — smaller, consistent with today's partial-install model; completeness comes from the `atomicWrite` temp-file hardening + failure tests (not from rollback).

## Files touched

- `src/plugins/engine.ts` — retire `present`-as-gate in `previewInstall`/`resolveCompat`; add `targetRuntimes` to `InstallPreview` + `fingerprintOf`; compute `createdAncestors` inside `applyInstall` pre-lockfile-write; validate + `rmdir` them in `applyRemove` (bind into the remove fingerprint); `previewUpdate`/`applyUpdate` target `lock.runtimes ∩ new manifest.runtimes` with an incompatible-runtime error; harden `atomicWrite` with `try/finally` temp cleanup.
- `src/plugins/lockfile.ts` — optional `PluginLock.createdAncestors`; **keep `schemaVersion: 1`** (parser ignores unknown plugin fields); parse/validate the new field.
- `src/webview/PluginsPanel.ts` — replace `detectRuntimes`-as-gate at the 4 install/update/confirm/checkUpdates call sites (see Risks); carry `targetRuntimes` in `PendingOp` + the `confirm` message; host-owned preview recompute on each toggle.
- `src/plugins/consentViewModel.ts` + `src/webview/plugins/App.tsx` — per-runtime toggle rows (present / will-create), deselect handling, deselect-all disables confirm.
- `test/unit/{pluginEngine,pluginLockfile,pluginConsentViewModel}.test.ts` — the new scenarios + the golden present-path regression.

## Risks & unknowns

- **Old lockfile without `createdAncestors`:** must parse + uninstall safely (treat as "nothing recorded created" → never delete ancestors). Tested.
- **`detectRuntimes` call sites — exact new source of truth** (audited per review):
  - `PluginsPanel.ts:178` `checkUpdates` → **lockfile `runtimes`**
  - `PluginsPanel.ts:200` install preview → **current drawer selection** (default all declared)
  - `PluginsPanel.ts:225` update preview → **lockfile `runtimes` ∩ new manifest**
  - `PluginsPanel.ts:256` confirm apply → **the consented `targetRuntimes`**
  - `PluginsPanel.ts:~291` gather / card pills → **`detectRuntimes` stays (hint only)**
- **Fingerprint stability:** the change must not alter the present-path fingerprint (the golden both-present test guards this).
- **rmdir atomicity:** rely on `rmdir` failing on a non-empty dir rather than checking-then-removing (no TOCTOU window).

## Sources consulted

- `src/plugins/engine.ts` — `fingerprintOf` (l.664), `previewInstall` (l.683), `resolveCompat`, `detectRuntimes` (l.230).
- `src/plugins/lockfile.ts` — `PluginLock` (l.60), `MaterializedTarget`.
- `src/webview/PluginsPanel.ts` — `present = detectRuntimes(ws)` call sites (l.178/200/256/291).
- Codex spec debate transcript (folded in `notes.md`).
