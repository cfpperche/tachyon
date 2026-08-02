# Audit: MCP Roots / Sampling / Logging dependency (t-333574)

**Date:** 2026-08-02  
**Agent:** mcpdeprec  
**Source study:** t-b3ddcd → `docs/research/mcp-2026-07-28-tachyon-opportunities.md`  
**Spec:** MCP 2026-07-28, SEP-2577 — Roots, Sampling, Logging deprecated with minimum 12-month window  

**Question:** Does the Tachyon Bridge, any runtime MCP client we own, or any MCP server config the product materializes depend on Roots, Sampling, or Logging?

**Answer:** **No.** Separate verdicts below. No removal plan required inside the window.

---

## Method

1. Protocol-symbol search across product MCP surfaces (Bridge server, Pi MCP client, harness materializers, registration adapters, plugin MCP payload, dogfood MCP fixtures).
2. Filter name-only noise: filesystem temp `roots[]`, CPU/resource “sampling”, agent profile `capabilities`, and `tools/list_changed` (Tools feature, not Roots).
3. Confirm SDK defaults for `@modelcontextprotocol/sdk` (lockfile: 1.29.0).

### SDK baseline (relevant defaults)

- Server: `this._capabilities = options?.capabilities ?? {}` unless `registerCapabilities` is called.
- `McpServer.registerTool` registers **tools** with `listChanged: true` only — not logging/roots/sampling.
- `sendLoggingMessage` is a no-op unless `server.capabilities.logging` is set.
- Client: `listRoots` / `createMessage` / `setLoggingLevel` exist but require explicit capability registration; product clients never pass those capabilities.

---

## Roots — NO DEPENDENCY

**Verdict:** Product does not implement, advertise, request, or consume MCP Roots (`roots/list`, `notifications/roots/list_changed`, `ClientCapabilities.roots`).

**Where looked:**

| Surface | Finding |
|---|---|
| `src/bridge/Bridge.ts` | `createMcp`: `new McpServer({ name, version })`; only `registerTools`. No `listRoots()`. `announceToolListChanged` → `mcp.sendToolListChanged()` = **Tools** list change, not Roots. |
| `src/bridge/tools.ts` | `registerTool` only; no roots request/notification handlers. |
| `src/pi-bridge-extension/index.ts` | `new Client({ name, version })` with default empty capabilities; uses `listTools`, `callTool`, `ToolListChangedNotificationSchema` only. |
| `src/harness/HarnessManager.ts` | `buildMcpConfig`, `build*HarnessConfig`, `materializeBridgeMcp*` write transport entries (`url` / `headers` / `command` / `env`). No roots protocol fields. |
| `src/registration/adapters.ts` | `expected*Entry` / `set*McpServer` — same transport shape. |
| `src/plugins/mcp.ts` + `src/plugins/adapters/*` | Neutral stdio/http payload; no roots fields. |

**Zero product matches for:** `roots/list`, `ListRoots`, `listRoots`, `notifications/roots`, `roots.listChanged`.

**Name-only noise (not dependency):** research doc calling for this audit; test helpers named `roots` for temp dirs; multi-root workspace prose.

---

## Sampling — NO DEPENDENCY

**Verdict:** Product does not implement, advertise, request, or consume MCP Sampling (`sampling/createMessage`, `ClientCapabilities.sampling`).

**Where looked:** same Bridge / Pi client / harness / plugin surfaces as Roots.

**Zero product matches for:** `sampling/createMessage`, `CreateMessage` / `createMessage` as MCP API, `ClientCapabilities.sampling`.

**Name-only noise:** research doc; `src/runtimeOps/*` “resource sampling” (RSS/CPU, t-e3bae0); SDD prose about statistical/frame sampling.

---

## Logging — NO DEPENDENCY

**Verdict:** Product does not implement, advertise, request, or consume MCP Logging (`logging/setLevel`, `notifications/message` / `LoggingMessageNotification`, `ServerCapabilities.logging`).

**Where looked:**

- Bridge never calls `registerCapabilities({ logging })` and never calls `sendLoggingMessage`.
- Pi client never calls `setLoggingLevel` / logging notifications.
- Materializers do not declare logging capability or protocol log fields.

**Zero product matches for:** `logging/setLevel`, MCP `setLevel`, `sendLoggingMessage`, `LoggingMessageNotification`, MCP `notifications/message`.

**Name-only noise:** research doc; ordinary `logWriter` / stderr / “MCP-startup logs” prose in specs (process logs, not MCP Logging).

---

## Surfaces swept (reproducible checklist)

1. **Bridge server:** `src/bridge/Bridge.ts`, `src/bridge/tools.ts` (auth helpers are token/caller only).
2. **Product MCP client:** `src/pi-bridge-extension/index.ts` (+ `toolProjection`).
3. **Runtime MCP materialize:** `HarnessManager` (`buildMcpConfig`, `buildCodexHarnessConfig`, `buildGrokHarnessConfig`, `buildHermesHarnessConfig`, `buildOpencodeHarnessConfig`, `materializeBridgeMcp{,Opencode,Grok,Hermes}`); `registration/adapters.ts`; `plugins/mcp.ts` + adapters; `Workspace` bridgeEntry wiring.
4. **SDK import sites:** Bridge + tools + pi-bridge-extension; tests/dogfood use Client against Bridge only (no roots/sampling/logging APIs).
5. **Protocol strings + SDK API names** across `src/`, `test/`, `scripts/` (docs excluded as noise).

---

## Overall

| Feature | Depend? | Action |
|---|---|---|
| Roots | No | None |
| Sampling | No | None |
| Logging | No | None |

No removal plan is required inside the 12-month window. Continue not adopting these features. Re-check if a future path starts calling `listRoots` / `createMessage` / `sendLoggingMessage` or advertising those capabilities on Bridge or a client.

**Note:** `tools/list_changed` is actively used (`Bridge.announceToolListChanged` / Pi refresh). That is the **Tools** lifecycle notification, not deprecated Roots `notifications/roots/list_changed`.

**Tree:** measurement-only on worktree branch `tachyon/tmp.mcpdeprec.20260802-135629-e097`. No product code change required for the audit verdict (artifact + task journal only).
