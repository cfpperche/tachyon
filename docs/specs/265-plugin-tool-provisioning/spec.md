# 265 — plugin-tool-provisioning

_Created 2026-06-25._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

A plugin's materialized capability often depends on a **host binary**. The migrating `secrets-scan` needs `gitleaks`; a commit-time gate (spec 264) that calls a tool which isn't installed either fails open (no coverage) or fails closed (breaks every commit). To make a git-hook gate fail-**closed** meaningfully, the tool must be reliably present.

Auto-downloading an arbitrary binary is the **highest-trust operation a plugin system can perform**, so it must be constrained, auditable, atomic, and human-authorized. The ratified model: the **plugin author declares** the tool with a per-platform **pinned `{url, sha256}`** (+ archive `innerPath` + extracted-binary sha256 when it ships as an archive); Tachyon **detects-first** (skip only if the host has it at the **exact** declared version, opt-in at consent), else downloads to a **private temp on the same filesystem**, hashes the bytes, `fsync`s, marks executable, and **atomic-renames into a content-addressed immutable path** `.tachyon/bin/<name>/<sha256>/<tool>`; a checksum mismatch fails closed (bytes discarded, never executed). The consent drawer surfaces the resolved platform + **declared and final** URL + checksum per tool for an **explicit, stronger-than-MCP, per-tool** acknowledgement — with language making clear sha256 proves **integrity against the manifest, not trustworthiness**. HTTPS-only, bounded redirects, resource-limited. Tachyon stays out of per-tool maintenance: it fetches and verifies exactly the pins — never "latest", a mirror, or a curated registry.

**Done** = a plugin declares pinned per-platform tools; install resolves the platform (Linux glibc/musl + arm64/x64, macOS x64/arm64 incl. Rosetta, WSL=linux; Windows/unsupported refused), detect-first (exact version, opt-in), else fetches→verifies→atomic-installs into the content-addressed path, smoke-checks it, records the full resolved provenance in the lockfile (reproducible re-hydrate, refcounted removal), and the materialized hook/skill references the verified binary by absolute path. Provisioning is transactional: all tools land + verify before any hook activates.

## Acceptance criteria

- [ ] **Scenario: a plugin declares a pinned, per-platform tool**
  - **Given** a manifest tool `{ name, version, platforms: { "linux-x64-glibc": {url, sha256, archive?: {type, innerPath, binSha256}}, "linux-arm64-glibc": {...}, "linux-x64-musl": {...}, "darwin-x64": {...}, "darwin-arm64": {...} } }`
  - **When** it is loaded
  - **Then** validation is fail-closed: each platform entry needs an HTTPS URL + a 64-hex `sha256`; an archive entry additionally needs `type`, a normalized contained `innerPath`, and the extracted-binary `binSha256`. Malformed/incomplete → rejected before consent.

- [ ] **Scenario: download → verify → atomic install (no TOCTOU)**
  - **Given** the tool is absent and the platform supported, and the human authorized
  - **When** Tachyon provisions
  - **Then** it downloads to a private temp on the **same filesystem** as `.tachyon/bin/`, hashes the bytes against `sha256`, `fsync`s, `chmod +x`, then **atomic-renames into `.tachyon/bin/<name>/<sha256>/<tool>`** (content-addressed, immutable). A mismatch discards the temp and **fails closed**. The file the hook later runs is the verified, content-addressed path (re-hashed before wiring).

- [ ] **Scenario: archive extraction is safe**
  - **Given** a tool shipped as an archive
  - **When** Tachyon extracts
  - **Then** it verifies the archive sha256, extracts **only** the declared `innerPath`, and rejects: path traversal, absolute paths, symlinks, hardlinks, device/special files, multiple outputs, and an over-cap entry count / decompressed size. The extracted binary is verified against `binSha256` before install.

- [ ] **Scenario: detect-first is conservative (exact version, opt-in)**
  - **Given** the host has the tool on `PATH`
  - **When** install resolves it
  - **Then** "host-provided" is **opt-in at consent**, requires an **exact** version match by default, and records the **absolute path** + detected version (+ optional hash). A relative, world-writable, or untrusted `PATH` location is rejected. Without opt-in, Tachyon provisions its own verified copy.

- [ ] **Scenario: platform resolution; unsupported refused**
  - **Given** the host
  - **When** install resolves the platform
  - **Then** it derives from `process.platform`/`process.arch` corroborated by `uname -s/-m`, detects WSL (→ linux), Rosetta (darwin-x64 under arm64), and **glibc vs musl** on Linux; an unsupported arch/libc/OS (incl. Windows, or one the manifest doesn't pin) **fails with a specific, machine-readable error** — never a wrong-arch download or silent skip.

- [ ] **Scenario: post-verify smoke check before activation**
  - **Given** a freshly provisioned binary
  - **When** before any hook is wired to it
  - **Then** Tachyon runs a non-mutating smoke check (magic/`file` sniff + `--version` with a timeout in a constrained env); a binary that isn't a runnable native executable for the platform fails closed with diagnostics (covers missing dynamic libs, wrong arch, macOS quarantine/Gatekeeper — surfaced, never silently bypassed).

- [ ] **Scenario: explicit, stronger, PER-TOOL consent**
  - **Given** an install that will fetch one or more binaries
  - **When** the consent drawer renders
  - **Then** EACH tool shows name, version, resolved platform, declared URL, **final URL after redirects**, and sha256, with a dedicated per-tool acknowledgement; the language states sha256 proves integrity **against the manifest only, not trust**, and surfaces the plugin's publisher identity.

- [ ] **Scenario: HTTPS + bounded redirects + recorded provenance**
  - **Given** a download
  - **Then** only HTTPS is allowed (reject `file:`/`http:`/protocol downgrade); redirects are bounded and the **final** URL is recorded and shown; resource limits apply (max bytes, timeout, retry policy, decompressed-size + entry caps), with cleanup on interruption.

- [ ] **Scenario: the lockfile enables byte-reproducible re-hydrate**
  - **When** the lockfile is written
  - **Then** it records `{ name, version, source: host-provided|fetched, resolvedPlatform, declaredUrl, finalUrl, artifactSha256, archive?: {innerPath, binSha256}, installPath, hostDetected?: {path, version, hash?}, referrers[] }` — enough to re-provision identical bytes and remove precisely.

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

## Open questions

- **OQ1 — musl-vs-glibc declaration:** is the libc a separate platform key (`linux-x64-musl`) the author pins, or auto-detected with a single linux key? Leaning explicit keys (the author knows which build is which); confirm the detection mechanism (`ldd --version` / `getconf`).
- **OQ2 — macOS quarantine:** surface a clear "this binary is quarantined; approve it" diagnostic vs. attempt `xattr -d com.apple.quarantine` (which silently bypasses Gatekeeper). Leaning: surface + instruct, never silently strip.
- **OQ3 — smoke-check shape:** exact form of the `--version`/magic check + its sandbox; and whether a tool with no `--version` is allowed (magic-only).
- **OQ4 — version source of truth for detect-first:** parse the tool's `--version` output (brittle) vs trust the declared version; record the raw output either way.
