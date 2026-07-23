# 428 — Agent capability projections — notes

_Created 2026-07-22. Append-only by convention._

## Design decisions

- The existing profile schema already separates selection (`capabilities.*`) from typed references, and the existing harness already owns runtime-native serialization. This slice fills the bounded resolver/authority/projection gap rather than replacing either side.
- The active Product Invariant registry contains only PI-001, which concerns project-guidance ownership. No registered fixed oracle changes in this slice.
- Codex skills/MCP/hooks and Pi explicit resources are the only activation matrix for this slice. Other legacy harness writers are not treated as proof of a measured canonical profile contract.
- Selected payloads are captured as bounded no-follow bytes/trees by the resolver. Runtime materialization consumes that snapshot, not the original source path.

## Source inventory

- Canonical root and trust-boundary rules: SDD 423.
- Existing profile reference resolution and source provenance: `agentProfileResolver.ts`.
- Existing private runtime writers for MCP, hooks, skills, and Pi resources: `HarnessManager.ts` and `HarnessDef`.
- Current canonical activation limitation: `agentProfileProjection.ts` has a measured Codex-only native-input inspector and deliberately blocks all non-plugin capabilities.

## Deviations

- The first draft proposed re-verifying source paths at materialization. Probe `probe-5354b2e2-2b45-477a-951a-620221f59af7` correctly identified the remaining time-of-check/time-of-use window, so the plan changed to exact captured-byte consumption.
- Implementation review `probe-a170ad94-d29f-489d-bc4a-3459acaabb54` found empty selectors bypassing attestation, non-repairable Pi projections, weak hook validation, package collisions, unselected-source reads, and an adapter diagnostic mismatch. Each finding received a focused regression test and fix.
- Recheck `probe-3243c940-e9c3-4d7e-b18a-f575cce4e021` confirmed those fixes and exposed the same repair and package-shape gaps in the legacy Pi path. The common Pi publisher and package validator were strengthened so profile projection does not create a stricter parallel lifecycle than the existing path.

## Tradeoffs

- The probe recommended a new atomic generation/pointer system for the complete Codex private home. This slice keeps the existing synchronous pre-launch ownership model and stages only capability-owned trees; replacing the whole private-home lifecycle would duplicate later lifecycle work and expand scope without a current concurrent-launch contract.

## Open questions

None.

## Review evidence

- Design review: `/home/goat/tachyon/.tachyon/probes/probe-5354b2e2-2b45-477a-951a-620221f59af7/result.json`
- Implementation review: `/home/goat/tachyon/.tachyon/probes/probe-a170ad94-d29f-489d-bc4a-3459acaabb54/result.json`
- Fix recheck: `/home/goat/tachyon/.tachyon/probes/probe-3243c940-e9c3-4d7e-b18a-f575cce4e021/result.json`

## Dogfood log

### 2026-07-22T21:37:15Z — pass (1/1) — source: tasks.md — commit: 6b33a966030e8e1c76c6d98ed50f2db44c3c5871
- `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts` — pass

## Verification log

### 2026-07-22T21:39:00Z — pass (2/2) — source: tasks.md

- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass: 472 files, 5399 tests passed, 3 skipped
