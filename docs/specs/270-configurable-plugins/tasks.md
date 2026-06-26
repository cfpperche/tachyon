# 270 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/pluginManifest.test.ts test/unit/pluginLockfile.test.ts test/unit/pluginToolPlan.test.ts test/unit/pluginViewModel.test.ts`
<!-- extend with the new pure button-derivation suite once it lands -->

## Implementation (engine + webview — spec-250 family)

- [ ] 1. **manifest.ts** — `ConfigDecl` type + `config?`/`docsUrl?` on `PluginManifest`; parse/validate fail-closed
  (well-formed schema, `format:"json"`, `default` validates against schema, `docsUrl` `^https://`, size caps,
  reject unknown sub-fields). Tests.
- [ ] 2. **lockfile.ts** — persist `configDescriptor?` (format + resolved path + schema ref/hash) + `docsUrl?`;
  fail-closed round-trip. Tests.
- [ ] 3. **toolPlan/preview** — carry descriptor + docsUrl into the install plan; assert config is **excluded**
  from the install fingerprint (edited config ≠ drift). Tests.
- [ ] 4. **viewModel.ts** — extend `InstalledPluginVM` + a **pure** button-derivation module (Config iff config,
  Docs iff docsUrl); pure unit tests.
- [ ] 5. **default seeding** — on apply, materialize the config file from `default` when absent. Test.
- [ ] 6. **webview wiring** — Config opens the on-disk file + schema association; Docs `vscode.env.openExternal`
  with a click-time `https://` guard; post-apply auto-open only on **successful** apply. Decision logic in the
  pure module (logic-in-vscode-layer escapes CI — keep it testable).
- [ ] 7. **Codex dueto** on the manifest-validation + the security-lane reservation (the parts that touch the
  trust boundary); fold.

## Verification

- [ ] manifest validates config/docsUrl + rejects malformed/non-https/unknown (scenario 1)
- [ ] consent surfaces config/docs; lockfile records descriptor + docsUrl (scenario 2)
- [ ] card shows Config iff config, Docs iff docsUrl; Docs https-guarded at click (scenario 3)
- [ ] Config opens the real file + schema validation; edit ≠ re-consent ≠ fingerprint drift (scenario 4)
- [ ] post-apply auto-nav only on success; default seeded (scenario 5)
- [ ] missing/invalid config fails closed, surfaced (not silent permissive) (scenario 6)
- [ ] security lane reserved: no arbitrary path / runtime-readable policy injection; no agent-reachable
  relaxation channel (scenario 7)
- [ ] Green gate: full vitest + tsc×2 + engine-boundary + esbuild

## Unblocks

- [ ] spec 271 (agent-browser trust policy) reuses the Config/Docs UX + lockfile metadata + post-install nav; adds
  the Tachyon-owned policy path + launcher enforcement.
