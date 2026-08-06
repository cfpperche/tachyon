/**
 * spec 250 — the claude runtime adapter. claude's hook config lives in `.claude/settings.json` (hooks is one
 * key among others like `model`). The merge/un-merge logic is the shared hooks-map core (`./hooks.ts`); this
 * module only pins claude's known event set + that claude hook commands carry NO `statusMessage`. The old
 * function/type names are re-exported so existing importers stay stable.
 */

import { parseHooksBlock, type BlockParseResult } from "./hooks.js";
import { withResolvedMcpPluginRoot, type McpServer } from "../mcp.js";

export {
  PLUGIN_ROOT_PLACEHOLDER,
  parseOwnedHooks,
  normalizeHookSettings as normalizeClaudeSettings,
  mergeHooks as mergePluginHooks,
  removeHooks as removePluginHooks,
} from "./hooks.js";
export type {
  HookCommand,
  HookGroup,
  HooksBlock as ClaudeHooksBlock,
  OwnedHooks,
  HookSettings as ClaudeSettings,
  MergeResult,
  RemoveResult,
} from "./hooks.js";

/** Claude hook events accepted in a plugin block. Unknown keys fail closed (typo-catching). */
export const CLAUDE_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "UserPromptSubmit",
  "SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
]);

/** Parse a plugin's `claude/hooks.json` (the inner event→groups map). claude commands have no statusMessage. */
export function parseClaudeHooksBlock(rawJson: string): BlockParseResult {
  return parseHooksBlock(rawJson, { knownEvents: CLAUDE_HOOK_EVENTS, allowStatusMessage: false, label: "claude" });
}

/**
 * spec 254 Step 2 — render ONE neutral MCP server to claude's `.mcp.json` `mcpServers.<name>` value object.
 * claude takes stdio `{command,args,env}` and http `{type:"http",url,headers}` and expands `${VAR}` from the
 * server's own env for env values, so the neutral shape maps 1:1 (only empty maps/arrays are dropped). A
 * leading `${PLUGIN_ROOT}/…` in command/args is rewritten to the absolute materialized payload root (t-b6180e)
 * — the runtime does not receive the placeholder. Pure; the merge into the file (Step 3) JSON-encodes safely
 * via JSON.stringify, so no escaping is needed here.
 * @param pluginRoot absolute workspace payload root (`.tachyon/plugins/<name>`); required when the server uses `${PLUGIN_ROOT}`. */
export function renderClaudeMcpEntry(server: McpServer, pluginRoot?: string): Record<string, unknown> {
  const resolved = withResolvedMcpPluginRoot(server, pluginRoot);
  if (resolved.transport === "stdio") {
    return {
      command: resolved.command,
      ...(resolved.args.length > 0 ? { args: [...resolved.args] } : {}),
      ...(Object.keys(resolved.env).length > 0 ? { env: { ...resolved.env } } : {}),
    };
  }
  return {
    type: "http",
    url: resolved.url,
    ...(Object.keys(resolved.headers).length > 0 ? { headers: { ...resolved.headers } } : {}),
  };
}
