# 402 — pi-activity

_Created 2026-07-18._

**Status:** shipped

**Closure:** Stateful Pi transcript normalization and bounded Activity integration shipped in `647b60b9`; dogfood closure landed in `f67a5400` with human Activity-panel approval at `1b51e39a`.
**Verify:** `npx vitest run test/unit/piNormalizer.test.ts test/unit/logWriter.test.ts test/unit/activityLog.integration.test.ts test/unit/activityLogManager.test.ts test/unit/activityView.test.ts test/unit/piSession.test.ts test/unit/agentManager.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`
**Dogfood:** `node scripts/dogfood/pi-activity.mjs`

## Intent

Pi now has an exact, private per-agent JSONL transcript, but Tachyon's Activity pipeline treats runtime `pi` as unknown and drops every appended record. The cockpit therefore cannot show Pi's conversation, thinking, tools, file effects, usage, model changes, compaction or errors even though Pi persists structured native events for each of them.

Add a pure, stateful Pi transcript normalizer and wire it into the existing bounded, durable `ActivityLogWriter`. Activity must tail only the exact transcript already attributed by SDD 400/401, preserve source provenance and runtime semantics, avoid rendering the Tachyon primer as a human turn, correlate tool results without inventing success, and degrade safely on malformed or unknown Pi entries.

## Acceptance criteria

- [x] **Scenario: conversation and injected context are classified honestly**
  - **Given** Pi user, assistant, custom-context and Tachyon-primer records
  - **When** the exact transcript is normalized
  - **Then** human text becomes chat activity, assistant text/thinking become their native events, and injected primer/custom context never appears as a human message
- [x] **Scenario: tool lifecycle and file effects are correlated**
  - **Given** assistant tool calls followed by successful or failed Pi tool-result records
  - **When** Activity ingests them incrementally
  - **Then** it emits tool started/completed/failed with stable IDs and emits file changed only after a successful mutating tool result
- [x] **Scenario: model, effort and usage are observable**
  - **Given** model/thinking-level changes and assistant usage records
  - **When** they are normalized
  - **Then** subsequent events carry the observed model/effort and usage events carry input/output/cache token counts without fabricating unavailable values
- [x] **Scenario: compaction, branching, interruption and errors remain visible**
  - **Given** Pi compaction/branch summaries, interrupted turns and assistant errors
  - **When** Activity ingests them
  - **Then** the normalized stream uses the existing boundary/summary/interruption/error vocabulary
- [x] **Scenario: image bytes use the existing side channel**
  - **Given** Pi user, assistant or tool-result image blocks
  - **When** the durable writer ingests them
  - **Then** lightweight `image.attached` events enter the log and base64 bytes are copied to the Activity blob store rather than embedded in durable JSONL events
- [x] **Scenario: exact private transcript is the only Activity source**
  - **Given** two same-cwd Pi agents with distinct private homes
  - **When** the always-on Activity manager resolves and polls them
  - **Then** each writer consumes only its ledger-attributed session file and never guesses from the sibling directory
- [x] **Scenario: malformed and unknown records degrade safely**
  - **Given** blank, partial, malformed, unknown, custom-state or unsupported Pi entries
  - **When** they are tailed
  - **Then** no exception or raw-log bloat occurs and the line-aligned cursor remains retry-safe
- [x] Pi is part of the normalized runtime type and `ActivityLogWriter` selects the Pi normalizer on first poll, restart rehydration and session rotation.
- [x] Runtime parity documentation marks Pi Activity `✓` only after normalizer, writer integration, real-transcript dogfood and human Activity-view confirmation pass.

## Non-goals

- Parsing arbitrary sibling/newest Pi transcripts; SDD 400/401 exact attribution remains authoritative.
- Reconstructing Pi's current active tree branch by deleting or hiding already-appended Activity history. Activity reflects durable append chronology; tree navigation remains a future UI concern.
- Pi fork controls, permission injection, composer/attention measurement, graceful-stop measurement, hooks or configurable Pi harness resources.
- Adding cost fields to the normalized vocabulary. Pi cost remains available in `raw`; this phase maps only the token fields the existing `usage.updated` contract supports.
- Streaming deltas or permission prompts not persisted as stable session entries.

## Open questions

- None. Pi's v3 session format and shipped TypeScript definitions provide stable entry IDs, timestamps, roles, tool calls/results, model, thinking level, usage and compaction records. The existing line-tail writer already supplies bounded backfill, exact-session boundaries, offsets, idempotency and blob storage.
