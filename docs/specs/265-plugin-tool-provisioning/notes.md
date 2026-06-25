# 265 — plugin-tool-provisioning — notes

_Created 2026-06-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

### 2026-06-25 — origin

Spec B of the two-spec arc (264 git-hook target → 265 tool/binary provisioning). The maintainer ratified the safe binary model in discussion: **author-declares per-platform pinned `{url, sha256}`; Tachyon detects-first then fetches + checksum-verifies into a sandboxed `.tachyon/bin/`, human-authorized; no package manager, no system PATH pollution, no Tachyon-curated registry.** This is what makes the 264 git-hook gate trustworthy as fail-closed (the scanner binary reliably present). Sequenced AFTER 264 and re-validated once 264 ships.

### 2026-06-25 — codex spec review (NEEDS-REVISION → folded)

Adversarial codex review (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T202052Z-spec265-review/`). Verdict NEEDS-REVISION; folded into `spec.md`:

- **4 BLOCKERs:** (1) verify→execute TOCTOU → download to same-fs temp, hash, fsync, chmod, **atomic-rename to content-addressed immutable path**. (2) flat `.tachyon/bin/<tool>` is not a stable identity → `.tachyon/bin/<name>/<sha256>/<tool>`, re-hash before wiring. (3) detect-first too trusting → host-provided is **opt-in + exact version** (corrected my `>=` lean), reject relative/writable/untrusted PATH. (4) archive extraction must be first-class → `innerPath`+`binSha256` + reject traversal/symlink/hardlink/device/multiple/oversized.
- **HIGHs folded:** lockfile records full provenance (declaredUrl/finalUrl/artifactSha/binSha/installPath/hostDetected/referrers); refcount key = platform+artifactSha+binSha+innerPath+exeName; uninstall removes only lockfile-owned content-addressed files; exact platform resolution (process.platform/arch + uname + Rosetta + WSL + **musl-vs-glibc**); **sha256 = integrity not trust** (scary consent + publisher identity); HTTPS-only + bounded redirects + final-URL recorded; download resource limits; transactional provisioning (all tools before any activation).
- **MEDIUM/LOW folded:** post-verify smoke check (magic + `--version`); dynamic-lib/macOS-quarantine surfaced (not bypassed); per-tool consent; host-provided path revalidated each run; archives supported with strict single-file extraction; explicit clone/CI re-hydrate (no silent fetch); content-addressed namespacing; machine-readable error codes.
- **No blind accept:** every BLOCKER/HIGH was genuinely a real supply-chain/TOCTOU hole — accepted. The only softening: signatures (cosign/minisign) stay a deferred hardening (D6), not v1, since author-pinned sha256 + per-tool consent + publisher identity is a defensible v1 trust floor.

## Deviations

## Tradeoffs

## Open questions
