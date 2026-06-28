# 284 — plugin-data-artifacts — tasks

_Work top-to-bottom. Each lane: implement → tests green._ **Verify:** `npx vitest run test/unit && npm run typecheck && npm run build`

## Lane A — provisioning core
- [ ] A1. `manifest.ts`: `DataPlatform` + `DataDecl` types + `parseData` (name-keyed map, kebab `NAME_RE`, fail-closed; **reject archive** with a clear error). Wire into manifest parse + `Manifest.data?`.
- [ ] A2. `dataPlan.ts` (NEW): `DataPlanItem` + `gatherDataPlan` mirroring `gatherToolPlan` (single blob default + optional `platforms`; finalUrl resolve; `unsupported[]`).
- [ ] A3. `toolProvisioning.ts`: `MAX_DATA_ARTIFACT_BYTES = 1 GiB` + `installData(srcPath, opts)` — STREAM hash+copy, `0o400`, no smoke, fstat (regular/owner/no-foreign-write/nlink==1), content-addressed `.tachyon/data/sha256/<sha>/<fileName>`.
- [ ] A4. `toolProvisionRun.ts`: `provisionData(pluginName, root, dataPlan, opts)` (download→verify→installData; reuse `ToolTransaction`; rollback) returning `DataLock[]`.
- [ ] A5. Tests `pluginData{Parse,Plan,Install,ProvisionRun}.test.ts`: kebab/fail-closed/archive-rejected; single+platforms; stream + 0o400 + no-exec-bit + oversize cleanup + hash-mismatch; provision round-trip.
- [ ] A6. Lane A green: `vitest run test/unit` + typecheck.

## Lane B — lockfile + resolver
- [ ] B1. `lockfile.ts`: `DataLock` (sha-first: `contentSha256`, `installPath`, `declaredUrl`/`finalUrl`, `fileName`, `resolvedPlatform`, `version`), `parseDataLock`, `physicalDataKey`, `dataReferenceCounts`, `PluginLock.data?`.
- [ ] B2. `dataLauncher.ts` (NEW): `resolveDataForAccess(plugin, name, deps)` — lockfile-anchored, plugin-scoped, trusted `.tachyon/data` ancestry, `O_NOFOLLOW`, fstat (regular/owner/no-foreign-write/nlink==1/**no-exec**), `hashFd` vs `contentSha256`, fail-closed; returns absolute path. NO exec/policy.
- [ ] B3. Materialize `_tachyon-data` shim + JS resolver alongside `_tachyon-tool`; record in the lockfile launcher block; `DATA_RESOLVER_REL = ".tachyon/bin/_tachyon-data"`.
- [ ] B4. Tests `pluginData{Lockfile,Launcher}.test.ts`: lock parse/serialize, refcount by content hash, resolver fd-checks (symlink/owner/foreign-write/nlink/exec-bit/hash-mismatch → fail-closed), shim resolves a real fixture blob.
- [ ] B5. Lane B green.

## Lane C — engine wiring + consent
- [ ] C1. `consentViewModel.ts`: `ConsentData` (name/version/platform/url/sha256, NO launchPolicy) + `dataFrom(preview)` + `requiresDataConfirm` (lighter "downloads+stores DATA, no exec" ack).
- [ ] C2. `engine.ts` preview: `gatherDataPlan` in `applyInstall`/`previewUpdate`; `dataTargets` into `InstallPreview`; surface unsupported data as warnings.
- [ ] C3. `engine.ts` fingerprint: `dataTargets` in `fingerprintOf` basis; **data absent ⇒ byte-identical fingerprint** (guard existing tests).
- [ ] C4. `engine.ts` applyInstall: re-resolve + `provisionData`; write `lockfile.data`; materialize the data shim.
- [ ] C5. `engine.ts` applyRemove: `removeProvisionedData` — delete blob only at refcount 0; drop the data shim only when no plugin has data.
- [ ] C6. `engine.ts` rehydrate: `rehydrateData` on clone (re-fetch from pin, idempotent hash-check).
- [ ] C7. Tests `pluginDataEngine.test.ts`: end-to-end install→resolve→remove(refcount)→rehydrate; consent shows data w/o exec warning; data+tools coexist; **data path never accepted by `_tachyon-tool`**; archive-decl rejected at preview.
- [ ] C8. Full suite green: `vitest run test/unit` + typecheck + build + engine-boundary.

## Close
- [ ] D1. Codex dueto on the built diff (technical review, no scope cuts) → fold.
- [ ] D2. `spec.md` Status → shipped + Closure; tick acceptance boxes; commit + push.
