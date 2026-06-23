# Spec 251 — tasks (build order)

Decomposed like spec 250: each step is implemented, then adversarially codex-reviewed before the next. Skills reuse the spec-250 engine surface (manifest loader, preview/apply Install/Remove, lockfile `skill-dir` target, consent VM, Plugins View).

**Verify:** `env -u TMUX npx vitest run test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts test/unit/pluginConsentViewModel.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh`

## Steps

- [ ] **Step 1 — manifest + loader for the neutral `skills/` payload (pure).** Resolve OQ1: auto-discover `skills/<name>/` subdirs that contain a `SKILL.md`; parse + validate the SKILL.md frontmatter (`name`, `description` mandatory). Extend `loadPlugin` so a plugin may carry skills **in addition to or instead of** hooks (today it hard-requires `hooks.json` per block — relax that, but still reject a plugin with neither). `manifest.ts` / `engine.ts` loader + tests. No I/O beyond the existing dir read.
- [ ] **Step 2 — per-runtime skill destinations in the adapters.** claude → `.claude/skills/<name>/`, codex → `.agents/skills/<name>/`. Each adapter gets `skillDest(name)` + `materializeSkill(dir)` / `unmaterializeSkill(name)` (copy-dir / delete-dir) + collision detection (does the destination already exist?). A runtime with no skills loader returns "unsupported" → the engine reports it skipped. Tests per adapter.
- [ ] **Step 3 — engine `skill-dir` install/remove path (I/O).** Extend `previewInstall`/`applyInstall`/`previewRemove`/`applyRemove` to skill-dir targets alongside settings-hooks. Carry the **Keep/Replace** decision (D4) per colliding destination through preview→apply. **Backup-on-Replace + restore-on-Remove (OQ2):** decide the backup location (lean: committed `.tachyon/plugins/.backups/…` + lockfile pointer), implement precise restore, and a **safe degrade** when a backup is missing at Remove (warn, never delete user content). Record each materialized skill-dir (+ backup pointer) in the lockfile. Reuse the spec-250 TOCTOU fingerprint so a skill install/remove is consent-bound too. Engine tests: install/skip, collision-Keep, collision-Replace + restore-on-remove, missing-backup degrade.
- [ ] **Step 4 — consent VM + drawer skill section (D7).** Extend `consentViewModel.ts` to surface, per skill: frontmatter (`name`/`description`), bundled scripts, and each runtime destination; and a per-collision **Keep/Replace** control whose choice flows back to the apply. Pure VM tests + the frontend section. Use accurate hook/skill security language (the framing correction in spec.md).
- [ ] **Step 5 — UI wiring + live dogfood.** Wire the Keep/Replace choice through the host message protocol; extend the example repo's `hello-guard` plugin with a `skills/` payload; dogfood install (incl. a deliberate collision → Replace → Remove → original restored) by driving the real built bundle, like spec 250's dogfood.

## Closure
_(filled at ship)_
