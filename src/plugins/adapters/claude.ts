/**
 * spec 250 — the claude runtime adapter. claude's hook config lives in `.claude/settings.json` (hooks is one
 * key among others like `model`). The merge/un-merge logic is the shared hooks-map core (`./hooks.ts`); this
 * module only pins claude's known event set + that claude hook commands carry NO `statusMessage`. The old
 * function/type names are re-exported so existing importers stay stable.
 */

import { parseHooksBlock, type BlockParseResult } from "./hooks.js";

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
