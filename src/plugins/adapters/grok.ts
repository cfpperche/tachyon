/**
 * t-836be3 — the grok runtime's hook event set.
 *
 * Grok's hook config is claude-SHAPED but not claude: it is discovered from `$GROK_HOME/hooks/*.json`
 * (scope Global, "Always" trusted, no folder-trust involved), and the JSON body is the same
 * `{"hooks": {"<Event>": [{matcher?, hooks:[{type,command,timeout?}]}]}}` container claude uses. That
 * shared shape is why `buildOwnershipSettings` already serves both.
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
 */

/** Grok hook events accepted in a plugin block (guide § Hook Events). */
export const GROK_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionDenied", "Stop", "StopFailure", "Notification", "SubagentStart", "SubagentStop",
  // The guide: "`SubagentEnd` is accepted as an alias for `SubagentStop`." Accepted by the runtime, so
  // accepted here — refusing an alias the runtime honours would withhold a hook that would have run.
  "SubagentEnd",
  "PreCompact", "PostCompact", "SessionEnd",
]);
