# 364 — bridge-client-rebind — tasks

_Generated from `plan.md` on 2026-07-09. Work top-to-bottom. Check boxes as tasks complete._

## Implementation

- [x] Extend `SessionRecord` (+ normalize) with optional durable
      `bridgeClient?: { boundGeneration: number; wired: boolean }` in `SessionLedger.ts`; unit
      roundtrip for missing/present.
- [x] Add `src/bridge/clientRebind.ts`: generation get/bump (host state key
      `workspaceHash+bridgeInstanceId`), reconstruct suspects from ledger+running, queue with
      `maxConcurrentRebinds`, preflight, stop→wait dead→hard kill→resume orchestration hooks
      (injected deps — no vscode imports), audit JSONL append, circuitFailCount=3, graceMs default 0.
- [x] Export from `src/bridge/index.ts` (or appropriate public path) if the package has an index.
      _(N/A — no bridge index; import `src/bridge/clientRebind.ts` directly, same as other bridge modules.)_
- [x] Wire `AgentManager`: on successful spawn/resume when `withRuntimeBridge` applied
      materialization, stamp ledger `bridgeClient: { wired: true, boundGeneration }`. Inject
      `getBridgeGeneration` / stamp helper from Workspace.
- [x] Wire `Workspace` after Bridge `start` + `recoverPendingHostActionReload`: bump generation once
      per ready transition; run coordinator mark+auto queue; use `expectedDeath` before rebind stop;
      `deliverNotice` for reload initiator if known.
- [x] Optional: record last `run_host_action` reload caller name for initiator notice (best-effort).
- [x] Parse `settings.bridgeClientRebind` in `loadConfig.ts` with spec defaults when absent.
- [x] Unit tests `test/unit/bridgeClientRebind.test.ts` (and ledger): durable stamp; absent bound=0;
      reconstruct after “reload” (new coordinator instance + same host state + ledger); preflight user
      stop / manual heal; double-bump pending_recheck + stamp current gen; queue serial; circuit;
      skip non-wired; expectedDeath not required in pure unit if mocked.
- [x] Keep `npm test` green for touched suites; `npm run typecheck` green for main project.

## Verification

- [x] Spec Phase 1 scenarios covered by unit tests or explicit documented deferrals in notes for
      live-only items (Grok MCP hang).
- [x] No cold-spawn path in coordinator.
- [x] No peer rebind tool shipped.

**Verify:** `npx vitest run test/unit/bridgeClientRebind.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `npx vitest run test/unit/bridgeClientRebind.test.ts`

**Human dogfood:** VSIX 0.55.82 — reload with wired agents → rebind audit `resume_ok` (claude/codex/reviewer/grok);
native Bridge tools healthy without manual stop/resume; initiator notice delivered. **PASS 2026-07-09.**

## Visual QA

**Visual QA Opt-Out:** no new UI surface; optional notify only.
