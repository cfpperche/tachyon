# 265 — plugin-tool-provisioning — tasks

_Generated from `plan.md` on 2026-06-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 0. **Design gates (settle before any provisioning code — codex review).** (a) Pick the **audited archive lib(s)** for tar.gz/zip (evaluate + document rejected alternatives + their CVE/maintenance posture); (b) settle the **launcher trust model** — `_tachyon-tool` resolves from the lockfile (not a standalone `tools.json`), validates `<name>/<binSha256>/<exe>` + re-hash via `O_NOFOLLOW`+`fstat` before exec, with the same-user-mutation threat boundary documented; (c) the **transaction journal** layout `.tachyon/transactions/<id>/` + startup GC contract; (d) **platform-resolution precedence** (Node arch vs kernel vs Rosetta/musl). Captured in `plan.md` Hardening + notes; no code yet beyond type/contract stubs.
- [x] 1. **manifest — `tools` declaration.** Optional top-level `tools: { <name>: { version, versionCommand?, allowedHostSha256?, platforms: { <key>: { url, sha256, archive?: {type, innerPath, binSha256} } } } }`. Explicit platform keys (libc-qualified). Fail-closed: HTTPS url, 64-hex sha256/binSha256, archive `type` ∈ {tar.gz,tgz,zip} + contained `innerPath`. Unit tests.
- [x] 2. **toolPlatform.ts — platform resolution.** `resolvePlatform()` → a key or a typed unsupported error: `process.platform`/`arch` + `uname` corroboration, WSL→linux, Rosetta record, Linux glibc-vs-musl (`getconf`/`ldd`). Windows/unpinned → machine-readable error. Unit tests (mock the probes).
- [x] 3. **toolProvisioning.ts — secure download.** `node:https` only: reject non-https/downgrade, bounded redirects (record final URL), max-bytes + timeout + cleanup, stream to a same-filesystem private temp. Tests against a LOCAL https fixture server (reject-http, redirect bound, size/timeout caps).
- [x] 4. **toolProvisioning.ts — verify + atomic immutable install.** Hash temp vs sha256 (mismatch → fail-closed); `chmod 0500`; `O_EXCL` no-overwrite create at `.tachyon/bin/<name>/<binSha256>/<tool>` under `0700` parents; owner==uid + link-count==1 checks; re-hash before return. Tests incl. mismatch + no-overwrite + the re-hash guard.
- [x] 5. **toolProvisioning.ts — safe archive extraction.** Verify archive sha256; metadata-first traversal (no on-disk materialization); stream the single `innerPath` regular file; reject traversal/absolute/symlink/hardlink/device/multiple/duplicate-path/over-cap-entries/over-cap-decompressed; verify `binSha256`. Tests with crafted malicious archives (traversal, symlink, zip-bomb, multi-file).
- [ ] 6. **toolProvisioning.ts — detect-first + smoke-check.** `detectHostTool`: PATH probe, exact `versionCommand`, full-path ownership+mode trust, record hash, `allowedHostSha256` gate. Smoke-check AFTER verify: magic + `--version`, minimal env/no-cwd/no-net/timeout/output-cap; fail-closed on non-runnable. Tests.
- [ ] 7. **launcher + tools.json.** Tachyon-authored `_tachyon-tool` shim: read the LOCKFILE-anchored tool set, re-validate the named tool's `binSha256`, `exec`. Tests EXECUTE the launcher: runs the right binary, fail-closed on a swapped/tampered binary or a tampered `tools.json`.
- [ ] 8. **lockfile — `PluginLock.tools` + refcount.** Add `tools?: ToolLock[]` (full provenance, fail-closed parse); a refcount helper keyed by `{platform, artifactSha, binSha, innerPath, exeName}` by PHYSICAL identity (installPath/binSha) across all plugins. Unit tests (round-trip, fail-closed, refcount).
- [ ] 9. **toolPlan + engine preview + fingerprint.** Async `gatherToolPlan(plugin, platform)` (resolve platform + redirect-resolved final URLs); inject into the SYNC `previewInstall` → a `toolTargets` surface + bind into `fingerprintOf` (platform + final URL + checksums). Unit tests (drift changes fingerprint; consent↔fetch URL match).
- [ ] 10. **engine apply — transactional provisioning + `${tool:}` resolution.** Provision ALL tools first (staged), verify, write `tools.json`, THEN activate (settings/skills/mcp/git-hooks); resolve `${tool:<name>}` in git-hook leaves → launcher invocations; record `PluginLock.tools`; roll back staged binaries + lockfile on any failure. Real-https-fixture tests incl. a mid-provision failure rollback.
- [ ] 11. **engine remove + rehydrate.** `applyRemove` decrements refcount + deletes orphaned content-addressed files (never a host-provided tool, never a still-referenced one). `rehydrateTools` (consent-replay from the lockfile for the clone/CI case; never a silent fetch). Tests: shared-tool refcount, orphan deletion, clone inert + rehydrate.
- [ ] 12. **consent VM + UI + panel.** Per-tool section (name/version/platform/declaredUrl/finalUrl/sha256/publisher) + a dedicated per-tool ack ("sha256 = integrity vs the manifest, not trust"); gate confirm. Panel: async tool-plan gather before consent; thread the ack; a rehydrate action. View-model unit tests; webview build green.

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a scenario there._

- [ ] Manifest declares a pinned per-platform tool; malformed → rejected before consent (scenario 1)
- [ ] download→verify→atomic O_EXCL install; mismatch fails-closed; re-hash before wire (scenario 2)
- [ ] Archive: metadata-first single-file; traversal/symlink/zip-bomb rejected; binSha256 verified (scenario 3)
- [ ] detect-first: exact version + opt-in + path-trust + host-hash recorded; allowedHostSha256 honored (scenario 4)
- [ ] platform resolution incl. glibc/musl + WSL + Rosetta; unsupported → machine-readable error (scenario 5)
- [ ] smoke-check after verify, sandboxed; non-runnable fails-closed (scenario 6)
- [ ] per-tool consent shows declared+final URL + checksum + publisher; sha256≠trust language (scenario 7)
- [ ] HTTPS-only + bounded redirects + final-URL recorded; consent↔fetch URL match (scenario 8)
- [ ] lockfile records full provenance for byte-reproducible re-hydrate (scenario "lockfile")
- [ ] refcount/dedup by full identity; uninstall deletes only orphaned Tachyon-owned files (scenarios "refcount", "uninstall")
- [ ] transactional: a provisioning failure rolls back; no half-written binary / no hook wired to a missing tool (scenario "transactional")
- [ ] clone with absent .tachyon/bin is inert; explicit rehydrate, no silent fetch (scenario "clone/CI")

**Headless check:** `env -u TMUX npx vitest run && npm run -s typecheck && node esbuild.mjs`

**Human approval:** opt-in — declare a real tool (e.g. gitleaks) in a test plugin, install via the Plugins View → the per-tool consent shows the URL+checksum+platform → confirm → the binary lands content-addressed under `.tachyon/bin/` and a git-hook using it runs on commit; remove → the binary is deleted when no plugin references it.
