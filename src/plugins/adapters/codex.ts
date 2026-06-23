/**
 * spec 250 Step 4 — the codex runtime adapter. codex's hook config lives in `.codex/hooks.json` (the whole
 * file is the hooks container). The structure is the SAME as claude's hooks map, so the merge/un-merge logic
 * is the shared core (`./hooks.ts`); codex differs only in (a) its config file, (b) accepting a `statusMessage`
 * on a hook command, and (c) its matchers keying off codex tool names (e.g. `^apply_patch$` rather than `Edit`)
 * — but matchers are opaque strings to the engine, so that difference is the plugin author's, not Tachyon's.
 */

import { parseHooksBlock, type BlockParseResult } from "./hooks.js";

/** Codex hook events accepted in a plugin block. Verified against a live codex hook config (which uses
 *  SubagentStart/SubagentStop), so those ARE included; only `PostToolUseFailure` (a claude-only event) is
 *  excluded. Unknown keys fail closed. */
export const CODEX_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit",
  "SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
]);

/** Parse a plugin's `codex/hooks.json` (the inner event→groups map). codex commands MAY carry statusMessage. */
export function parseCodexHooksBlock(rawJson: string): BlockParseResult {
  return parseHooksBlock(rawJson, { knownEvents: CODEX_HOOK_EVENTS, allowStatusMessage: true, label: "codex" });
}
