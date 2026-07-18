# 401 — pi-activity — notes

## Decisions and measurements

- Pi session format v3 is structured JSONL with stable per-entry IDs and ISO timestamps. Message roles expose user, assistant, toolResult, bashExecution, custom, branchSummary and compactionSummary; assistant blocks expose text, thinking, image and toolCall plus model/usage/stopReason.
- Pi sessions are trees in one file. Activity intentionally records append chronology; projecting only the current leaf would rewrite durable history and is outside this phase.
- SDD 399/400 already makes `AgentManager.transcriptPathOf` return the exact Pi file and session ID from the private home. No Activity-specific directory scan was added.
- `piNormalizer` uses the entry ID as record provenance, latches model/thinking level, and keeps pending tool name/write-path state. An orphan result after host restart still renders completion/failure but never invents a name or file mutation.
- Tachyon primer and custom context are classified as injected context, not human chat. Unknown/custom-state/label entries are dropped with no raw durable-log bloat.
- Pi image blocks expose base64 directly as `data`; the existing blob extractor was extended for that shape. Durable normalized records continue stripping `raw`.

## Automated evidence

- Focused Activity/Pi suite: 447 tests passed.
- Real Pi RPC dogfood produced a native private JSONL using a deterministic local provider; the real `ActivityLogWriter` normalized four durable events with exact Pi provenance, including user/assistant/usage.
- Build passed; engine boundary passed with a 250-file vscode-free daemon closure; product invariants passed.
- Full suite: 4,873 passed, 3 skipped, with only the two inherited baseline failures from SDD 398–400:
  - generated `grokauthfixBehavior` invokes the pre-existing failing typecheck (`verifyFullLock.test.ts` declaration gap);
  - `verifyFullQuiet.test.ts` expects the pre-`t-6a9bc4` `verify:full` package script.
- Direct typecheck reports only the inherited `verifyFullLock.test.ts` declaration defect.

## Review notes

- Multiple events from one Pi source line are appended atomically as one durable record, preserving ActivityLog idempotency.
- File effects are conservative: read references appear at call time; write/edit effects appear only after a successful correlated `toolResult`.
- Model/cost raw data is not copied into the durable log. Existing normalized token fields are mapped; cost schema remains a separate observability decision.

## Verification log

### 2026-07-18T16:19:43Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/piNormalizer.test.ts test/unit/logWriter.test.ts test/unit/activityLog.integration.test.ts test/unit/activityLogManager.test.ts test/unit/activityView.test.ts test/unit/piSession.test.ts test/unit/agentManager.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — pass

## Dogfood log

### 2026-07-18T16:19:49Z — pass (1/1) — source: tasks.md — commit: d0639179a7919623d44b941e60d082db9fbf18bc
- `node scripts/dogfood/pi-activity.mjs` — pass
