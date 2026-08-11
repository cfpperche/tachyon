# Spec 398 — Worktree disk sustainability (VHDX / cache GC)

_Created 2026-07-18._

**Status:** draft
**Status detail:** draft (plan only — no product code in this revision)

**Task:** `t-2a2af8`  
**Related:** `t-e7a032` (inventory cleanup), specs **210** (agent worktrees), **368** (delivery leases), **376** (legacy delivery retire), **392** (managed worktree registry)

## Intent

Tachyon worktree isolation is correct for safety and gates, but **disk cost is unsustainable** on WSL/VHDX hosts: each fresh tree often runs `npm ci` into a full `node_modules` (~400MB+), lifecycle rarely reclaims space, and `.vscode-test` multi-version installs pile up. Humans see growing VHDX even after agents finish.

**Done** = managed worktrees are **cheap to hold**, **predictable to retain**, and **safe to reclaim**, with visible retention reasons and measured before/after dogfood — without weakening isolation, dirty/active protection, or verify hermeticity.

## Problem (measured)

| When | Observation |
|------|-------------|
| 2026-07-10 (task body) | `~/.cache/tachyon/worktrees` ~5.2 GB; 11 isolated trees ~472 MB each; ~410 MB `node_modules` × N ≈ 4.5 GB duplicated; `.vscode-test` ~2.6 GB multi-version |
| 2026-07-18 (plan remeasure) | Base ~1.4 GB total; **legacy `pi-*` trees outside wsHash layout** still ~483 MB each (full `node_modules`); canonical `b349073a/change/*` often ~25–50 MB (no full install / symlink habit) — **two populations** |
| Always | Freeing files in WSL **does not shrink** the Windows VHDX until host-side compact; docs must say so |

Root causes (product, not Windows):

1. **Create path** incentivizes full `npm ci` per tree (primer / onboarding).
2. **No shared dependency materialization** — each tree is a physical install by default.
3. **Retention is manual** — remove requires human/agent Bridge call; finished clean trees linger.
4. **Orphans** — trees outside registry / old path layouts (pre-392) not swept on reload.
5. **`.vscode-test`** accumulates VS Code engine versions with no product GC policy.

## Goals

1. **Measure** per-worktree bytes, retention reason, last used, last GC result.
2. **Safe automatic reclaim** of finished, clean, unoccupied managed worktrees (and optional branch delete when Tachyon-created).
3. **Dependency strategy** that keeps installs deterministic but avoids N full `node_modules` copies when the host FS allows (symlink / hardlink / content-addressed cache — decision in plan).
4. **`.vscode-test` retention** — keep configured/current engine(s); GC older with concurrency-safe locks.
5. **Operator surfaces**: dry-run GC, explicit GC, Cockpit/Control bytes + reason (minimal viable).
6. **Docs**: WSL free blocks vs Windows VHDX compact.

## Non-goals (v1)

- Shrinking the VHDX file from inside Linux (Windows Host Compact / Optimize-VHD only).
- Networked shared npm registry service.
- Auto-delete of dirty trees or trees with live occupancy (never).
- Changing Delivery lease/occupancy semantics (368) beyond calling existing remove gates.
- Full rewrite of primer / onboarding contracts (may add one guidance line).
- Remote/SSH worktrees.

## Affected Product Invariants

`none` — disk lifecycle for managed checkouts; no change to registered PI promises. Fail-closed remove remains.

## Acceptance criteria (implementation phase)

- [ ] **Scenario: incremental cost after first deps**
  - **Given** a host that can share deps (plan-chosen mechanism)
  - **When** 10 clean managed worktrees are created and set up for typecheck/tests
  - **Then** median **incremental** disk ≤ **100 MB** per additional tree after the first materialization, **or** dogfood documents a measured equivalent ceiling with rationale
- [ ] **Scenario: finished clean tree is reclaimed**
  - **Given** a registry worktree with no occupant, clean git status, no open Delivery lease, past grace (if any)
  - **When** auto-GC or explicit GC runs
  - **Then** path is removed via managed remove; registry entry gone; reason logged
- [ ] **Scenario: active or dirty is retained**
  - **Given** occupied cwd **or** dirty tree **or** held Delivery
  - **When** GC runs
  - **Then** tree is kept; retention reason is `occupied` | `dirty` | `delivery-held` | `grace` | …
- [ ] **Scenario: reload orphan sweep**
  - **Given** a directory under the managed base with no registry entry and no occupant, older than grace
  - **When** workspace/engine starts (or scheduled GC)
  - **Then** it is offered for reclaim (dry-run first in dogfood); never deletes outside managed base
- [ ] **Scenario: `.vscode-test` GC**
  - **Given** ≥3 engine versions installed
  - **When** GC runs with keep=current+1 (configurable)
  - **Then** older versions removed without breaking a concurrent `npm test` holding a lock
- [ ] **Scenario: dry-run**
  - **When** operator runs GC dry-run
  - **Then** report lists would-delete / would-keep + reasons; no deletes
- [ ] Unit/integration: active, dirty, clean-done, orphan, concurrent partial failure
- [ ] Dogfood: `du` before/after on real cache; note VHDX compact is separate
- [ ] Docs updated (runbook + short README pointer)

## Open questions (resolve in plan § Decisions)

1. Symlink `node_modules` → primary workspace vs pnpm store vs npm cache hardlinks?
2. Auto-GC trigger: only on dismiss/kill/land, and/or periodic, and/or engine boot?
3. Grace period default (e.g. 24h after last agent stop)?
4. Should Control show a “Disk” strip or only log + Bridge tool?
