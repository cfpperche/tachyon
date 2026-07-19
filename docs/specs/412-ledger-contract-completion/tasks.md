# 412 — ledger-contract-completion — tasks

_Generated from `plan.md` on 2026-07-19._

## Implementation

- [x] Add a pure classifier for exactly one non-empty completion field.
- [x] Parse valid persisted contracts and retain a content-free sentinel for malformed ones.
- [x] Make startup composition reject invalid contracts without boolean fallback.
- [x] Refuse restart on the persisted sentinel before any brief or tmux mutation.
- [x] Cover deliverable, doneWhen, neither and both at contract, ledger and restart boundaries.

## Verification

- [x] Focused tests prove all four shapes and pre-mutation refusal.
- [x] Typecheck and configured full verification pass.
- [x] Duplicate-ID and shipped-spec closure audits pass.

**Headless check:** `npx vitest run test/unit/spawnContract.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts --maxWorkers=1`

**Verify:** `npx vitest run test/unit/spawnContract.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts --maxWorkers=1`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** malformed-ledger recovery is fully exercised at the real parser and tmux-manager boundary; deliberately corrupting a live user ledger adds no safer evidence.

## Visual QA

**Visual QA Opt-Out:** no visual surface changes.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface; malformed persisted contracts fail with an actionable restart diagnostic.
