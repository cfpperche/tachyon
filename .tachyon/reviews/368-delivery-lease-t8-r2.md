# SDD 368 T8 adversarial review R2 — ACCEPT

Reviewed immutable fix range `fa4e6d0..cd18ee1` on `tachyon/deliveryLeaseT8` against R1 (`e0f19ef`) and the binding T8 R1 correction contract in `docs/specs/368-delivery-worktree-leases/notes.md`.

## Review result

No actionable findings.

- The MCP callback accepts the SDK `extra` argument and forwards its exact `AbortSignal` through the optional Bridge dependency and Workspace into the canonical watcher (`src/bridge/tools.ts:2344-2372`; `src/workspace/Workspace.ts:999`; `src/delivery/leaseService.ts:69-78`).
- The watcher checks cancellation before and after every `store.get` and before sleeping, so an abort cannot initiate another read or return a stale terminal classification (`src/delivery/leaseService.ts:98-121`).
- Production sleep owns one timer and one abort listener. Its settled guard makes cleanup exact-once; both normal and abort settlement clear the timer/listener, and the post-registration aborted check closes the precheck-to-listener race (`src/delivery/leaseService.ts:46-65`).
- The non-queuing gate is stored in the contract-specified `WeakMap<AgentManager, DeliveryLeaseWaitGate>`, isolating workspace lifetimes while sharing state across stateless per-request tool registrations. It enforces max four workspace waits and max one per Delivery before invoking the dependency (`src/bridge/tools.ts:555-580`, `2354-2368`).
- The slot acquired for the exact `delivery_id` is released by the nested `finally` on success, error, timeout, or abort. Refused calls acquire nothing and do not enter the release path (`src/bridge/tools.ts:2357-2368`).
- Regression tests truthfully cover the sleep registration race, exact timer/listener cleanup, no post-abort reads, real MCP signal forwarding and slot reuse, duplicate refusal, fifth-fanout refusal, and reuse after all four holders settle (`test/unit/deliveryLeaseService.test.ts:165-222`; `test/unit/bridge.test.ts:321-370`).
- The fix remains within the correction contract's owned implementation and test files and does not alter Delivery state, schema, fencing, or existing wait-tool behavior.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts test/unit/bridge.test.ts test/unit/auth.test.ts --maxWorkers=1` — PASS (4 files, 110 tests).
- `npm run typecheck` — PASS.
- `npm run verify:full` — PASS (299 files, 3329 passed, 3 skipped).
- `git diff --check fa4e6d0..cd18ee1` — PASS.
- Review remained read-only for production and tests.

## Verdict

ACCEPT
