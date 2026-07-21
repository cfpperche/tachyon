# 420 — companion-tab-tools-v2 — tasks

_Board is source of execution order; this file tracks SDD hygiene._

## Phase 0 — Design

- [x] Scaffold SDD `420-companion-tab-tools-v2`
- [x] Probe open questions (codex gpt-5.6-sol `probe-94a1a975…`) and fold must-fix into Decisions
- [x] Status → `in-progress` (post-probe)
- [x] Maintainer ratifies Decisions table (R1–R6 yes, 2026-07-21) + RATIFY.md visuals
- [x] Design task `t-a5154a` → done after ratify + merge of design docs
- [ ] Artifact refs on foundation tasks point to this SDD

## Phase 1 — Foundation + safety (board)

- [x] `t-f56a16` tabId + @e + envelope on existing tools (merged main)
- [x] `t-5fcbd3` protections baseline (tabSafety + gateMutation + mutations.jsonl + allowedHosts; human confirm UI deferred)

## Phase 2–3 — P0 tools (board)

- [x] `t-e2a48f` tabs_list (foundation)
- [x] `t-1994a2` open / activate / close  
- [x] `t-bb2b6d` navigate  
- [x] `t-88d3a8` wait_for  
- [x] `t-161439` scroll  
- [x] `t-44de66` press_key  

## Phase 4 — Dogfood

- [ ] `t-4ffb40` multi-tab race — **human dogfood batched at end of roadmap** (maintainer)

## Phase 5 — P1 (board)

- [ ] `t-97c49a` … through `t-e7d917` per umbrella  

## Verification

**Verify (headless):**
- `vitest` companionTabSafety + companionTabChannel420 + companionPairing
- `tsc --noEmit` ADE + companion monorepo typecheck
- Companion browser 0.5.1 handlers for P0 kinds

**Dogfood-Opt-Out:** headless unit/protocol gates only until end-of-roadmap batch.  
**Human dogfood:** full P0+P1 batch after roadmap (no incremental dogfood).  

**Visual QA Opt-Out:** agent tools; no new Control chrome required for P0 (confirm UI may need visual pass when implemented).  

**Cookbook:** yes — after first P0 tool ship (operator: tabId + snapshot + act).  
