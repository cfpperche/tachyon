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

- [ ] `t-f56a16` tabId + @e + envelope on existing tools  
- [ ] `t-5fcbd3` protections baseline  

## Phase 2–3 — P0 tools (board)

- [ ] `t-e2a48f` tabs_list  
- [ ] `t-1994a2` open / activate / close  
- [ ] `t-bb2b6d` navigate  
- [ ] `t-88d3a8` wait_for  
- [ ] `t-161439` scroll  
- [ ] `t-44de66` press_key  

## Phase 4 — Dogfood

- [ ] `t-4ffb40` multi-tab race  

## Phase 5 — P1 (board)

- [ ] `t-97c49a` … through `t-e7d917` per umbrella  

## Verification

**Verify:** _(add with foundation — e.g. focused vitest companion tab protocol)_  

**Dogfood-Opt-Out:** design-only commits have no runtime dogfood.  
**Human dogfood:** `t-4ffb40` after P0.  

**Visual QA Opt-Out:** agent tools; no new Control chrome required for P0 (confirm UI may need visual pass when implemented).  

**Cookbook:** yes — after first P0 tool ship (operator: tabId + snapshot + act).  
