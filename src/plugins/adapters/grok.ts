/**
 * t-836be3 / t-2f99e7 — the grok runtime adapter.
 *
 * Grok's hook config is claude-SHAPED but not claude: it is discovered from a DIRECTORY of JSON files
 * (`$GROK_HOME/hooks/*.json` Global / always trusted, and `<project>/.grok/hooks/*.json` Project /
 * requires folder-trust), and each file's JSON body is the same
 * `{"hooks": {"<Event>": [{matcher?, hooks:[{type,command,timeout?}]}]}}` container claude uses. That
 * shared shape is why `buildOwnershipSettings` already serves both, and why the install engine can
 * write a single merge file (`.grok/hooks/tachyon-plugins.json`) into the project hooks directory.
 *
 * The PreToolUse envelope is NOT claude's: Grok sends camelCase (`toolInput.command`); Claude sends
 * snake_case (`tool_input.command`). A plugin's grok block must therefore ship its own gate script —
 * deriving groups from the claude block installs a hook that claims to refuse and exits 0 on a real
 * Grok payload (measured; pinned in secretsGuardLayer2Projection.test.ts).
 *
 * The event list below is TRANSCRIBED from the "Hook Events" table of the INSTALLED guide,
 * `~/.grok/docs/user-guide/10-hooks.md` (transcribed at grok 0.2.114, re-read unchanged at 0.2.118) — a
 * versioned file that ships with the runtime, never memory about Grok. Two entries have no claude/codex counterpart
 * (`PermissionDenied`, `StopFailure`), and `PostToolUseFailure` — which codex lacks — is present here,
 * so this set is genuinely grok's rather than a copy of a neighbour's.
 *
 * Unknown keys fail closed upstream (`planProjectedPluginHooks` withholds with a reason), which is the
 * point of pinning the set at all: Grok itself "skips unrecognized event names so a shared Claude or
 * Cursor settings file still loads", so a typo would be silently inert there and never reported.
 *
 * Install-path layout (guide-measured, t-2f99e7):
 *  - settingsRel: `.grok/hooks/tachyon-plugins.json` — one file in the project hooks dir (Grok merges
 *    every `*.json` there). Project hooks are silently skipped until `/hooks-trust`; per-spawn
 *    projection (t-836be3) copies gate groups into the private `$GROK_HOME/hooks/`, which is always
 *    trusted, so the install still matters as the lockfile source even when the project is untrusted.
 *  - skillsRel: `.grok/skills` (guide § Skill Locations).
 *  - mcpRel: deferred (null). Grok MCP lives in `.grok/config.toml` under `[mcp_servers.<name>]` with
 *    `env` / `headers` maps — not codex's `env_vars` / `bearer_token_env_var`. Wiring the codex codec
 *    would install a shape Grok does not load.
 */

import { parseHooksBlock, type BlockParseResult } from "./hooks.js";

/** Grok hook events accepted in a plugin block (guide § Hook Events). */
export const GROK_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionDenied", "Stop", "StopFailure", "Notification", "SubagentStart", "SubagentStop",
  // The guide: "`SubagentEnd` is accepted as an alias for `SubagentStop`." Accepted by the runtime, so
  // accepted here — refusing an alias the runtime honours would withhold a hook that would have run.
  "SubagentEnd",
  "PreCompact", "PostCompact", "SessionEnd",
]);

/** Parse a plugin's `grok/hooks.json` (the inner event→groups map). Grok commands have no statusMessage. */
export function parseGrokHooksBlock(rawJson: string): BlockParseResult {
  return parseHooksBlock(rawJson, { knownEvents: GROK_HOOK_EVENTS, allowStatusMessage: false, label: "grok" });
}
