# 321 — plugin-hook-absolute-root — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Change `mergeHooks`'s root parameter from a contained-relative path to an **absolute** plugin root; the single call site (`engine.ts` `previewInstall`, `:899`) passes `path.join(workspaceRoot, rootRel)`. `resolveCommand` keeps its exact textual-substitution semantics (author quoting like `"${TACHYON_PLUGIN_ROOT}"/guard.sh` is preserved; it just now renders an absolute path inside those quotes). A new `isSafeAbsolutePluginRoot` in `src/plugins/paths.ts` replaces the `isSafePluginRoot` guard inside `mergeHooks` — absolute, no `..`, and the same no-whitespace/no-shell-metacharacter class, so the path can be embedded in a double-quoted `sh` test with zero escaping machinery. A workspace path that violates it fails the merge closed with a clear error.

Around the resolved command, `mergeHooks` renders a **plain multi-statement wrapper** (no extra `sh -c` layer — the runtime already executes hook commands via `sh -c`, so the command string itself can carry `if …; then …; fi; …` and `exit` works on the hook process):

- **Gate events** (`FAIL_CLOSED_HOOK_EVENTS = {PreToolUse}`): `if [ ! -d "<absRoot>" ]; then echo "[tachyon] …" >&2; exit 2; fi; <resolved>; rc=$?; if [ "$rc" -eq 127 ]; then echo "[tachyon] …" >&2; exit 2; fi; exit "$rc"` — a missing root or an unresolvable command becomes a **block** (exit 2) with a clear stderr message, while the inner hook's own exit code (0 pass, 2 deny) passes through untouched.
- **Observational events** (everything else): `if [ ! -d "<absRoot>" ]; then echo "[tachyon] …" >&2; exit 0; fi; <resolved>` — a missing plugin skips with a note, never bricks.
- Commands **without** the placeholder are written verbatim (no root dependency → no wrapper), keeping consent diffs minimal for such hooks.

Idempotency/uninstall need no new machinery: merge/remove are content-based against the lockfile's recorded groups, so re-applies of the new form are idempotent and uninstalls of OLD (relative) installs still replay their recorded commands. The consent fingerprint binds the rendered steps, so existing installs re-prompt on their next apply — honest, since the written command genuinely changed.

## Key decisions

All settled by the live claude×codex debate on pin `p-763d4b` (2 rounds, converged) — recorded here as the design-dueto fold:

- **Baked absolute root at materialization, on BOTH runtimes** — the hook belongs to the workspace where the plugin was materialized; its guard lives at a fixed path of THIS workspace no matter where the agent's shell cwd wanders. Grounded empirically: Claude's persistent shell cwd follows the agent's `cd` (live 127s captured); Codex probes (0.142.5) showed `PWD=<session cwd>` and **no** `CODEX_PROJECT_DIR` env. Rejected: `git rev-parse --show-toplevel` (codex round-1 proposal, withdrawn round 2) — resolves the WRONG root in a foreign repo (codex's own probes `cd`'d into `/tmp` repos), fails outside git, and points at the worktree (which doesn't contain gitignored `.tachyon/`); with fail-closed it would brick Bash in foreign cwds. Rejected: `$CLAUDE_PROJECT_DIR` as primary — claude-only, and still "where the runtime thinks the project is" rather than "where the plugin was materialized".
- **Relative-path portability was a false constraint** — codex proved `.claude/settings.json` / `.codex/hooks.json` are gitignored (machine-local); the original "tracked in git" premise was a claude-side shell bug (`git ls-files` exits 0 with no output). Workspace-move staleness is mitigated by re-apply (and a future re-materialize-on-activation follow-up), not by cwd inference.
- **Fail-closed scoped to gate events only** (`PreToolUse` in v1; the shared event sets have no `PermissionRequest`) — a broken security gate must block; a missing observational plugin must not brick a session. Universal fail-closed rejected (orphan hooks from an uninstalled non-critical plugin would freeze every Bash call). Per-hook `failurePolicy` metadata deferred to v2.
- **127-remap only on gates** — Claude treats exit 127 as a non-blocking hook error, which is exactly the silent-pass hole; the gate wrapper remaps 127→2. Other nonzero codes pass through so gitleaks' own deny (2) and transient failures keep their semantics. Observational hooks keep the runtime's native handling (codex already blocks loud; claude stays non-blocking).
- **No new `sh -c` nesting; charclass-guarded root instead of quote-escaping** — the wrapper is a flat multi-statement string executed by the runtime's own `sh -c`; the only interpolated value is the absolute root, made safe by construction via `isSafeAbsolutePluginRoot` (fail-closed on exotic workspace paths) rather than by an escaping dance. Rejected: exporting `TACHYON_PLUGIN_ROOT` as a runtime env var and leaving the placeholder for shell expansion — cute (the placeholder IS var syntax) but silently changes semantics for authors who single-quoted the placeholder, and adds an env layer for no gain over textual substitution.
- **Wrap only placeholder-using commands** — a command that never references the plugin root has no root dependency; wrapping it would add consent-diff noise without protecting anything real.

## Files touched

- `src/plugins/paths.ts` — add `isSafeAbsolutePluginRoot(raw)` (absolute + no `..` + the existing no-metacharacter class).
- `src/plugins/adapters/hooks.ts` — `mergeHooks` root param becomes absolute (guarded by the new validator, new error text); add `FAIL_CLOSED_HOOK_EVENTS` + the wrapper rendering in the `owned` construction; header comment gains the spec-321 note.
- `src/plugins/engine.ts` (`previewInstall`, `:899`) — pass `path.join(workspaceRoot, rootRel)`.
- `test/unit/pluginClaudeAdapter.test.ts` — ROOT becomes absolute; rendered-command expectations become the wrapped forms; unsafe-root cases updated (relative now fails, absolute-with-space fails); new cases: gate wrapper shape (dir-check + 127 remap + rc passthrough), observational wrapper shape, placeholder-free verbatim.
- `test/unit/pluginCodexAdapter.test.ts` — same root/rendering updates; `statusMessage` preservation with the wrapped command.
- `test/unit/pluginEngine.test.ts` — `RESOLVED` const and inline wired-command expectations become functions of the test workspace root (the engine now bakes the per-test absolute path).

## Risks & unknowns

- **R1 — behavioral shift for observational hooks with a present root but broken script** stays as today (runtime-native handling); only the missing-root case changes. Deliberate — scoped to the class of failure actually observed.
- **R2 — a consent re-prompt lands on every installed hooks-plugin's next apply** (fingerprint binds rendered steps). Expected and honest; called out for the maintainer.
- **R3 — sh wrapper edge cases** (author command ending in `&`, or itself calling `exit`): an author `exit` propagates directly (correct for gates: their deny stays a deny); trailing-`&` producing a syntax error with the rc-capture suffix is accepted as an authoring error (same class as any malformed command today).
- **R4 — live workspaces keep the OLD relative command until re-apply** — the fix changes what NEW merges write; the human-dogfood step re-applies secrets-guard here to prove the end-to-end path.

## Sources consulted

- `src/plugins/adapters/hooks.ts` (`resolveCommand`, `mergeHooks`, parse/merge/remove contracts), `src/plugins/paths.ts` (`isSafePluginRoot`), `src/plugins/engine.ts:884-912` (`previewInstall` merge call, `rootRel` origin at `:391`, `fingerprintOf`).
- `test/unit/pluginClaudeAdapter.test.ts`, `test/unit/pluginCodexAdapter.test.ts`, `test/unit/pluginEngine.test.ts` — the expectations the change must update.
- Pin `p-763d4b` + handoff decision note — the full claude×codex debate record (empirical probes: claude cwd-follows-shell 127s; codex PWD/env inventory, cd non-persistence, loud-block on hook failure).
- Live evidence: `~/.claude/projects/-home-goat-tachyon/a55290a4-*.jsonl` `hook_non_blocking_error` records, 2026-07-02T00:12-00:13Z.
