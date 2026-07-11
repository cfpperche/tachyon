# SDD 368 T8 adversarial review R1 — FINDINGS

Reviewed immutable range `57cd9f1..ca6a48a` on `tachyon/deliveryLeaseT8` against the binding T8 contract in `docs/specs/368-delivery-worktree-leases/notes.md`.

## Findings

### P1 — Unbounded and uncancelled Bridge waiters can continue polling SQLite after their callers abandon them

Evidence: every `wait_for_lease` call directly creates a new independent watcher and awaits it (`src/bridge/tools.ts:2316-2337`). The handler ignores the MCP callback's `RequestHandlerExtra.signal`, even though the installed SDK defines that signal specifically for sender cancellation. The watcher has no abort seam and polls once per 100 ms for up to 300,000 ms (`src/delivery/leaseService.ts:43-55`, `75-95`). Each poll calls `DeliveryStore.get`, whose read path opens a new synchronous SQLite connection, executes PRAGMAs/schema/migration checks, and closes it (`src/delivery/store.ts:304-337`). There is no per-Bridge/per-Delivery coalescing or concurrency cap analogous to the existing bounded gate on `wait_for_output` (`src/bridge/tools.ts:2443-2455`).

Thus cancelled/abandoned calls can keep issuing synchronous database work for five minutes after no caller can consume their result, and concurrent calls multiply that work linearly (ten reads/second/waiter). An authenticated client can accumulate enough waiters to monopolize the extension-host event loop and contend with the Delivery writes the watcher is intended to observe. The watcher holds no SQLite lock across sleeps, but that alone does not satisfy the control-plane starvation boundary under multi-waiter or abandoned-request load.

Required correction: thread the MCP request abort signal through the optional Bridge dependency into the watcher, make sleep abortable with listener/timer cleanup, and stop before another store read once cancelled. Add a bounded concurrency/coalescing policy so same-Delivery or global waiter fan-out cannot generate unbounded SQLite polling. Add deterministic Bridge tests proving cancellation ends reads/timers and a multi-waiter test proving the database polling rate is bounded.

## Confirmed behavior

- Production deadlines use `performance.now()` and each sleep is capped to the remaining monotonic deadline (`src/delivery/leaseService.ts:50-65`, `92-95`).
- Store-busy observations retry within the original deadline; non-busy failures surface (`src/delivery/leaseService.ts:75-95`).
- Version baselines detect occupied-to-occupied release/reacquire changes, preventing a lost wakeup (`src/delivery/leaseService.ts:66-87`).
- Results contain only the public Delivery id, outcome, wait duration, version, and lease state; Bridge input bounds and optional-dependency failure are visible (`src/delivery/leaseService.ts:23-35`, `68-85`; `src/bridge/tools.ts:2316-2337`).
- The implementation stays within the expanded T8 owned-file scope.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts test/unit/bridge.test.ts test/unit/auth.test.ts --maxWorkers=1` — PASS (4 files, 105 tests).
- `npm run typecheck` — PASS.
- `npm run verify:full` — PASS (299 files, 3324 passed, 3 skipped).
- `git diff --check 57cd9f1..ca6a48a` — PASS.
- Review remained read-only for production and tests.

## Verdict

FINDINGS
