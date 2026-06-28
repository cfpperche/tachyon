# 285 — external-tool-requirements · notes

## Codex dueto — 2026-06-28 (design review, folded)
Adversarial technical review (read-only, high effort). Mandate: technical review + improvements ONLY, no scope cuts.
Verdicts: 284 SHIP-WITH-CHANGES, 285 NEEDS-REVISION (2 BLOCKERs). **All findings folded** into spec.md § Design
decisions (D1–D8 / D1–D7) + Acceptance + resolved OQs. Headlines: 285 `requires`→`externalTools` (name collision);
install = structured argv + PTY runner (no shell); spoof-resistant detection + mechanical guardrails; `_tachyon-external`
resolver. 284 sha256-first content-addressing; streamed hashing; finalUrl/TOCTOU binding; fd-enforced resolver guarantee
(honest "at resolve time"); cap = separate 1 GiB; archive rejected with an error.
Status: design-complete, ready for /sdd plan → build.
