# 266 — plan

## Where the gap is

`PluginsPanel.checkUpdates` (status) and `PluginsPanel.previewUpdateOp` (apply) both call
`loadPluginFromSource(entry.source.spec)` → `previewUpdate`. `loadPluginFromSource` →
`fetcher.resolveCommit` resolves the **exact** pinned ref (a tag → its fixed peeled SHA), so a tag pin always
loads the same manifest version → `previewUpdate.upToDate`. The "is there a newer tag?" question is never asked.

The fix is a thin layer **in front of** `loadPluginFromSource`: pick the **effective ref** to evaluate. For a
semver-tag pin with a higher semver tag available, the effective ref is that higher tag; otherwise it is the
current pin (today's behavior). Everything downstream — `loadPluginFromSource` → `previewUpdate` →
`deriveUpdateCheck` → provenance → lockfile — is reused untouched, so the bump re-pins the lockfile to the new
immutable tag **for free** (provenance is computed from whatever spec we load).

## Layers (bottom-up, each independently tested)

1. **`source.ts` — pure semver-tag helpers + ref rewrite (no I/O).**
   - `parseSemverTag(tag): { major, minor, patch } | null` — accept an optional `v`/`V` prefix; `null` for a
     non-semver tag (so non-version tags are ineligible, never mis-ordered).
   - `compareSemverTags(a, b): number` — major→minor→patch numeric (prerelease ignored for ordering, mirroring
     `engine.compareVersions`; keep the two policies identical).
   - `rewriteRef(spec, newRef): string` — swap the `@<ref>` in a source-spec while preserving the locator and a
     trailing `#path=` fragment, reusing the SAME split rules as `parseSource` (last-`@`, `#` fragment). Pure
     string surgery; the result is re-parsed by `parseSource` downstream, so it inherits all validation.

2. **`fetcher.ts` — `resolveLatestSemverTag(source, git): Promise<{ tag?, errors }>` (network, injectable GitRun).**
   - `git ls-remote --tags --refs <remote>` → lines `<sha>\trefs/tags/<name>`. `--refs` strips the `^{}` peeled
     duplicates; we only need the tag NAME here (the chosen tag is fetched/peeled/verified normally on load).
   - Map names through `parseSemverTag`, drop nulls, pick the max by `compareSemverTags`. Return the raw tag
     name (verbatim, e.g. `v0.6.0`) so the rewrite keeps the author's `v` convention.
   - Fail-closed and **non-fatal**: a git error returns `{ errors }` (auth → reuse `AUTH_REQUIRED: <host>`); the
     caller treats any error / no-higher-tag as "no bump" and falls back to the exact pin. Never throws.

3. **coordination — `resolveEffectiveUpdateSpec(spec, git): Promise<string>`** (small, in `engine.ts` beside
   `loadPluginFromSource`, the existing source↔engine bridge — NOT a new god-module method).
   - `parseSource(spec)`; eligible iff `refKind === "named"` AND `parseSemverTag(source.ref)` is non-null.
   - If eligible: `resolveLatestSemverTag`; if a tag resolves with `compareSemverTags(latest, currentRef) > 0`,
     return `rewriteRef(spec, latest)`. Otherwise (ineligible / probe error / not higher) return `spec` verbatim.
   - Deterministic + side-effect-free beyond the one `ls-remote`. The decision is **tag-level only**; the
     manifest-version decision stays in `previewUpdate` (so a monorepo no-op tag → up-to-date).

4. **wiring — `PluginsPanel`.**
   - `checkUpdates`: `const spec = await resolveEffectiveUpdateSpec(p.source.spec); loadPluginFromSource(spec)`
     then `previewUpdate` as today. A probe failure degrades to the original spec (the helper already returns it).
   - `previewUpdateOp`: same — resolve the effective spec from `entry.source.spec` before `loadPluginFromSource`,
     so the consent drawer + the held `provenance` carry the bumped tag and the confirm re-pins the lockfile.
   - No view-model or consent-VM change: `deriveUpdateCheck`'s `latestVersion` is already the loaded manifest
     version, which is now the higher tag's version. The card already renders update-available/drift/etc.

## Reuse / non-duplication

- `compareSemverTags` shares the exact numeric policy of `engine.compareVersions`; factor the comparison so the
  two never drift (extract a shared `compareSemver(major.minor.patch)` or have one call the other).
- `rewriteRef` reuses `parseSource`'s split discipline (last-`@`, single `#` fragment) — do not invent a second
  spec grammar.
- The bump path runs the **unchanged** install/preview/provenance pipeline; no second materialization path.

## Risks / fail-closed posture

- **Never widen the pin silently.** Only a current pin that is itself a semver tag is eligible; the effective
  spec is always another immutable tag (or the original). A branch/HEAD pin is never converted to a tag and vice
  versa.
- **A latest-tag probe must not regress the check.** Any error → fall back to the exact pin so a network blip
  can't turn a green check red.
- **Argument-injection.** The rewritten ref is the verbatim author tag from `ls-remote` output, re-validated by
  `parseSource` (which rejects leading `-`, `..`, etc.) before any git shell-out. `ls-remote` output is matched
  against `refs/tags/<name>` and the name through `parseSemverTag` (strict charset), so only well-formed tags
  flow on.
- **TOCTOU.** Unchanged: the confirm still binds the consented fingerprint and `applyUpdate` re-derives before
  writing; the effective-spec resolution happens before consent, exactly where the spec is chosen today.

## Test plan

- `source.ts`: `parseSemverTag` (v-prefix, non-semver → null, partial), `compareSemverTags` ordering, `rewriteRef`
  (with/without `#path=`, github + git+https locators, idempotence).
- `fetcher.ts`: `resolveLatestSemverTag` with a fake GitRun (mixed tag/non-tag lines, no tags, git error →
  errors, auth → `AUTH_REQUIRED`).
- engine: `resolveEffectiveUpdateSpec` (eligible→bumped, equal/lower latest→original, branch/HEAD/SHA→original,
  probe error→original).
- panel/flow: a tag-pinned plugin + a fake source whose higher tag carries a higher manifest version →
  `checkUpdates` yields update-available; the monorepo-equal case yields up-to-date.
- Green gate: full vitest + `tsc` ×2 + engine-boundary + esbuild.
