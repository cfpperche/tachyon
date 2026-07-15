# 383 — primer-project-guidance-boundary — notes

_Created 2026-07-14. Append-only build record._

## Design decisions

- 2026-07-14 — Three read-only audits independently converged on an explicit ordered file list, source-workspace resolution, separate provenance delimiters, per-injection reads and placement before `deliverableBody()`.
- 2026-07-14 — The primer line audit found that `freshWorktree` is not a reliable freshness signal: multiple reuse/delivery/pipeline paths pass a truthy worktree without preserving `ensure().created`. The field and bootstrap claim will be removed rather than repaired in global protocol.
- 2026-07-14 — The unconditional task-id commit instruction has no corresponding `PrimerInput.taskId`, and the no-parent branch emits an invalid `<your spawner>` target. Both are removed from the applicable output instead of adding invented facts.
- 2026-07-14 — Re-anchor will use a separate `.tachyon/briefs/reanchor/` artifact. Reusing the spawn path would make a large guidance refresh destroy the agent's original durable task contract.
- 2026-07-14 — Headless dogfood uses a standalone `vite-node` scenario instead of re-running a unit-test subset, so closure proves the feature through an independent executable path.

## Deviations

- 2026-07-14 — Runtime review exposed `env` options with separate operands as a mismatch between config/runtime resolution and resume ownership detection. The implementation now aligns `binaryIndex` for those operands and pins byte-exact wrapped Codex resume plus wrapped Hermes startup delivery.
- 2026-07-14 — Security review expanded the existing long-brief path with UTF-8/shell-escaped byte accounting, complete-frame preflight, atomic temp+rename replacement, and purpose-specific spawn/re-anchor files. These are required to keep the new bounded guidance channel safe under dynamic verify/gate framing.

## Tradeoffs

- 2026-07-14 — A 64 KiB aggregate guidance limit is larger than an inline tmux payload. This is acceptable only because project content is composed before the existing 4 KB brief-file diversion; tests must pin that ordering for both startup and re-anchor.
- 2026-07-14 — Guidance resolves from the source workspace rather than a delegated worktree. Agents therefore cannot locally customize a copied policy, in exchange for immutable project ownership and consistent multi-worktree behavior.
- 2026-07-14 — This change removes repository policy from the global primer but does not redesign gated delegation's existing Vitest/`test/unit` behavior-stub generator. That remaining project assumption is outside this spec and stays actionable under dependent task `t-2b8808`; closure must describe the narrower primer/guidance boundary accurately.

## Open questions

None currently.

## Dogfood log

### 2026-07-14T23:39:56Z — pass (1/1) — source: tasks.md — commit: 768061963f67830d0e1ae1ba383d1d6e2f8ebf96
- `npm exec -- vite-node scripts/dogfood-project-guidance.mts` — pass


### 2026-07-14T23:52:54Z — pass (1/1) — source: tasks.md — commit: 768061963f67830d0e1ae1ba383d1d6e2f8ebf96
- `npm exec -- vite-node scripts/dogfood-project-guidance.mts` — pass
## Verification log

### 2026-07-14T23:40:21Z — pass (3/3) — source: tasks.md
- `npm exec -- vitest run test/unit/projectGuidance.test.ts test/unit/primer.test.ts test/unit/ocPrimerShapeBehavior.gen.test.ts test/unit/briefFile.test.ts test/unit/agentManager.test.ts test/unit/workspaceHeadless.test.ts test/unit/config.test.ts test/unit/configSchema.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

### 2026-07-14T23:53:20Z — pass (3/3) — source: tasks.md
- `npm exec -- vitest run test/unit/projectGuidance.test.ts test/unit/primer.test.ts test/unit/ocPrimerShapeBehavior.gen.test.ts test/unit/briefFile.test.ts test/unit/cxBriefBehavior.gen.test.ts test/unit/agentManager.test.ts test/unit/workspaceHeadless.test.ts test/unit/resume.test.ts test/unit/config.test.ts test/unit/configSchema.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
