# 265 — plugin-tool-provisioning

_Created 2026-06-25._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

A plugin's materialized capability often depends on a **host binary**. The migrating `secrets-scan` needs `gitleaks`; a commit-time gate (spec 264) that calls a tool which isn't installed either fails open (no coverage) or fails closed (breaks every commit) — both bad. Today Tachyon can only **detect-and-guide** ("install gitleaks yourself"), which leaves the gate untrustworthy. To make a git-hook gate fail-**closed** meaningfully, the tool must be reliably present.

So: let a plugin **provision** its tool — but auto-downloading an arbitrary binary is the highest-trust operation a plugin system can perform, so it must be constrained, auditable, and human-authorized. The model: the **plugin author declares** the tool with a per-platform **pinned URL + sha256**; Tachyon **detects first** (skip if the host already has it at the declared version), else **fetches into a sandboxed `.tachyon/bin/`**, **verifies the checksum** (fail-closed on mismatch — never execute unverified bytes), marks it executable, and the consent drawer surfaces the URL + checksum + resolved platform for an **explicit, stronger-than-MCP** acknowledgement. Tachyon stays out of the per-tool maintenance business: it only fetches and verifies exactly what the manifest pins — it never resolves versions, picks mirrors, or curates a registry.

**Done** = a plugin declares a tool with per-platform pinned `{url, sha256}`; install resolves the platform (Linux/WSL/macOS; Windows refused), detect-first, else fetches + checksum-verifies into `.tachyon/bin/`, records it in the lockfile for reproducible re-hydrate and precise removal, and the materialized hook/skill references it by absolute path. The human authorizes the fetch with full provenance in front of them.

## Acceptance criteria

- [ ] **Scenario: a plugin declares a pinned, per-platform tool**
  - **Given** a manifest declaring a tool `{ name, version, platforms: { "linux-x64": {url, sha256}, "linux-arm64": {...}, "darwin-x64": {...}, "darwin-arm64": {...} } }`
  - **When** it is loaded
  - **Then** it validates fail-closed: each platform entry needs a URL + a 64-hex sha256; a malformed/incomplete declaration is rejected before consent.

- [ ] **Scenario: detect-first skips a host-provided tool**
  - **Given** the host already has the tool on `PATH` satisfying the declared version
  - **When** the plugin installs
  - **Then** Tachyon does NOT fetch; it records the tool as **host-provided** (and the hook uses the host binary). No download, no `.tachyon/bin/` entry.

- [ ] **Scenario: fetch + checksum-verify into the sandbox**
  - **Given** the tool is absent (or the wrong version) and the platform is supported
  - **When** the human authorizes
  - **Then** Tachyon downloads the platform's URL to `.tachyon/bin/<tool>`, verifies the bytes against the declared sha256, and `chmod +x`; a **checksum mismatch fails closed** (the binary is discarded and install aborts — unverified bytes are never executed or kept).

- [ ] **Scenario: explicit, stronger consent**
  - **Given** an install that will fetch a binary
  - **When** the consent drawer renders
  - **Then** it shows the tool, version, **resolved platform**, the exact **URL**, and the **sha256**, and requires a dedicated acknowledgement (distinct from and stronger than the MCP ack) — executable code from the network is the highest-risk capability.

- [ ] **Scenario: platform resolution; Windows refused**
  - **Given** the host platform (via `uname`)
  - **When** install resolves it
  - **Then** WSL resolves to `linux-*`; an unsupported platform (Windows, or an arch the manifest doesn't pin) **fails with a clear message** — never a wrong-arch download or a silent skip.

- [ ] **Scenario: absolute-path reference, no PATH pollution**
  - **Given** a fetched tool
  - **When** a hook/skill uses it
  - **Then** it references `.tachyon/bin/<tool>` by **absolute path**; Tachyon never mutates the system `PATH` or installs to a system location.

- [ ] **Scenario: the lockfile records the provisioned tool**
  - **Given** a fetched (or host-provided) tool
  - **When** the lockfile is written
  - **Then** it records `{ name, version, source: host-provided | fetched, resolvedPlatform, sha256, path }` — enough to re-hydrate byte-reproducibly and to remove precisely.

- [ ] **Scenario: uninstall removes only what Tachyon fetched**
  - **Given** removal of a plugin that fetched a tool
  - **When** it is removed
  - **Then** Tachyon deletes the binary from `.tachyon/bin/`; a **host-provided** tool is never touched. A tool still referenced by another installed plugin is not removed (refcount).

- [ ] **Scenario: fail-closed on any provisioning failure**
  - **Given** a download error, checksum mismatch, or unsupported platform
  - **When** install runs
  - **Then** it aborts with a clear error and **no partial activation** (no half-written binary, no hook wired to a missing/unverified tool).

- [ ] **Scenario: the maintenance boundary holds**
  - **Given** a tool declaration
  - **Then** Tachyon only fetches + verifies exactly the pinned URL/sha256 — it never resolves "latest", picks a mirror, or consults a Tachyon-curated registry. The author owns the pins (and their upkeep).

## Non-goals

- **Windows.** Linux / WSL / macOS only.
- **Package-manager integration** (brew/apt/dnf/…) — the author pins direct URLs, not package specs.
- **A Tachyon-curated tool registry / "latest" resolution / auto-update** — out of scope; the manifest pins exact bytes.
- **Building from source / running installers** — a fetched artifact is a single verified executable (or a verified archive with a declared inner path, if OQ2 says so), not an arbitrary install script.
- **Signature/attestation beyond sha256** (cosign/minisign/provenance) — v1 is author-pinned sha256; stronger provenance is a future hardening (OQ4).

## Open questions / forks to ratify

- **OQ1 — version-detect threshold.** Detect-first match: exact declared version, or `>=`? Leaning `>=` for the host-provided case (don't force a downgrade), recording the detected version. Confirm.
- **OQ2 — archive vs bare binary.** Many tools ship as a `.tar.gz`/`.zip` containing the binary, not a bare executable. Does v1 support a declared archive `{ url, sha256, extract: "<inner path>" }` (checksum the archive, extract one path), or require the author to pin a direct bare-binary URL? Leaning: support a single declared inner path (most releases are archives), checksum the archive.
- **OQ3 — refcount + shared tools.** Two plugins declaring the same tool/version: one fetch, shared in `.tachyon/bin/`, removed only when the last referrer is gone. Confirm the dedup key (name+version+sha256) and the refcount source (the lockfile).
- **OQ4 — provenance hardening.** sha256-only for v1; note cosign/minisign/SLSA as a deferred hardening. Confirm v1 = sha256.
- **OQ5 — `.tachyon/bin/` lifecycle.** Gitignored (regenerated from the lockfile on install) — consistent with `.tachyon/`. Confirm; and whether a fresh clone auto-provisions on next plugin op or waits for an explicit install.
- **OQ6 — consent granularity.** One ack for all of a plugin's tools, or per-tool? Leaning one ack listing every tool with its URL+checksum.
