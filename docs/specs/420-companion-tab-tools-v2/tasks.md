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

- [x] `t-4ffb40` multi-tab race + human dogfood B–F (Dev Host, Companion 0.5.4/0.5.5)

## Phase 5 — P1 (board)

- [x] `t-97c49a` directed get
- [x] `t-1dfdfd` hover/select/check (+ `t-fc80bc` drag)
- [x] `t-c5ad8e` screenshot full_page/element scopes
- [x] `t-429a08` find text
- [x] `t-d65e35` upload/download
- [x] `t-25d335` list_frames + shadow pierce + dialog
- [x] `t-e7d917` network log (redacted)

## Phase 6 — Post-dogfood follow-ups

- [x] `t-8f0862` safety: needs_confirm resolves `@e` (TabRefCache) — ADE `61eabe5f`
- [x] `t-ca6420` navigate `/download` not auto-confirm; file-like URLs only
- [x] `t-39cbec` dialog custom modals — Companion 0.5.6
- [x] `t-bb8858` list_frames: investigated (TinyMCE site limit; nested_frames OK)
- [x] `t-a8e4ed` screenshot retry once on readback fail — 0.5.6
- [x] `t-d16753` password `@e` stamp — 0.5.6
  

## Verification

**Verify (headless):** companionTabSafety + companionTabChannel420 + pairing; ADE+companion tsc.  
**Human dogfood:** B–F complete (Dev Host + Companion 0.5.4/0.5.5); evidence under `.tachyon/dev-host/workspace/.tachyon/dogfood/`.  
**Visual QA Opt-Out:** agent tools; Companion sidepanel UI refreshed 0.5.5 (maintainer approved).  
