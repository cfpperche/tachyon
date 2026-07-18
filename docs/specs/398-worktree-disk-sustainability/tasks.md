# 398 — tasks

**Verify (plan phase):** docs only — human review of plan.md decisions D1–D7  
**Verify (impl):** see phases in plan.md; vitest for WorktreeGcService + dry-run fixtures  
**Dogfood:** `du` before/after; never claim VHDX file shrank without Windows compact

## Plan phase (this PR)

- [x] T0 — Remeasure disk populations (canonical vs legacy)
- [x] T1 — Write spec.md intent + acceptance
- [x] T2 — Write plan.md decisions, phases, risks
- [x] T3 — Write tasks.md + notes.md; link t-2a2af8

## Implementation (follow-on; not this PR)

- [ ] P1-T1 — `WorktreeGcService` classify + inventory
- [ ] P1-T2 — Bridge `worktree_gc` dryRun
- [ ] P1-T3 — Boot orphan inventory log (setting)
- [ ] P1-T4 — Unit tests classifier matrix
- [ ] P2-T1 — Auto-reclaim orphans past grace via managed remove
- [ ] P2-T2 — Reclaim stopped-clean registry entries past `reclaimStoppedAfter`
- [ ] P2-T3 — Concurrency / partial failure tests
- [ ] P3-T1 — `settings.worktree.shareNodeModules` + ensure helper
- [ ] P3-T2 — Primer / onboarding one-liner
- [ ] P3-T3 — Dogfood incremental size ≤100MB or documented ceiling
- [ ] P4-T1 — `.vscode-test` keep-N GC + lock
- [ ] P4-T2 — `docs/runbooks/disk-and-vhdx.md`
- [ ] P5-T1 — Cockpit disk rows: bytes + retention reason
