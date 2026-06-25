# 265 — plugin-tool-provisioning — notes

_Created 2026-06-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

### 2026-06-25 — origin

Spec B of the two-spec arc (264 git-hook target → 265 tool/binary provisioning). The maintainer ratified the safe binary model in discussion: **author-declares per-platform pinned `{url, sha256}`; Tachyon detects-first then fetches + checksum-verifies into a sandboxed `.tachyon/bin/`, human-authorized; no package manager, no system PATH pollution, no Tachyon-curated registry.** This is what makes the 264 git-hook gate trustworthy as fail-closed (the scanner binary reliably present). Sequenced AFTER 264 and re-validated once 264 ships.

## Deviations

## Tradeoffs

## Open questions
