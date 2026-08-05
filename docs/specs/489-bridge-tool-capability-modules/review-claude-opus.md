# SDD 489 — adversarial review

_Reviewer: `claude-spec489-review` running Claude Opus 5. Commissioned 2026-08-04 by codex at the
human maintainer's request. Review was read-only._

## Verdict

**Revise before planning.** The core direction is sound, but the first draft overstated its security
boundary and missed MCP and multi-workspace lifecycle constraints. The spec was revised after this
review; finding dispositions below refer to the current draft.

## Findings

| id | sev | claim and evidence | disposition |
|---|---|---|---|
| C1 | P0 | Zero registered tools means the current SDK never declares MCP `tools`; `tools/list` becomes `-32601`, while list-change can reject (`src/bridge/Bridge.ts:443`, SDK `server/mcp.js:56-62,650`). | Contract now requires unconditional MCP capability/handler registration, successful empty list, and contained notifications. |
| C2 | P0 | “Missing key = all” collapses valid legacy, missing file, cold invalid config, and schema skew; `Workspace.reloadConfig` can leave `config` undefined (`src/workspace/Workspace.ts:4656-4664,4943-4996`). | Spec now defines valid-legacy, explicit, and undeterminable states; cold undeterminable is empty and reload retains last-known-good. |
| C3 | P0 | A durable “human witness” is forgeable under the proposed boundary: Settings uses the control socket and a same-uid nonce that agents can read (`src/engine-service/controlPeerAuth.ts:10-33`, `controlServer.ts:129-134,382`). | Removed the unenforceable pending-witness promise; threat model now limits v1 to model-facing MCP authority and names same-uid shell/control access. |
| C4 | P1 | Pending widening conflicts with version-controlled `tachyon.yml`, branch switches, clones, and the absence of a general config watcher. | Pending-widening design removed. Valid reloaded project config is authoritative; diagnostics surface out-of-band changes. |
| C5 | P1 | Comparing `write_tachyon_config` only to disk permits raw-edit laundering (`src/bridge/tools.ts:3864-3903`, `Workspace.ts:6432-6447`). | Comparison baseline is now the last-known-good loaded selection, even when submitted text matches disk. |
| C6 | P1 | Migrating `tabTools` directly would expose 26 browser tools to legacy projects (`src/bridge/tools.ts:2556`). | Compatibility window now specifies module AND legacy gate. |
| C7 | P1 | Tool names appear in startup templates and live monitor nudges beyond one guidance composer (`src/bridge/primer.ts:190`, `src/roles/templates.ts:50,99-101`, `src/continuity/classifier.ts:95,113,122`). | Added explicit guidance registry, fail-before-green guard, and module/feature contradiction question. |
| C8 | P2 | Completeness cannot be mechanical while 113 direct calls remain in one function (`src/bridge/tools.ts:1170+`). | Requires one module-aware registration door, a static prohibition on direct calls, and per-module golden catalogs. |
| C9 | P2 | Tool signatures and sessions are global, so different multi-root catalogs would churn each other (`src/bridge/Bridge.ts:48,455-460`). | Requires per-Bridge/workspace state plus multi-root actor/trigger coverage. |
| C10 | P2 | Current YAML mutation is not rollback-atomic and session refresh is fire-and-forget (`src/workspace/Workspace.ts:6402-6421`, `src/bridge/Bridge.ts:177-184`). | Claims narrowed to pre-validation + last-known-good catalog; added call-time enforcement and runtime-specific reconnect tests. |
| C11 | P2 | Proposed grouping double-owned `continue_task`, misplaced `notify`/`run_host_action`, and conflated runtime credentials with worktrees. | Table corrected; added `runtime-security` and `host-actions`. Exact ownership remains a required golden artifact. |
| C12 | P3 | `capabilities` already means agent-profile authorization in this codebase. | Configuration renamed to `settings.bridge.toolModules`. |

## What is solid

- Registration-time filtering is the right core move; call-time checks are complementary for stale sessions.
- An explicit registry is safer than prefix inference.
- Presets remain UI sugar rather than a second authority source.
- The actor × trigger matrix correctly includes restart, resume, fork, and crash recovery.
- Non-goals preserve existing per-tool authorization and avoid per-agent/plugin scope creep.
