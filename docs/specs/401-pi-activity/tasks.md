# 401 — pi-activity — tasks

_Generated from `plan.md` on 2026-07-18._

## Implementation

- [x] Add Pi to normalized runtime types and implement the pure/stateful Pi JSONL normalizer.
- [x] Map user/assistant/thinking/images/tools/results/model/effort/usage/error/interruption/compaction/custom-context records.
- [x] Add conservative file-reference/file-change correlation and direct bash-command mapping.
- [x] Register Pi in `ActivityLogWriter` and its image blob extractor.
- [x] Add real Pi transcript dogfood through the durable writer.
- [x] Update runtime and parity documentation.

## Verification

- [x] Normalizer fixtures cover every supported Pi entry/message role and malformed/unknown degradation.
- [x] Incremental tests prove pending-tool correlation, restart degradation and stable record IDs.
- [x] Writer/integration tests prove Pi selection, bounded/idempotent tailing, session boundaries and blob extraction.
- [x] Existing runtime normalizers and Pi exact-session/private-home suites remain green.
- [x] Build, engine boundary and product invariants pass; inherited baseline failures remain isolated.

**Verify:** `npx vitest run test/unit/piNormalizer.test.ts test/unit/logWriter.test.ts test/unit/activityLog.integration.test.ts test/unit/activityLogManager.test.ts test/unit/activityView.test.ts test/unit/piSession.test.ts test/unit/agentManager.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-activity.mjs`

**Human dogfood:** In the pointed Dev Host, converse with Pi, ask it to read and edit a fixture file, inspect Activity for user/assistant/thinking/tool/file/usage rows, Stop → Resume, and confirm Activity continues under the same agent without sibling leakage.

## Visual QA

- [x] Evidence: human inspection of the real Dev Host Activity panel at commit `1b51e39a`.
- [x] Verdict: approved — Pi conversation/tool/file Activity rendered correctly and remained stitched across Stop → Resume.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface; Pi uses the existing Activity view and transcript-open flow.
