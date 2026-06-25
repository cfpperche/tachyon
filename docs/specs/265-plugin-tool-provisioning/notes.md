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

### 2026-06-25 — codex review round 2 (verification → folded)

Second pass (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T*-spec265-review2/`). **B4 CLOSED**; **B1/B2/B3 PARTIAL** → tightened:
- **Operational immutability** (was asserted, not enforced): `O_EXCL` no-overwrite create, `0700` private parents, owner + hard-link-count checks, re-hash before wiring AND before each execution (launcher) — D8.
- **Install identity = EXECUTABLE bytes** `binSha256`, not the archive/artifact hash; archive storage separated from executable storage — D8.
- **Host-provided** records the host binary hash (required), optional manifest `allowedHostSha256`, and full-path ownership+mode trust (not just "not relative/world-writable") — detect scenario.
- **Consent↔download provenance can't drift**: consented final URL must exactly match the post-consent download's final URL.
- **Archive metadata-first** (never materialize entries during traversal); **smoke-check inside the trust boundary** (after verify, minimal env, no repo cwd/sensitive env/network, timeouts, output caps).
- Closed round-1 OQ1 (explicit libc platform keys, D9) + OQ3/OQ4 (detect-first needs a reliable exact-version probe or it's not host-eligible, D10).

The architecture (author-pinned + fetch/verify + content-addressed + consent) held; round 2 hardened the TOCTOU/identity/trust edges. Signatures stay deferred (D6).

## Deviations

## Tradeoffs

## Open questions
