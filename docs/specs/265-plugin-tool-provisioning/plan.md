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

## Hardening (folded from the 2026-06-25 codex plan review — NEEDS-REVISION)

The core model held; the review tightened the security-critical JOINTS. Folded:

- **H1 — Launcher trust is lockfile-anchored.** `tools.json` is NOT trusted on its own (it's another mutable file). The launcher resolves a tool from the **lockfile** (or a lockfile-hash-bound snapshot), and validates every entry's content-addressed path actually matches `<name>/<binSha256>/<exe>` + the recorded `binSha256` before exec. A `tools.json` entry that disagrees with the lockfile is rejected.
- **H2 — Re-hash→exec TOCTOU: explicit threat boundary.** Same-user mutation between hash-check and `exec` is **outside the threat model** (a same-user attacker already has full control). The launcher does best-effort: open `O_NOFOLLOW`, `fstat` (owner==uid, link-count==1, mode), hash that handle, then exec it (Linux: exec the `/proc/self/fd/N` / `fexecve`-style path where available; macOS: revalidate the path immediately before exec). `0700` parents + `O_EXCL` install close the cross-user + accidental-corruption cases. Documented, not over-promised.
- **H3 — `${tool:<name>}` is argv-only + whole-token.** A placeholder is allowed ONLY in the spec-264 **argv-vector** git-hook form (never a shell-string leaf), only as a WHOLE argv element, matching a strict `name` regex; it resolves to a single absolute launcher-invocation token — so there is no shell to smuggle `; evil` into. A shell-string leaf containing `${tool:…}` is rejected at load.
- **H4 — `applyInstall` re-resolves redirects + a strict consent↔fetch match.** Apply redoes redirect resolution with the SAME policy immediately before the body download and aborts (re-consent) on any drift in `declaredUrl + finalUrl + sha256` vs the consented `ToolPlan`. Pre-consent resolution uses a defined bounded method (a no-body / `Range: bytes=0-0` GET, not a possibly-divergent HEAD); a method-dependent redirect mismatch forces renewed consent.
- **H5 — Crash-safe transaction journal.** Provisioning writes to a journaled staging area `.tachyon/transactions/<id>/` (OUTSIDE the live content-addressed `.tachyon/bin/` and refcount visibility); the lockfile is committed by atomic rename ONLY after all activation material is staged. A **startup GC** reclaims abandoned transaction dirs + stale temp/staging (age + ownership checked). "Rollback-on-error" is backed by "recover-on-restart".
- **H6 — Archive: audited libs + strict single-file + duplicate handling.** The extractor library is chosen FIRST (audited tar/zip parsers; rejected alternatives documented) — never hand-rolled. Exactly ONE matching regular-file entry; reject duplicate normalized paths, metadata-vs-payload disagreement, pax/zip64/case-collision tricks; enforce BOTH compressed and decompressed caps + entry-count cap; metadata-first (no on-disk materialization during traversal).
- **H7 — Refcount by PHYSICAL identity.** Dedup/removal compute physical refs from the lockfile's `installPath`/`binSha256` entries (the executable bytes), NOT plugin or logical tool names — so the same bytes referenced under two names aren't deleted while still referenced.
- **H8 — Host-provided routes through the launcher too.** A host-provided tool is invoked via `_tachyon-tool`, which revalidates the recorded host path + ownership/mode + hash (and `allowedHostSha256`) **before each exec**, fail-closed on drift — same guarantee as a fetched tool.
- **H9 — Platform precedence is explicit + tested.** Define the order (Node `process.arch` vs kernel `uname -m` vs executable compatibility), with machine-readable unsupported reasons; for Rosetta, decide native `darwin-arm64` when Node is arm64 (only fall back to `darwin-x64` if no arm64 pin). Tests cover missing `getconf`, BusyBox `ldd`, Rosetta, WSL, musl containers.
- **H10 — Smoke-check isolation is BEST-EFFORT (honest).** A native binary `--version` can still attempt network/read home. Enforce: empty env, `HOME`/`TMPDIR` redirected, no repo cwd, short timeout, output caps; document network isolation as best-effort unless a real per-OS sandbox primitive is added (not v1).
- **H11 — TLS hygiene in tests.** The local HTTPS fixture pins a test-only CA injected into the fixture client ONLY; production code must reject invalid certs — asserted by a test that a bad cert is refused. Never disable TLS verification globally.

**Reordered (review):** before `toolProvisioning.ts` — (a) pick the archive lib, (b) settle the launcher trust model + the transaction-journal design, (c) finalize platform-resolution precedence. These contracts gate the code that depends on them. `tasks.md` updated accordingly (task 0 + reorder).

## Sources consulted

- `src/plugins/engine.ts` — async `applyInstall`/`applyRemove`, `previewInstall(…, gitState?)`, `fingerprintOf`, the materialize/remove transaction (spec 264).
- `src/plugins/gitHookState.ts` / `gitHookRegistry.ts` — the inject-async-facts-into-sync-preview pattern + the managed-dir/integrity-snapshot/launcher patterns to mirror.
- `src/plugins/fetcher.ts` — the `GitRun`/`node:https`-adjacent IO style + resource bounds.
- Codex spec reviews rounds 1 + 2 (folded in `spec.md` + `notes.md`).
