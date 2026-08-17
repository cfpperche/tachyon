# 510 — code-intelligence — tasks

_Generated from `plan.md` on 2026-08-17. This delivery stops at the contract. Implementation boxes stay unchecked until a later change writes product code._

## This delivery (spec only)

- [x] Remedir Claude 2.1.233, Grok 1.0.4, Codex 0.147.0 with version, date and negative control (`t-4fbbb2` journal `j-b411f585abbd`).
- [x] Write `spec.md` (intent, remedir, design, actor×trigger, acceptance).
- [x] Write `plan.md` (decisions, rejected alternatives, located files).
- [x] No product code (`src/`, `packages/`, `test/` untouched).

**Dogfood-Opt-Out:** no product behavior ships in this change.
**Cookbook-Opt-Out:** no operator surface yet; add `cookbook.md` when the four tools exist.
**Visual QA Opt-Out:** no rendered surface.

## Implementation (later)

- [ ] Add `settings.codeIntelligence.tools` to `loadConfig` + schema; unknown keys discarded.
- [ ] Workspace predicate + `forceToolListRefresh` on flip (copy the `tabTools` block).
- [ ] Four `code_*` tools in a new Bridge module; list gate ≠ call gate.
- [ ] Host pool keyed on `realpath` of the worktree root; disk-only; no document sync.
- [ ] Evict inside `WorktreeManager.remove` `withLock` after occupancy, before git. Do not extend `WorktreeOccupancy`.
- [ ] Orphan scan on host start; reap only PIDs the pool recorded.
- [ ] One test per actor×trigger row in `spec.md`. Watch the second door fail first.
- [ ] Resolve open questions 1–3 (staleness, queue, memory cap) in the task journal before coding the pool.
- [ ] Typed parity dimension only if the owner still wants one — new key, never row 19; `runtime` is `measured`/`cannot`/`unmeasured`+`needed`.
