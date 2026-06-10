# 188 — tachyon-attention-detection — tasks

_Generated from `plan.md` on 2026-06-09. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. patterns.ts: library + classifyTail (last 8 non-empty lines); unit tests incl. real Claude Code trust-prompt fixture
- [x] 2. config: `attention` field (bool | {silenceSec>=1, patterns[]}), default enabled iff no watch globs; schema.json + loadConfig + unit tests
- [x] 3. TmuxService.panePid + cpuTicks helper (/proc + one child level, null off-Linux); unit test arg shapes
- [x] 4. AttentionMonitor state machine with injected IO; unit tests: all transitions, episode semantics, CPU suppression, disabled agents skipped
- [x] 5. Sidebar: 3-state icons + descriptions; createTreeView + ViewBadge (needs-input count)
- [x] 6. extension.ts: 3s ticker lifecycle, toast once/episode with Open action, `tachyon._attention` internal command; Bridge list_agents carries state
- [x] 7. Integration test: real sh agent prints `[y/n]` prompt -> needs-input within 30s via _attention command
- [x] 8. Docs: README attention section + examples/tachyon.yml

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 188 acceptance scenarios pass (unit + integration evidence noted)
- [x] Full suite green: typecheck, build, vitest, xvfb integration; umbrella F1 row flipped to implemented

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
