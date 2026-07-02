# 327 — antigravity-runtime

_Created 2026-07-02._

**Status:** shipped
**Closure:** Shipped locally 2026-07-02 — `agy`/Antigravity runtime adapter, cache resolver, Agent Studio catalog, docs/schema strings, and focused tests/typecheck/build.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Google moved the public/consumer Gemini CLI path to Antigravity CLI. Tachyon still treats `gemini`
as a first-class supported runtime and assumes its old mint/resume contract (`--session-id` /
`--resume`), while the current official CLI binary is `agy` and exposes a different session surface
(`--conversation`, `--continue`, `--prompt-interactive`, SQLite conversation storage, and shared
`~/.gemini/config` configuration).

Done means Tachyon recognizes Antigravity CLI as a supported agent runtime without breaking existing
Gemini users. `agy` should be classified as an agent, be visible in Agent Studio, receive startup
instructions through the runtime's supported initial-prompt flag, and resume the last known
conversation for the workspace when Tachyon can resolve it from Antigravity's local cache.

## Acceptance criteria

- [x] **Scenario: Antigravity is recognized as an agent runtime**
  - **Given** a Tachyon config entry with `cmd: agy`
  - **When** Tachyon parses/classifies the entry
  - **Then** the entry is treated as an agent and has a resumable runtime of `antigravity`
- [x] **Scenario: Antigravity receives startup instructions**
  - **Given** an `agy` agent with `instructions: "review this"`
  - **When** Tachyon composes the spawn command
  - **Then** the command uses Antigravity's initial interactive prompt form instead of dropping the instructions
- [x] **Scenario: Antigravity resume uses the cached workspace conversation**
  - **Given** Antigravity's local cache maps a workspace cwd to a last conversation id
  - **When** Tachyon resolves a capture id for an `antigravity` agent in that cwd
  - **Then** it returns that conversation id and builds an `agy --conversation <id>` resume command
- [x] **Scenario: Gemini remains available as a legacy runtime**
  - **Given** a config entry with `cmd: gemini`
  - **When** Tachyon parses, composes, or resumes the entry
  - **Then** existing Gemini behavior remains unchanged
- [x] Agent Studio surfaces Antigravity CLI as the preferred Google runtime and demotes Gemini CLI to a legacy entry.
- [x] Docs/comments that describe supported runtimes no longer imply Gemini CLI is the current official Google consumer path.

## Non-goals

- Antigravity isolated harness / transcript isolation. The config-home and auth model needs a separate
  pass because Antigravity shares config under `~/.gemini/config` and app state under
  `~/.gemini/antigravity-cli`.
- Antigravity Bridge MCP injection. Unlike Codex, the current `agy --help` does not expose a
  per-invocation `--mcp-config` / config override flag; a safe Bridge integration needs its own spec.
- Migrating or deleting Gemini CLI support. Google states enterprise/API-key Gemini CLI access remains
  supported for now.
- Full SQLite transcript parsing. This spec only needs the workspace-to-last-conversation cache for
  resume; activity/transcript rendering can follow later.

## Open questions

- OQ1: Does Antigravity expose a stable session metadata API beyond
  `~/.gemini/antigravity-cli/cache/last_conversations.json`? Path: use the cache for v1 and leave
  richer SQLite parsing as follow-up unless implementation proves the cache insufficient.
- OQ2: Should `gemini` stay always visible in Studio? Path: keep it visible but mark it legacy because
  enterprise users still exist; revisit after Google removes enterprise support.
