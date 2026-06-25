# 263 — plugin-install-declared-runtimes — tasks

_Generated from `plan.md` on 2026-06-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] 1. **lockfile** — add optional `createdAncestors?: string[]` to `PluginLock`; parse + validate it (contained, normalized, deduped); keep `schemaVersion: 1`; an old lock without the field parses as `[]`. Unit tests.
- [ ] 2. **fingerprint** — add normalized `targetRuntimes: Runtime[]` to `InstallPreview` and to the `fingerprintOf` basis. Unit test: select vs deselect a **no-artifact** runtime yields different fingerprints.
- [ ] 3. **previewInstall policy** — take the *target* set (selected runtimes) instead of `present`-as-gate; `resolveCompat` `skipped` = "declared but deselected"; `detectRuntimes` no longer gates. Unit tests: fresh-workspace (no `.claude`/`.codex`) plans BOTH declared runtimes.
- [ ] 4. **applyInstall createdAncestors** — recompute the plan from the consented `targetRuntimes`; immediately before the lockfile write, stat each target's ancestors and record the absent ones as `createdAncestors`; drift from preview → re-preview error. Unit tests.
- [ ] 5. **atomicWrite hardening** — `try/finally` temp-file cleanup on failed `writeFileSync`/`renameSync`. Unit test: a forced write failure leaves no temp file.
- [ ] 6. **applyRemove ancestors** — after removing targets, `rmdir` (non-recursive) each validated recorded ancestor deepest-first; `ENOENT`/`ENOTEMPTY` are no-ops; bind `createdAncestors` into the remove fingerprint. Unit tests: removes installer-created dirs, never a pre-existing or non-empty one, old-lock = no-op.
- [ ] 7. **update/reinstall symmetry** — `previewUpdate`/`applyUpdate` target `lock.runtimes ∩ new manifest.runtimes`; `installedRuntimes ⊄ new manifest.runtimes` → incompatible-runtime error. Unit tests incl. drift repair.
- [ ] 8. **PluginsPanel call sites** — rewire the 4 gates (install=selection, update/reinstall/checkUpdates=lock runtimes, gather=hint); carry `targetRuntimes` in `PendingOp` + the `confirm` message; host-owned preview recompute on each toggle.
- [ ] 9. **consent drawer** — `consentViewModel` + `App.tsx`: per-runtime toggle rows labelled *present* / *will be created*; deselect handling; **all-deselected disables confirm**. View-model unit tests.

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a scenario there._

- [ ] Fresh-workspace install materializes BOTH declared runtimes (spec scenario 1)
- [ ] Consent fingerprint binds the runtime selection incl. a no-artifact runtime (scenario 2)
- [ ] Deselect wires only the kept runtime; all-deselected disables confirm (scenarios 3, 5)
- [ ] Lockfile records `createdAncestors`; uninstall removes exactly those, never pre-existing/non-empty; old lock = no-op (scenario "lockfile records", D3)
- [ ] Update/reinstall use the consented set; runtime dropped by new manifest → incompatible-runtime error (scenario "update honors consented set")
- [ ] Partial-failure leaves a complete removal record; `atomicWrite` leaves no temp (scenario "partial failure")
- [ ] Golden: both-`.claude`/`.codex`-present preview byte-identical old vs new (scenario "present-workspace unchanged")
- [ ] Unsupported runtime (`gemini`) still fails manifest validation before consent (final bullet)

**Headless check:** `env -u TMUX npx vitest run && npm run -s typecheck`

**Human approval:** opt-in — drive the Plugins View against a FRESH workspace: `Add by source` → `github:cfpperche/tachyon-plugins@v0.3.0#path=sdd` → drawer shows claude+codex as *will be created* targets → Install → confirm `/sdd` lands in `.claude/skills/sdd` (+ `.agents/skills/sdd`); then remove → confirm the created dirs are cleaned.
