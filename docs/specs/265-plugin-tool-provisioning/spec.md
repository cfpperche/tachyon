# 265 — plugin-tool-provisioning

_Created 2026-06-25._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** All 13 tasks shipped (manifest `tools` → platform resolution → the provisioner [download/verify/install/archive/smoke/detect] → launcher [plugin-scoped, procfd exec proven] → lockfile `tools[]`+refcount → toolPlan/preview/fingerprint → transactional apply [10a journal/GC, 10b provisioning, 10c `${tool:}` activation] → remove/rehydrate → consent VM+UI). Four codex reviews folded (design gates, launcher, task-10 incl. the plugin-scoping BLOCK). Proven end-to-end by a CAPSTONE test: a provisioned tool drives a REAL `git commit` pre-commit hook through the launcher (clean passes, BLOCKME blocked). Headless check (vitest 1586 + typecheck + build) green. Deviations: archive narrowed to tar.gz/tgz (zip deferred); `tools.json` dropped from the launcher hot path (lockfile-only); finalUrl is provenance, not fingerprint-bound (codex D).

## Intent

A plugin's materialized capability often depends on a **host binary**. The migrating `secrets-scan` needs `gitleaks`; a commit-time gate (spec 264) that calls a tool which isn't installed either fails open (no coverage) or fails closed (breaks every commit). To make a git-hook gate fail-**closed** meaningfully, the tool must be reliably present.

Auto-downloading an arbitrary binary is the **highest-trust operation a plugin system can perform**, so it must be constrained, auditable, atomic, and human-authorized. The ratified model: the **plugin author declares** the tool with a per-platform **pinned `{url, sha256}`** (+ archive `innerPath` + extracted-binary `binSha256` when it ships as an archive); Tachyon **detects-first** (skip only if the host has it at the **exact** declared version, opt-in at consent, with the host binary's hash recorded), else downloads to a **private temp on the same filesystem**, hashes the bytes, `fsync`s, marks executable, and **atomically places it (no-overwrite, `O_EXCL`) into a content-addressed immutable path keyed by the EXECUTABLE bytes** — `.tachyon/bin/<name>/<binSha256>/<tool>` (for a bare binary `binSha256 == sha256`; for an archive it is the extracted file's hash) under private `0700` parent dirs; a checksum mismatch fails closed (bytes discarded, never executed). The consent drawer surfaces the resolved platform + **declared and final** URL + checksum per tool for an **explicit, stronger-than-MCP, per-tool** acknowledgement — with language making clear sha256 proves **integrity against the manifest, not trustworthiness**. HTTPS-only, bounded redirects, resource-limited. Tachyon stays out of per-tool maintenance: it fetches and verifies exactly the pins — never "latest", a mirror, or a curated registry.

**Done** = a plugin declares pinned per-platform tools; install resolves the platform (Linux glibc/musl + arm64/x64, macOS x64/arm64 incl. Rosetta, WSL=linux; Windows/unsupported refused), detect-first (exact version, opt-in), else fetches→verifies→atomic-installs into the content-addressed path, smoke-checks it, records the full resolved provenance in the lockfile (reproducible re-hydrate, refcounted removal), and the materialized hook/skill references the verified binary by absolute path. Provisioning is transactional: all tools land + verify before any hook activates.

## Acceptance criteria

- [ ] **Scenario: a plugin declares a pinned, per-platform tool**
  - **Given** a manifest tool `{ name, version, platforms: { "linux-x64-glibc": {url, sha256, archive?: {type, innerPath, binSha256}}, "linux-arm64-glibc": {...}, "linux-x64-musl": {...}, "darwin-x64": {...}, "darwin-arm64": {...} } }`
  - **When** it is loaded
  - **Then** validation is fail-closed: each platform entry needs an HTTPS URL + a 64-hex `sha256`; an archive entry additionally needs `type`, a normalized contained `innerPath`, and the extracted-binary `binSha256`. Malformed/incomplete → rejected before consent.

- [ ] **Scenario: download → verify → atomic install (no TOCTOU), with ENFORCED immutability**
  - **Given** the tool is absent and the platform supported, and the human authorized
  - **When** Tachyon provisions
  - **Then** it downloads to a private temp on the **same filesystem** as `.tachyon/bin/`, hashes the bytes, `fsync`s, `chmod`s, then places it under private `0700` parent dirs at `.tachyon/bin/<name>/<binSha256>/<tool>` via a **no-overwrite atomic create (`O_EXCL`)**. "Immutable" is OPERATIONALLY enforced: refuse to overwrite an existing content path, reject a hard-link (link-count > 1), verify owner == the running user, and **re-hash immediately before wiring** (and a launcher re-validates before each hook execution, OR the hook invokes a Tachyon launcher that does). A mismatch at any point discards the bytes and **fails closed**. The file the hook runs is provably the verified one.

- [ ] **Scenario: archive extraction is safe (metadata-first, single-file)**
  - **Given** a tool shipped as an archive
  - **When** Tachyon extracts
  - **Then** it verifies the archive sha256, **inspects entry metadata FIRST** (never materializing entries to disk during traversal), then streams **only** the single declared `innerPath` regular file into a private temp; it rejects path traversal, absolute paths, symlinks, hardlinks, device/special files, multiple outputs, and an over-cap entry count / decompressed size. The extracted binary is verified against `binSha256`, and the executable is installed under `<binSha256>` (separate from the archive's `sha256` — the install identity is the EXECUTABLE bytes, not the container).

- [ ] **Scenario: detect-first is conservative (exact version, opt-in)**
  - **Given** the host has the tool on `PATH`
  - **When** install resolves it
  - **Then** "host-provided" is **opt-in at consent**, requires an **exact** version match, and **records the host binary's hash** in the lockfile (so what ran is provable); if the manifest declares an `allowedHostSha256` set, the host binary must match one. The location is trusted only if EVERY parent dir is non-world-writable and owned by the user or root (not just "not relative / not world-writable" — concrete ownership+mode on the whole path). Without opt-in, Tachyon provisions its own verified copy.

- [ ] **Scenario: platform resolution; unsupported refused**
  - **Given** the host
  - **When** install resolves the platform
  - **Then** it derives from `process.platform`/`process.arch` corroborated by `uname -s/-m`, detects WSL (→ linux), Rosetta (darwin-x64 under arm64), and **glibc vs musl** on Linux; an unsupported arch/libc/OS (incl. Windows, or one the manifest doesn't pin) **fails with a specific, machine-readable error** — never a wrong-arch download or silent skip.

- [ ] **Scenario: post-verify smoke check before activation**
  - **Given** a freshly provisioned binary
  - **When** before any hook is wired to it
  - **Then** Tachyon runs the smoke check ONLY **after** hash verification (it is itself execution — inside the trust boundary): a magic/`file` sniff + `--version` with a timeout, in a **minimal env, no repo cwd, no inherited sensitive env, no network where feasible, with captured-output caps**. A binary that isn't a runnable native executable for the platform fails closed with diagnostics (covers missing dynamic libs, wrong arch, macOS quarantine/Gatekeeper — surfaced, never silently bypassed).

- [ ] **Scenario: explicit, stronger, PER-TOOL consent**
  - **Given** an install that will fetch one or more binaries
  - **When** the consent drawer renders
  - **Then** EACH tool shows name, version, resolved platform, declared URL, **final URL after redirects**, and sha256, with a dedicated per-tool acknowledgement; the language states sha256 proves integrity **against the manifest only, not trust**, and surfaces the plugin's publisher identity.

- [ ] **Scenario: HTTPS + bounded redirects + recorded provenance**
  - **Given** a download
  - **Then** only HTTPS is allowed (reject `file:`/`http:`/protocol downgrade); redirects are bounded and the **final** URL is recorded and shown; the URL shown at consent must **exactly match** the final URL of the post-consent download (redirects resolved without fetching the body pre-consent, or the install fails/re-consents on mismatch — provenance can't drift between consent and fetch); resource limits apply (max bytes, timeout, retry policy, decompressed-size + entry caps), with cleanup on interruption.

- [ ] **Scenario: the lockfile enables byte-reproducible re-hydrate**
  - **When** the lockfile is written
  - **Then** it records `{ name, version, source: host-provided|fetched, resolvedPlatform, declaredUrl, finalUrl, artifactSha256, binSha256, archive?: {innerPath}, installPath (keyed by binSha256), hostDetected?: {path, version, hash (required when host-provided)}, referrers[] }` — enough to re-provision identical bytes, prove what ran, and remove precisely.

- [ ] **Scenario: refcount + dedup by full identity**
  - **Given** two plugins using the "same" tool
  - **Then** dedup is keyed by **artifact + execution identity** (resolvedPlatform + artifactSha256 + extracted binSha256 + innerPath + normalized exe name), one verified copy is shared, and removal deletes it only when the **last referrer** is gone — computed from the lockfile, never by a plugin-provided path/name.

- [ ] **Scenario: uninstall removes only Tachyon-owned, content-addressed files**
  - **When** a plugin is removed
  - **Then** Tachyon deletes only lockfile-owned content-addressed files whose refcount hit zero; a **host-provided** tool is never touched.

- [ ] **Scenario: transactional provisioning (no partial activation)**
  - **Given** a multi-tool install or any provisioning failure (download error, checksum mismatch, archive rejection, unsupported platform, smoke-check fail)
  - **When** it runs
  - **Then** ALL tools are provisioned + verified and lockfile writes staged BEFORE any hook activates; any failure rolls back staged files + lockfile changes — no half-written binary, no hook wired to a missing/unverified tool.

- [ ] **Scenario: clone / CI lifecycle is explicit**
  - **Given** a clone whose lockfile records fetched tools but `.tachyon/bin/` is absent (gitignored)
  - **Then** there is an explicit re-hydrate flow (consent replay from the lockfile); Tachyon never silently fetches binaries during an unrelated operation.

## Non-goals

- **Windows.** Linux / WSL / macOS only.
- **Package-manager integration** (brew/apt/dnf) — authors pin direct URLs.
- **A Tachyon-curated registry / "latest" resolution / auto-update.**
- **Building from source / running installer scripts** — a provisioned artifact is a single verified executable (optionally extracted from a verified archive), never an install script.
- **Signature/attestation beyond sha256** (cosign/minisign/SLSA) — v1 is author-pinned sha256 (integrity, not trust); stronger provenance is a deferred hardening.
- **Auto-resolving complex runtime dependencies** (a tool needing system libs) — declared + failed-clearly, never silently fixed.

## Decisions (folded from the 2026-06-25 codex review)

- **D1 — author-declares per-platform pinned `{url, sha256}` (+ archive `innerPath`/`binSha256`); Tachyon fetch+verify only.** No package manager, no registry, no "latest". The author owns the pins.
- **D2 — detect-first = EXACT version + opt-in at consent** (review corrected the earlier `>=` lean: `>=` accepts unpinned unknown bytes for a highest-trust path).
- **D3 — content-addressed immutable install path** `.tachyon/bin/<name>/<sha256>/<tool>` (gitignored; never a flat mutable `.tachyon/bin/<tool>` that a later write can swap).
- **D4 — archives supported, strict single-file extraction** (`innerPath` + `binSha256` + all traversal/symlink/size rejections) — most releases ship archives; refusing them would push authors to unsafe hosting.
- **D5 — HTTPS-only, bounded redirects, final-URL recorded + shown.**
- **D6 — sha256 = integrity against the manifest, NOT trust.** Consent language says so + shows publisher; signatures are a deferred hardening (a future allowlist/policy hook).
- **D7 — transactional, per-tool consent**, smoke-check before activation.
- **D8 — install identity = EXECUTABLE bytes (`binSha256`), enforced-immutable** (`O_EXCL` no-overwrite, `0700` parents, owner + link-count checks, re-hash before wire + before each execution via a launcher). Archive storage is separate from executable storage. (Folded from round-2.)
- **D9 — platform keys are EXPLICIT** incl. libc: `linux-x64-glibc` / `linux-x64-musl` / `linux-arm64-*` / `darwin-{x64,arm64}` (closes round-1 OQ1; the author pins the right build, Tachyon detects via `getconf GNU_LIBC_VERSION`/`ldd`).
- **D10 — detect-first requires a reliable exact-version probe.** A tool the manifest can't probe for an exact version (a declared `versionCommand`/parser) is **not eligible for host-provided** — Tachyon provisions its own verified copy. (Closes round-1 OQ3/OQ4.)

## Open questions

- **OQ1 — macOS quarantine:** surface a clear "this binary is quarantined; approve it" diagnostic vs. attempt `xattr -d com.apple.quarantine` (silently bypasses Gatekeeper). Leaning: surface + instruct, never silently strip.
- **OQ2 — launcher vs inline re-hash:** does the hook call a Tachyon launcher that re-validates the binary before exec (stronger, one indirection) or does the install rely on the `0700`/owner/`O_EXCL` invariants + a wire-time re-hash (simpler)? Leaning launcher for the execution-time guarantee; confirm the cost.
