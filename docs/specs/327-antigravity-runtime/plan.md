# 327 — antigravity-runtime — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add Antigravity as a new runtime id (`antigravity`) backed by the `agy` binary, while leaving the
existing `gemini` adapter intact. The core runtime adapter should be capture-based: Tachyon does not
mint an Antigravity session id, and resume uses `agy --conversation <id>` when a cached id exists or
`agy --continue` as the no-id workspace fallback.

Teach config classification and command composition that `agy` is an AI CLI and that startup
instructions are delivered with `--prompt-interactive <prompt>`. Add a resolver that reads
`~/.gemini/antigravity-cli/cache/last_conversations.json` and returns the cwd's cached conversation
id when present. This matches the current CLI's local state shape without parsing full conversation
SQLite databases.

Update Agent Studio's quick-add catalog so Antigravity is the preferred Google CLI entry, with the
official curl installer hint. Keep Gemini present as a legacy Google runtime because Google's
transition announcement preserves enterprise/API-key Gemini CLI access.

## Key decisions

- **New runtime id instead of aliasing `gemini`** — Antigravity has a different binary, state layout,
  and resume contract. Reusing `gemini` would make the adapter lie about `--session-id` support.
- **Capture/continue adapter** — `agy --help` exposes `--conversation` and `--continue`, not
  `--session-id`; minting is not available.
- **Cache-based resolver for v1** — `last_conversations.json` directly maps cwd to the last
  conversation id. Parsing SQLite adds risk and is not required to resume the latest workspace
  conversation.
- **No Bridge MCP injection in this spec** — Antigravity currently lacks a per-invocation MCP config
  flag in `agy --help`; writing shared global config from every spawn would be security-significant.
- **Keep Gemini legacy support** — Google's consumer path moved to Antigravity, but enterprise access
  remains supported per the official announcement.

## Files touched

- `src/resume/adapters.ts` — add `antigravity` runtime detection and resume command shape.
- `src/resume/resolvers.ts` — add Antigravity last-conversation cache resolver.
- `src/config/loadConfig.ts` — classify `agy` as an AI CLI and deliver startup instructions.
- `src/webview/formLogic.ts` — Agent Studio catalog and flag suggestions.
- `src/activity/types.ts` / pipeline runtime helpers if needed — keep runtime labels exhaustive.
- `test/unit/resume.test.ts`, `test/unit/config.test.ts`, `test/unit/agentStudio.test.ts` — cover
  detection, command composition, resolver, and UI catalog behavior.
- `l10n/*` if user-facing strings change.

## Risks & unknowns

- Antigravity's cache format is young and has changed quickly since 1.0.0. The resolver must fail
  closed to null if the JSON shape changes.
- `agy --conversation <id>` may be accepted but still depend on project context. Use the original cwd
  on spawn/resume as Tachyon already does.
- `--prompt-interactive` is the closest startup-instructions analog; it starts an interactive session
  with an initial prompt, but this should be dogfooded manually with a real TUI before claiming deeper
  parity.
- Studio copy/install hints are visible UI. Keep text compact and avoid layout churn.

## Visual impact

Agent Studio's quick-add runtime chips change: Antigravity appears as the preferred Google CLI and
Gemini is labeled legacy. Visual risk is low and text-only; unit coverage is enough for this pass.
**Visual QA Opt-Out:** no rendered webview layout or styling changes beyond catalog labels/strings.

## Sources consulted

- Google Developers Blog, "An important update: Transitioning Gemini CLI to Antigravity CLI",
  2026-05-19.
- `github.com/google-antigravity/antigravity-cli` README and changelog through 1.0.15.
- Local `agy --help` / `agy --version` (`1.0.10`) confirming flags.
- Local Antigravity state under `~/.gemini/antigravity-cli/`.
- Existing Tachyon runtime code: `src/resume/adapters.ts`, `src/resume/resolvers.ts`,
  `src/config/loadConfig.ts`, `src/webview/formLogic.ts`, and resume/config tests.
