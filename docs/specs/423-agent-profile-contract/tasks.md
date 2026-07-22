# 423 — Canonical persistent agent profile — tasks

_Generated from `plan.md` on 2026-07-22. Architecture-only work in managed worktree
`agent-profile-contract`; no product code is in scope._

## Evidence and contract

- [x] Scaffold SDD 423 in the managed change worktree for Task `t-e53560`.
- [x] Record the ratified umbrella boundary and Affected Product Invariants declaration in `spec.md`.
- [x] Define the classification vocabulary and persistence effect test.
- [x] Define the normative `.tachyon/agents/<agent>/` tree and manifest responsibilities.
- [x] Map current runtime, identity, instructions, guidance, Evolution, memory and capability surfaces to
  canonical, learned, projection, authority or excluded lanes.
- [x] Define shared-reference, path custody, mutability, secret and enforcement-hook rules.
- [x] Define create/edit/rename/clone/forget/import/export/snapshot lifecycle boundaries.
- [x] Bind unresolved precedence and runtime-memory selection to explicit follow-up Tasks.
- [x] Exclude plugin schema/scope from V1 and link the dedicated plugin task chain as the future owner.

## Review and ratification

- [x] Run an independent read-only Codex adversarial review of the complete SDD 423 contract.
- [x] Fold substantiated review findings into `spec.md`, `plan.md` or `notes.md`.
- [x] Verify every acceptance criterion against repository evidence and record the result in `notes.md`.
- [x] Maintainer reviews the architecture and resolves any product-contract corrections.
- [x] Mark the spec `shipped` with Closure after ratification; this slice ships documentation only.
- [x] Mark Task `t-e53560` done and leave implementation follow-ups dependency-ordered.

## Verification

- [x] SDD ID uniqueness check passes.
- [x] Spec contains no template placeholders or unchecked acceptance criteria after ratification.
- [x] Configured typecheck and full verification remain green on the documentation-only branch.
- [x] SDD closure audit is clean after status changes to shipped.

**Verify:** `sh /home/goat/tachyon/.agents/skills/sdd/scripts/check-ids.sh`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** architecture-only contract; runtime dogfood belongs to the implementation and
installed-rollout follow-ups, especially `t-c8d2d8`.

## Visual QA

**Visual QA Opt-Out:** tracked Markdown architecture only; no product surface changes in this slice.

## Cookbook

**Cookbook-Opt-Out:** no operator surface is introduced by this architecture-only slice.
