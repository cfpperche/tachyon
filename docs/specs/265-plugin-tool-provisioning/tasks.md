# 265 — plugin-tool-provisioning — tasks

_Generated from `plan.md` on 2026-06-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 0. **Design gates (settle before any provisioning code — codex review).** (a) Pick the **audited archive lib(s)** for tar.gz/zip (evaluate + document rejected alternatives + their CVE/maintenance posture); (b) settle the **launcher trust model** — `_tachyon-tool` resolves from the lockfile (not a standalone `tools.json`), validates `<name>/<binSha256>/<exe>` + re-hash via `O_NOFOLLOW`+`fstat` before exec, with the same-user-mutation threat boundary documented; (c) the **transaction journal** layout `.tachyon/transactions/<id>/` + startup GC contract; (d) **platform-resolution precedence** (Node arch vs kernel vs Rosetta/musl). Captured in `plan.md` Hardening + notes; no code yet beyond type/contract stubs.
- [x] 1. **manifest — `tools` declaration.** Optional top-level `tools: { <name>: { version, versionCommand?, allowedHostSha256?, platforms: { <key>: { url, sha256, archive?: {type, innerPath, binSha256} } } } }`. Explicit platform keys (libc-qualified). Fail-closed: HTTPS url, 64-hex sha256/binSha256, archive `type` ∈ {tar.gz,tgz,zip} + contained `innerPath`. Unit tests.
- [x] 2. **toolPlatform.ts — platform resolution.** `resolvePlatform()` → a key or a typed unsupported error: `process.platform`/`arch` + `uname` corroboration, WSL→linux, Rosetta record, Linux glibc-vs-musl (`getconf`/`ldd`). Windows/unpinned → machine-readable error. Unit tests (mock the probes).
- [x] 3. **toolProvisioning.ts — secure download.** `node:https` only: reject non-https/downgrade, bounded redirects (record final URL), max-bytes + timeout + cleanup, stream to a same-filesystem private temp. Tests against a LOCAL https fixture server (reject-http, redirect bound, size/timeout caps).
- [x] 4. **toolProvisioning.ts — verify + atomic immutable install.** Hash temp vs sha256 (mismatch → fail-closed); `chmod 0500`; `O_EXCL` no-overwrite create at `.tachyon/bin/<name>/<binSha256>/<tool>` under `0700` parents; owner==uid + link-count==1 checks; re-hash before return. Tests incl. mismatch + no-overwrite + the re-hash guard.
- [x] 5. **toolProvisioning.ts — safe archive extraction.** Verify archive sha256; metadata-first traversal (no on-disk materialization); stream the single `innerPath` regular file; reject traversal/absolute/symlink/hardlink/device/multiple/duplicate-path/over-cap-entries/over-cap-decompressed; verify `binSha256`. Tests with crafted malicious archives (traversal, symlink, zip-bomb, multi-file).
- [x] 6. **toolProvisioning.ts — detect-first + smoke-check.** `detectHostTool`: PATH probe, exact `versionCommand`, full-path ownership+mode trust, record hash, `allowedHostSha256` gate. Smoke-check AFTER verify: magic + `--version`, minimal env/no-cwd/no-net/timeout/output-cap; fail-closed on non-runnable. Tests.
- [x] 7. **launcher** (codex-reviewed; `tools.json` DROPPED from the hot path — lockfile-only, codex review C). Tachyon-authored `_tachyon-tool` shim (regenerated per-op, execs a TRUST-CHECKED absolute Node on the bundled `_tachyon-tool.js`) → reads the LOCKFILE-anchored tool set, two validators (fetched content-address shape + nlink==1 / host realpath + ownership trust), `O_NOFOLLOW`+fstat+hash-through-fd vs `binSha256`, then Linux **procfd exec** (PROVEN: validated fd runs even after a path swap) / best-effort path exec for scripts+macOS. Tests EXECUTE the launcher (e2e bundle): runs the right binary, fail-closed on swap/tamper/missing-lockfile/untrusted-dir/nlink/ambiguous.
- [x] 8. **lockfile — `PluginLock.tools` + refcount.** _(built before task 7 per codex task-7 review point E — the launcher reads `lockfile.tools[]`)_ Add `tools?: ToolLock[]` (full provenance, fail-closed parse); a refcount helper keyed by `{platform, artifactSha, binSha, innerPath, exeName}` by PHYSICAL identity (installPath/binSha) across all plugins. Unit tests (round-trip, fail-closed, refcount).
- [x] 9. **toolPlan + engine preview + fingerprint.** Async `gatherToolPlan(plugin, platform)` (resolve platform + redirect-resolved final URLs); inject into the SYNC `previewInstall` → a `toolTargets` surface + bind into `fingerprintOf` (platform + final URL + checksums). Unit tests (drift changes fingerprint; consent↔fetch URL match).
- [x] 10. **engine apply — transactional provisioning + `${tool:}` resolution.** SLICED per codex task-10 review (E) into fail-closed boundaries:
  - [x] 10a — inert plumbing: transaction journal `.tachyon/transactions/<id>/` + startup GC + workspace-level launcher integrity record (`Lockfile.launcher`) + a `${tool:name}` PARSER that rejects invalid/substring/unprovisioned placeholders. No activation.
  - [x] 10b — provisioning commit path: `gatherToolPlan` injected into the TOCTOU re-derive, fingerprint binds `declaredUrl+sha256+binSha256+platform` (finalUrl=provenance, codex D), `toolConfirmed` ack gate (fail-closed at the engine), `provisionTools` (download→verify→archive→install→smoke under a transaction) → trust-checked-Node `materializeLauncher` → `PluginLock.tools[]` + `Lockfile.launcher` committed with the rest → rollback (physical-refcount, never another plugin's bytes) on any failure. No `${tool:}` activation. Proven e2e against a real https fixture.
  - [x] 10c — scoped hook activation: `${tool:<name>}` in an argv leaf resolves (at load, deterministic) to `<repo-rel _tachyon-tool> <plugin> <tool>` (plugin-scoped, clone-safe relative path); script leaves reject `${tool:}`; undeclared/substring fail closed. **CAPSTONE proven**: a real `git commit` runs the provisioned guard tool through the launcher (clean passes, BLOCKME blocked).
  - _Note: launcher resolution was already plugin-scoped (codex BLOCK B) as a task-7 correction; the task-9 fingerprint will drop finalUrl from the hard binding (codex D) during 10b._
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
