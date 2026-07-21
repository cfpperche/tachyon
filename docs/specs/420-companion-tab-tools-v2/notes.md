# 420 — companion-tab-tools-v2 — notes

_Created 2026-07-21._

## Provenance

- 2026-07-21 — Maintainer roadmap (P0 + protections + P1) locked on board umbrella `t-ca13aa`.
- 2026-07-21 — Design task `t-a5154a` active; SDD scaffolded on worktree
  `tachyon/change/companion-tab-tools-v2-design`.
- Parent product: SDD 414 shipped (browser Companion MVP).

## Design decisions (draft — pending ratify)

See `spec.md` § Decisions. Summary lean:

- **tabId required** (Chrome tab id string); no active-tab default in v2.
- **@e refs** from snapshot; selector fallback; ref wins if both.
- **Envelope** with status applied|not_applied|timeout|error.
- **Safety day one**: confirm matrix, secrets block, mutation jsonl, optional allowedHosts.
- **protocolVersion** bump when wire breaks.
- **P1 after** multi-tab dogfood.

## Deviations

_None yet._

## Implementation log

_Empty (design only)._

## Open questions for maintainer ratify

1. Confirm **tabId required** (no soft active default) — recommended yes.  
2. Confirm **Chrome tab id** vs opaque Companion-generated id — recommended Chrome id.  
3. Confirm **mutation log path** `.tachyon/companion/mutations.jsonl` — ok?  
4. Confirm matrix: is “publish” heuristic enough (button labels / role=submit) or URL allowlist only?  
5. Any P1 item that should jump ahead of P0 dogfood? (default no.)  
