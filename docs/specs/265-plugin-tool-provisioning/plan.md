# 265 — plugin-tool-provisioning — plan

_Drafted from `spec.md` (codex round-1 + round-2 folded) on 2026-06-25. The approach, not the steps._

## Approach

Tool provisioning is the highest-trust operation in the plugin system (download + execute a binary), so the design is **fetch + verify only** (no package manager, no registry), **content-addressed + enforced-immutable**, **per-tool human-consented**, and **transactional** (all tools land + verify before any hook activates). It reuses the spec-264 async engine path (install/remove/update are already async) — no new cascade.

Mirrors the spec-264 sync-preview / async-apply split: an async caller pre-resolves the **tool plan** (platform + redirect-resolved final URLs) and injects it into the SYNC `previewInstall` (which shows it + binds it into the fingerprint); the async `applyInstall` does the network download + verify + install.

Layers, bottom-up:

1. **Manifest declaration** (`manifest.ts`). Add an optional top-level `tools: { <name>: ToolDecl }` where `ToolDecl = { version, versionCommand?, allowedHostSha256?, platforms: { <platformKey>: { url, sha256, archive?: { type, innerPath, binSha256 } } } }`. Platform keys are EXPLICIT incl. libc (`linux-x64-glibc` | `linux-x64-musl` | `linux-arm64-glibc` | `linux-arm64-musl` | `darwin-x64` | `darwin-arm64`). Fail-closed validation: HTTPS url, 64-hex sha256, archive needs `type` ∈ {tar.gz, tgz, zip} + a contained normalized `innerPath` + a 64-hex `binSha256`.

2. **Platform resolution** (`toolPlatform.ts`). `resolvePlatform()` → a platform key (or a typed "unsupported" error): `process.platform`/`process.arch` corroborated by `uname -s/-m`; WSL → linux; Rosetta (darwin arm64 running x64) recorded; Linux **glibc vs musl** via `getconf GNU_LIBC_VERSION` / `ldd --version`. Windows / unpinned arch+libc → fail with a machine-readable code. Sync (uses sync `uname`/`getconf`); cached.

3. **The provisioner** (`toolProvisioning.ts`) — the security-critical core, async:
   - **download** (`node:https` only): reject non-`https:`, bound redirects (resolve the final URL; reject protocol downgrade), enforce max bytes + a timeout, stream to a private temp on the **same filesystem** as `.tachyon/bin/` (atomic-rename target), cleanup on interruption.
   - **verify**: hash the temp bytes vs `sha256`; mismatch → discard + fail-closed.
   - **archive** (when declared): verify the archive sha256, **inspect entry metadata FIRST** (no on-disk materialization during traversal), stream **only** the single `innerPath` regular file out; reject traversal/absolute/symlink/hardlink/device/special/multiple-output and over-cap entry-count/decompressed-size; verify the extracted bytes vs `binSha256`.
   - **atomic install**: `chmod 0500`, create `.tachyon/bin/<name>/<binSha256>/<tool>` under `0700` parents via **`O_EXCL` no-overwrite**; verify owner == running uid + link-count == 1; **re-hash** the placed file before returning.
   - **smoke-check** (AFTER hash verify — it is execution, inside the trust boundary): `file`/magic sniff + `--version` with a timeout in a **minimal env, no repo cwd, no inherited sensitive env, no network**, output-capped; a non-runnable binary (missing libs, wrong arch, macOS quarantine) → fail-closed with diagnostics.
   - **detect-first** (`detectHostTool`): PATH probe, **exact** version via the declared `versionCommand`, full-path ownership+mode trust (every parent non-world-writable, owned by user/root), record the host binary hash; gated behind `allowedHostSha256` when declared. Opt-in at consent only.

4. **The launcher** (OQ2 → **launcher**, ratified for execution-time integrity). A Tachyon-authored `.tachyon/bin/_tachyon-tool` shim: invoked as `_tachyon-tool <name> <args...>`, it looks up the tool's content-addressed path + expected `binSha256` from a managed `.tachyon/bin/tools.json` (Tachyon-written, integrity-stamped), **re-validates the hash**, then `exec`s it. A git-hook leaf (spec 264) references a tool via a `${tool:<name>}` placeholder resolved at materialization to a launcher invocation — so the leaf content is path-independent (the launcher resolves + re-hashes at exec). This is what makes the runtime guarantee (D8) real.

5. **Lockfile** (`lockfile.ts`). Add an optional `tools?: ToolLock[]` to `PluginLock`: `{ name, version, source: "host-provided"|"fetched", resolvedPlatform, declaredUrl, finalUrl, artifactSha256, binSha256, archive?: { innerPath }, installPath, hostDetected?: { path, version, hash } }`. **Refcount/dedup** by `{resolvedPlatform, artifactSha256, binSha256, innerPath, exeName}` computed across ALL plugins' `tools` in the lockfile — one verified copy shared; removal deletes a content-addressed file only when the last referrer is gone; a host-provided tool is never deleted.

6. **Engine integration** (`engine.ts`). `previewInstall(…, toolPlan?)` shows the per-tool plan (resolved platform + declared+final URL + checksum) + binds it into `fingerprintOf`; **`applyInstall` provisions ALL tools first (transactional, staged) BEFORE any activation** (settings/skills/mcp/git-hooks), rolls back staged binaries + lockfile on any failure; writes the `tools.json` launcher manifest; resolves `${tool:<name>}` placeholders in git-hook leaves to launcher invocations. `applyRemove` decrements refcount + deletes orphaned content-addressed files. A `rehydrateTools` entry for the clone/CI case (consent-replay from the lockfile; never a silent fetch).

7. **Consent VM + UI** (`consentViewModel.ts`, `App.tsx`, `PluginsPanel.ts`). A per-tool section (name, version, resolved platform, declared + final URL, sha256, publisher) + a dedicated per-tool acknowledgement; language: **sha256 proves integrity against the manifest, not trust**. Threaded through `PendingOp` + confirm like the MCP/git-hook acks. The async tool-plan gather (platform + redirect resolution) runs in the panel before building consent (mirrors `gatherGitHookState`).

## Key decisions (from the spec, ratified)

- **Sync preview via an injected `ToolPlan` (platform + redirect-resolved final URLs); async apply downloads.** No new async cascade (264 already made apply async).
- **Launcher over wire-time-only** (OQ2): execution-time re-hash is the real D8 guarantee; the git-hook leaf references `${tool:<name>}` → a launcher invocation, so leaf content is install-path-independent.
- **Install identity = `binSha256`** (executable bytes); archive storage separate from executable storage.
- **Refcount from the lockfile** (the single source of truth), keyed by full artifact+execution identity.
- **macOS quarantine** (OQ1): surface + instruct, never silently `xattr -d`.

## Files touched

- `src/plugins/manifest.ts` — `tools` declaration + validation.
- `src/plugins/toolPlatform.ts` (new) — platform resolution (arch/libc/WSL/Rosetta).
- `src/plugins/toolProvisioning.ts` (new) — download/verify/archive/atomic-install/smoke-check/detect + the launcher generator + `tools.json`.
- `src/plugins/toolPlan.ts` (new) — async `gatherToolPlan` (platform + redirect resolution) injected into preview.
- `src/plugins/lockfile.ts` — `PluginLock.tools` + refcount helpers.
- `src/plugins/engine.ts` — preview plan + fingerprint; transactional provisioning in apply; refcounted removal; `${tool:…}` resolution; rehydrate.
- `src/plugins/consentViewModel.ts` + `src/webview/plugins/App.tsx` + `src/webview/PluginsPanel.ts` — per-tool section + ack + plan gather + rehydrate action.
- `test/unit/*` — manifest, platform, the provisioner (download/verify/archive/atomic/smoke with a LOCAL https fixture server + crafted archives), refcount, the launcher (executed), engine transactional + rollback, consent VM.

## Risks & unknowns

- **Network in tests**: never hit the real network. Stand up a LOCAL `https` server (self-signed) serving fixture bytes + crafted redirects; test reject-http, redirect bounds, size/timeout caps, checksum mismatch, archive attacks (traversal/symlink/zip-bomb). This is the bulk of the test surface.
- **Archive extraction safety**: the highest-risk code. Prefer a metadata-first streaming extractor; cap entries + decompressed size; single-file only. Consider a vetted lib vs hand-rolled — evaluate at task time (build-vs-adapt).
- **macOS-specific paths** (Rosetta, quarantine, `shasum` vs `sha256sum`) can't be fully tested on Linux CI — gate those assertions, document, and verify the resolution logic in isolation.
- **`O_EXCL` + same-filesystem rename**: `.tachyon/bin/` must be created before the temp so the temp shares its filesystem (atomic rename).
- **Launcher trust**: the launcher + `tools.json` are Tachyon-authored under `0700`; `tools.json` is integrity-stamped like the git-hook snapshot.
- **Interaction with 264 ssh/`.tachyon` gitignore**: tools live under the gitignored `.tachyon/bin/` → clone needs `rehydrateTools` (consent-replay), never a silent fetch.

## Sources consulted

- `src/plugins/engine.ts` — async `applyInstall`/`applyRemove`, `previewInstall(…, gitState?)`, `fingerprintOf`, the materialize/remove transaction (spec 264).
- `src/plugins/gitHookState.ts` / `gitHookRegistry.ts` — the inject-async-facts-into-sync-preview pattern + the managed-dir/integrity-snapshot/launcher patterns to mirror.
- `src/plugins/fetcher.ts` — the `GitRun`/`node:https`-adjacent IO style + resource bounds.
- Codex spec reviews rounds 1 + 2 (folded in `spec.md` + `notes.md`).
