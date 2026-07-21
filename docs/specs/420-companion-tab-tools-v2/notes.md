# 420 — companion-tab-tools-v2 — notes

_Created 2026-07-21._

## Provenance

- 2026-07-21 — Maintainer roadmap (P0 + protections + P1) locked on board umbrella `t-ca13aa`.
- 2026-07-21 — Design task `t-a5154a` active; SDD scaffolded on worktree
  `tachyon/change/companion-tab-tools-v2-design`.
- Parent product: SDD 414 shipped (browser Companion MVP).
- 2026-07-21 — Maintainer: design open questions always via `probe_agent` (prefer codex gpt-5.6-sol;
  claude fable OK). Record runId in notes/journal — **not** pins (pins are human-facing).

## Probe log

### 2026-07-21 — codex gpt-5.6-sol · adversarial-review

- **runId:** `probe-94a1a975-c98a-4c2d-bed6-7bd8fc19a745`
- **Verdict:** **block** (ratify only after must-fix)
- **Q1 tabId required:** modify — require + document identity validation  
- **Q2 Chrome id on wire:** **no** — opaque companion handle  
- **Q3 mutations.jsonl path:** modify — redaction, rotation, schema, gitignore  
- **Q4 confirm heuristic/URL only:** **blocker** — layered policy  
- **Q5 no P1 before dogfood:** modify — promote risk prerequisites, not product P1  
- **Extra:** envelope needs `unknown_outcome` + no unsafe retry; @e lifecycle; protocol fail-closed  

Incorporated into `spec.md` Decisions table (probe-adjusted).

## Design decisions (current)

See `spec.md` § Decisions. Summary:

- Opaque companion **tabId** on wire; Chrome id internal.  
- tabId **required** + document token validation before mutate.  
- @e scoped to tab/frame/document generation; no silent CSS fallthrough.  
- Envelope with `unknown_outcome` / `retrySafe`.  
- Layered confirm; redacted mutation log under `.tachyon/companion/mutations.jsonl`.  
- Dogfood gated on identity/safety prerequisites; product P1 after multi-tab dogfood.

## Deviations

- Original draft used Chrome tab id on the wire; probe rejected → opaque handle.

## Implementation log

_Empty (design only)._

## Awaiting maintainer

**Ratify** the probe-adjusted Decisions table in `spec.md` (one “yes” is enough to close design
and start foundation `t-f56a16`).
