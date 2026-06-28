# 284 — plugin-data-artifacts — plan

_Drafted from `spec.md` on 2026-06-28._

## Approach

Implement a **data-artifact** provisioning path as a sibling to the spec-265 tool path: a pinned, sha256-verified,
content-addressed, READ-ONLY (no-exec, no-smoke) file, resolved through a fd-enforced `_tachyon-data` shim. Mirror the
tool pipeline file-for-file; diverge only where the dueto decided (streaming, sha256-first layout, no exec/smoke/policy).

Pipeline (each row = the existing tool symbol → the new data analog):

| Stage | Tool (existing) | Data (new) |
|---|---|---|
| Manifest type+parse | `manifest.ts` ToolDecl / `parseTools` | `DataDecl` + `parseData` (D6: name-keyed map `{version,url,sha256,fileName?,platforms?}`; D7 reject archive) |
| Plan | `toolPlan.ts` gatherToolPlan | `dataPlan.ts` gatherDataPlan (single blob default + optional platforms) |
| Install | `toolProvisioning.ts` installExecutable (readFileSync, 0o500, smoke) | `installData` — **STREAM** copy+hash (D2), `0o400` read-only, NO smoke, fstat checks |
| Orchestrate | `toolProvisionRun.ts` provisionTools | `provisionData` (download→verify→installData; reuse ToolTransaction; no smoke) + `rehydrateData` |
| Lockfile | `lockfile.ts` ToolLock / physicalToolKey / refcounts | `DataLock` (D1 sha-first id) + `physicalDataKey` + `dataReferenceCounts`; `PluginLock.data?: DataLock[]` |
| Resolver | `toolLauncher.ts` resolveToolForLaunch + `_tachyon-tool` shim | `resolveDataForAccess` (O_NOFOLLOW, fstat regular/owner/no-foreign-write/nlink==1, hashFd, **no exec**) + `_tachyon-data` shim (D4/D5: prints path, never execs) |
| Consent | `consentViewModel.ts` ConsentTool / requiresToolConfirm | `ConsentData` + `requiresDataConfirm` (OQ5: lighter — download+store, NO exec warning) |
| Engine | `engine.ts` gatherToolPlan / fingerprint / provisionTools / lockfile.tools / removeProvisionedTools | parallel gatherDataPlan / fingerprint dataTargets / provisionData / lockfile.data / removeProvisionedData |

## Key decisions

- **Sibling `installData`, not a flagged `installExecutable`** — chosen because the exec/smoke/0o500/launch-policy
  assumptions are pervasive and a flag-riddled shared function is less safe; rejected the shared-with-flag path because
  the dueto's no-exec split wants a focused function. (A shared `downloadVerifyInstall` core extraction is a viable
  later refactor; deferred — streaming + mode + no-smoke divergences justify a sibling now.)
- **Content-address sha256-FIRST** (`.tachyon/data/sha256/<sha>/<fileName>`), refcount by `dataSha256` — chosen per
  dueto D1; rejected name-first (`<name>/<sha>/…`) because it breaks blob sharing + refcount correctness.
- **Streaming install/hash** (dueto D2) — chosen because `installExecutable` `readFileSync`s the whole blob (fine for
  small CLIs, wrong for 140 MB+); rejected readFileSync.
- **`_tachyon-data` shim materialized alongside `_tachyon-tool`** (dueto D5) — chosen because skills/hooks run with no
  VS Code process and need a cwd-independent CLI resolver; rejected in-process-only resolution.
- **Mode `0o400`, no smoke, no launch policy, nlink==1 kept** — read-only data; the resolver verifies no-exec; nlink==1
  holds because we install our own fresh blob (D4).

## Files touched

- `src/plugins/manifest.ts` — add `DataDecl`/`DataPlatform` types + `parseData` (reject archive; kebab-case `NAME_RE`).
- `src/plugins/dataPlan.ts` — NEW; `gatherDataPlan` (mirror `toolPlan.ts`).
- `src/plugins/toolProvisioning.ts` — add `installData` (streaming, 0o400, no smoke) + `MAX_DATA_ARTIFACT_BYTES = 1 GiB`.
- `src/plugins/toolProvisionRun.ts` — add `provisionData` + `rehydrateData`.
- `src/plugins/lockfile.ts` — add `DataLock`, `physicalDataKey`, `dataReferenceCounts`, `PluginLock.data?`, `parseDataLock`.
- `src/plugins/dataLauncher.ts` — NEW; `resolveDataForAccess` + `_tachyon-data` shim (mirror `toolLauncher.ts`) +
  extend `materializeLauncher` (or sibling) to write the data shim.
- `src/plugins/consentViewModel.ts` — add `ConsentData` + `requiresDataConfirm` + `dataFrom`.
- `src/plugins/engine.ts` — wire dataPlan into preview/fingerprint/applyInstall/lockfile/remove/rehydrate/update.
- `test/unit/pluginData*.test.ts` — NEW per-lane (mirror the `pluginTool*` files + `test/fixtures/` manifests).

## Risks & unknowns

- **Launcher materialization coupling:** writing `_tachyon-data` alongside `_tachyon-tool` may touch the shared
  validator bundle + `LauncherLock` (shimSha256/validatorSha256 drift detection). Verify the lockfile launcher block
  stays correct when a plugin has data but no tools (and vice-versa).
- **Fingerprint/consent shape drift:** adding `dataTargets` to `fingerprintOf` + `ConsentVM` is a contract change —
  the convention guards + existing fingerprint tests must stay green (data absent ⇒ identical fingerprint).
- **Streaming + cap interaction:** enforce the byte cap mid-stream (not after), and clean up the partial temp on
  overflow (mirror the tool download cap).
- **1 GiB downloads in tests:** never fetch real large files in unit tests — use small fixtures + injected sizes.

## Sources consulted

- The tool-provisioning pipeline map (Explore agent, 2026-06-28): exact symbols + lines for all 9 stages.
- spec 265/269/272 + `src/plugins/{manifest,toolProvisioning,toolProvisionRun,toolLauncher,lockfile,toolPlan,
  toolPlatform,consentViewModel,engine}.ts`.
- The 284 codex dueto (D1–D7 + resolved OQs) recorded in `spec.md` + `notes.md`.

## Verify

`npx vitest run test/unit` (full suite green) + `npm run typecheck` + engine-boundary + `npm run build`.
