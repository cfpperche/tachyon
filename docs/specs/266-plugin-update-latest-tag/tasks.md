# 266 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/pluginSource.test.ts test/unit/pluginFetcher.test.ts test/unit/pluginEngine.test.ts`

## Implementation

- [x] 1. **source.ts — pure semver-tag helpers + ref rewrite.** `parseSemverTag(tag)` (optional `v`/`V`
  prefix → `{major,minor,patch}` | null), `compareSemverTags(a,b)` (numeric major→minor→patch; prerelease
  ignored, identical policy to `engine.compareVersions` — factor a shared comparator so they can't drift),
  `rewriteRef(spec, newRef)` (swap `@<ref>`, preserve locator + `#path=` fragment, reuse `parseSource`'s split
  rules). No I/O. Unit tests in `pluginSource.test.ts`.
- [x] 2. **fetcher.ts — `resolveLatestSemverTag(source, git)`.** `git ls-remote --tags --refs <remote>` → parse
  `refs/tags/<name>` → `parseSemverTag` filter → max by `compareSemverTags`; return the verbatim tag name.
  Fail-closed + non-fatal (`{ errors }`; auth → `AUTH_REQUIRED: <host>`), never throws. Unit tests in
  `pluginFetcher.test.ts` with a fake GitRun.
- [x] 3. **engine.ts — `resolveEffectiveUpdateSpec(spec, git)`.** Eligible iff the current ref is a semver tag
  (`refKind === "named"` + `parseSemverTag` non-null); resolve latest, and if strictly higher return
  `rewriteRef(spec, latest)`, else the original spec. Probe error / ineligible / not-higher → original spec
  (degrade, never throw). Unit tests in `pluginEngine.test.ts`.
- [x] 4. **PluginsPanel.ts — wire into checkUpdates + previewUpdateOp.** Resolve the effective spec from the
  recorded `source.spec` before `loadPluginFromSource` in both paths so status + the held provenance carry the
  bumped tag and confirm re-pins the lockfile. No view-model / consent-VM change.
- [x] 5. **Flow test.** A tag-pinned plugin whose higher tag carries a higher manifest version → update-available
  (and the monorepo-equal case → up-to-date), exercised through the panel's check path with a fake source.

## Verification

- [x] Tag-pinned plugin with a newer repo tag → update-available with the higher tag's manifest version (scenario 1)
- [x] Monorepo tag bump that doesn't change THIS plugin → up-to-date (scenario 2)
- [x] Confirm re-pins the lockfile to the newer immutable tag with provenance/integrity (scenario 3)
- [x] branch / HEAD / SHA / non-semver pins unchanged (scenario 4)
- [x] latest-tag probe failure / no-higher-tag falls back to the exact-ref check; AUTH_REQUIRED preserved (scenario 5)
- [x] a pin above the highest tag is never offered a downgrade (scenario 6)
- [x] Green gate: full vitest + `tsc` ×2 + engine-boundary + esbuild
