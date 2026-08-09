# 321 — plugin-hook-absolute-root

_Created 2026-07-01._

**Status:** shipped

**Closure:** Shipped 2026-07-01. Plugin hook commands referencing `${TACHYON_PLUGIN_ROOT}` now render with the ABSOLUTE materialized root plus a cwd-independence wrapper (`src/plugins/adapters/hooks.ts` `wrapResolved` + `FAIL_CLOSED_HOOK_EVENTS`; `isSafeAbsolutePluginRoot` in `paths.ts`; `engine.ts` passes `path.join(workspaceRoot, rootRel)`): a gate hook (PreToolUse) with a missing root or an exit-127 command now BLOCKS (exit 2, clear stderr) instead of silently passing; observational hooks skip clean (exit 0). Design settled beforehand by the live claude×codex debate on pin `p-763d4b` (baked-absolute over git-root/env-var resolution; fail-closed scoped to gates; per-hook failurePolicy deferred to v2). Validation: adapter/engine suites updated + 7 new cases including behavioral `sh -c` execution of the rendered wrapper (block-on-missing-root, 127→2 remap, rc passthrough, fail-open skip); full suite 141 files/1958 tests green; tsc main+webview clean; `/sdd verify` + dogfood logged in `notes.md`. Human dogfood (re-apply secrets-guard in this workspace, then `cd` + Bash to confirm the guard no longer disarms) left as the maintainer's follow-up — live settings keep the old relative command until re-apply (spec non-goal).

**Verify:** `env -u TMUX npx vitest run test/unit/pluginClaudeAdapter.test.ts test/unit/pluginCodexAdapter.test.ts test/unit/pluginEngine.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Dogfood:** `env -u TMUX npx vitest run test/unit/pluginEngine.test.ts -t "hook"`

## Intent

_Origin: pin `p-763d4b` — found live in the maintainer's own session; design settled by a live claude×codex debate (2 rounds, both sides probing empirically; the debate record lives in the pin + handoff note and substitutes the usual design dueto)._

Plugin hook commands are materialized with a **relative** plugin root: `${TACHYON_PLUGIN_ROOT}` is textually replaced with `.tachyon/plugins/<name>/<rt>` (`src/plugins/adapters/hooks.ts` `resolveCommand`, called from `mergeHooks` with `plugin.rootRel[rt]` at `engine.ts:899`). Runtimes execute hook commands via `sh -c` against a cwd Tachyon does not control: on Claude, the persistent Bash shell's cwd (a single `cd` out of the repo root made secrets-guard fail exit 127 **non-blocking** — the gitleaks gate silently stopped guarding; 3 live occurrences captured). On Codex, the session cwd (codex doesn't persist `cd` between calls and blocks loud on hook failure, but a session born in the wrong cwd still breaks). Both runtimes' hook-config files are machine-local (gitignored), so the relative path buys no real portability.

"Done" means: hook commands that reference the plugin root are rendered with the **absolute** workspace-rooted plugin path baked at materialization, wrapped so that a **gate** event's hook (PreToolUse) whose root is missing or whose command can't be found **blocks with a clear error (exit 2)** instead of silently passing, and an **observational** event's hook (SessionStart/Stop/PostToolUse/…) whose root is missing **skips cleanly (exit 0)** with a stderr note instead of bricking the session.

## Acceptance criteria

- [x] **Scenario: a placeholder-using hook command is rendered with the absolute plugin root**
  - **Given** a plugin hooks block whose command contains `${TACHYON_PLUGIN_ROOT}` and a workspace at an absolute root
  - **When** the install is previewed/applied
  - **Then** the written command embeds the absolute plugin path (never a bare `.tachyon/...` relative path), so its resolution no longer depends on the executing shell's cwd
- [x] **Scenario: a gate hook fails closed when the plugin root is gone**
  - **Given** a rendered PreToolUse hook whose baked plugin root does not exist on disk (plugin removed/moved)
  - **When** the wrapper runs
  - **Then** it prints a clear `[tachyon]` error to stderr and exits 2 (blocking) — never a silent pass
- [x] **Scenario: a gate hook maps "command not found" to a block**
  - **Given** a rendered PreToolUse hook whose root exists but whose inner command exits 127
  - **When** the wrapper runs
  - **Then** it exits 2 with a clear stderr message (Claude treats 127 as non-blocking; the wrapper converts that silent-pass into a block)
- [x] **Scenario: an observational hook fails open**
  - **Given** a rendered SessionStart (or Stop/PostToolUse/…) hook whose baked plugin root does not exist
  - **When** the wrapper runs
  - **Then** it prints a stderr note and exits 0 — a missing non-gate plugin never bricks the session
- [x] **Scenario: a placeholder-free hook command is left untouched**
  - **Given** a hook command that does not reference `${TACHYON_PLUGIN_ROOT}`
  - **When** the install is previewed
  - **Then** the command is written verbatim (no wrapper) — it has no root dependency to protect
- [x] **Scenario: an unsafe absolute root fails closed at install time**
  - **Given** a workspace whose absolute path contains whitespace or shell metacharacters
  - **When** hooks are merged
  - **Then** the merge fails with a clear error (no silently-broken quoting is ever written)
- [x] Gate-vs-observational classification is a single exported set (`PreToolUse` only in v1); the wrapper honors the hook's own exit code (an inner exit 2 from e.g. gitleaks still blocks; only 127 is remapped).
- [x] Idempotency/uninstall survive the change: re-apply with prior owned groups stays idempotent, and uninstall of an OLD (relative-path) install still removes its groups (content-based removal replays the lockfile's recorded commands).
- [x] Existing behavior for codex `statusMessage`, user-group preservation, and orphan conservation is unchanged (adapter suites pass with only rendering expectations updated).

## Non-goals

- No per-hook `failurePolicy: "closed" | "open"` metadata in the plugin schema — deferred to v2 (debate consensus); v1 classifies by event.
- No `git rev-parse` fallback and no `$CLAUDE_PROJECT_DIR` primary (debate: both resolve the WRONG root when the agent sits in a foreign repo/cwd; wrong-silent is worse than broken-explicit).
- No auto-re-materialization sweep of already-installed plugins — updating this workspace's live `secrets-guard` entry is a re-apply via the Plugins view (human dogfood step). A re-materialize-on-activation pass is a separate follow-up if wanted.
- No change to git-hook dispatch (`pluginGitHook*`) — different mechanism, its own pathing.
- No change to the plugin authoring contract: `${TACHYON_PLUGIN_ROOT}` keeps its meaning; plugins need no edits.

## Open questions

- None — the claude×codex debate (pin `p-763d4b`) resolved root-resolution strategy, fail-policy scoping, and both runtimes' empirical hook cwd/env semantics before this spec was opened.
