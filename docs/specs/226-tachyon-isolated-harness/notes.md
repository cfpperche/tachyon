# 226 — tachyon-isolated-harness — notes

## Capability verification — LIVE (2026-06-16)

Ran against the installed binaries (not training-data assumptions — the `feedback_verify_runtime_capabilities`
discipline). Versions: **claude 2.1.179 (Claude Code)**, **codex-cli 0.139.0**.

### claude — isolation levers confirmed in `claude --help`
- `--mcp-config <configs...>` — "Load MCP servers from JSON files or strings (space-separated)".
- `--strict-mcp-config` — "Only use MCP servers from --mcp-config" (ignores global + project `.mcp.json`).
  → this is the **no-leak guarantee** for MCP without touching the config home.
- `--settings <file-or-json>` — custom settings JSON (hooks, permissions, apiKeyHelper).
- `--plugin-dir <path>` — "Load a plugin from a directory or .zip" (skills + commands + hooks bundle);
  repeatable (`--plugin-dir A --plugin-dir B.zip`).
- `--add-dir <directories...>` — extra dirs for tool access + CLAUDE.md context.
- `--agents <json>` — inline custom subagent definitions.
- `--append-system-prompt` / `--system-prompt-file` — rules-as-prompt.
- `--bare` — "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, ... and CLAUDE.md
  auto-discovery." Explicitly opt context back in via `--system-prompt[-file]`, `--append-system-prompt`,
  `--add-dir`, `--mcp-config`, `--settings`, `--agents`, `--plugin-dir`. → the strongest **inherit: none**
  primitive.
- `--disable-slash-commands` — disable all skills.
- `CLAUDE_CONFIG_DIR` (env, not in --help) — redirects the WHOLE config home (settings, hooks, skills,
  plugins, auth, memory). The cleanest total per-agent isolation; set it via the existing `env:` map.

### codex — isolation levers confirmed in `codex --help` / `codex exec --help` / `codex mcp --help`
- `-c, --config <key=value>` — dotted-path TOML override; can set `mcp_servers.<name>.command=…` inline.
- `-p, --profile <name>` — "Layer $CODEX_HOME/<name>.config.toml on top of the base user config" →
  partial inheritance.
- `--strict-config` — error on unknown config fields.
- `codex mcp { list|get|add|remove|login|logout }` — manage MCP servers in the config home.
- `CODEX_HOME` (env) — redirects the config home (config.toml incl. `[mcp_servers.*]`, profiles). Full
  isolation analog to `CLAUDE_CONFIG_DIR`. AGENTS.md remains cwd-discovered (composes with the worktree).

### Conclusion
No CLI fork needed. The primitive is **config-home redirection via the existing per-agent `env:`**
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) + per-runtime no-leak flags (`--strict-mcp-config` for claude).
Maps cleanly onto Tachyon's existing per-runtime adapter abstraction (mirror `forkCommand`).

## Architecture anchors (read 2026-06-16)
- `src/config/loadConfig.ts:44-66` — `AgentDef` (already has `env?`, `worktree?`, `role?`, `verify?`);
  `parseAgentEntry` validates `env` as a string→string map (`:244`). A `harness:` block adds one more
  validated key here (+ `AGENT_KEYS` at `:211`).
- `src/resume/adapters.ts` — `ResumeAdapter` + `ADAPTERS`; `forkCommand?`/`forkable()` is the template
  for an optional per-runtime capability. `materializeHarness?(def) → {env, args}` would slot in the
  same way; `binaryOf`/`runtimeOf` already resolve the runtime from a cmd.
- `WorktreeManager` — gives an isolated-harness agent its own cwd (orthogonal to config isolation).

## Loop-engineering tie-in (pin p-bf1d7d, memory project_loop_engineering_re)
Loop-engineering's "Five Building Blocks" = Automations · Worktrees · **Skills · Plugins/Connectors (MCP)**
· Sub-agents · +Memory. An "isolated harness" is literally **per-agent Skills+Connectors scoping** — the
building-block view raised whether a harness should be a reusable *template* a `schedule:`/`/routine`
spawns. RESOLVED (Decision 6): defer the template abstraction — reuse already works via a declared
agent + `schedules.spawn`; a shared `harness-templates:`/`extends:` is v2, rule-of-three.

## Decisions log
- **2026-06-16 — locked (maintainer).** Name = "isolated harness" (NOT "specialist agent" — collides
  with the orthogonal `role:` axis + only covers one use). v1 = claude-only, mcp-only. inherit default
  = `workspace`. Materialization = config-home redirection (`CLAUDE_CONFIG_DIR`) + `--strict-mcp-config`.
  Secrets = `${ENV}` indirection only, `.tachyon/harness/**` gitignored + GC on Dismiss. Worktree =
  orthogonal. Template framing = deferred to v2. Full text in spec.md § Decisions. Next = codex debate.

## codex IMPLEMENTATION review — 2026-06-16 (gpt-5.5, high, read-only) → VERDICT: CHANGES → all folded
Ran after the MVP was built. 2 BLOCKER + 3 MAJOR + 1 MINOR, all real, all fixed (554 tests green):
- **B1 (secret never reached the process env).** `mcp.json` carried the literal `${VAR}` (correct), but
  nothing put the REAL value in the spawned env, so claude expanded `${FAL_KEY}` to the literal string.
  FIX: `HarnessManager.collectEnvRefs` + resolve from the host `procEnv` and inject concrete `VAR=value`
  into the returned env; **fail closed** (`HarnessUnavailableError`) before any fs side effect if a
  referenced var is missing. The example dropped its misleading agent-level `env:` literal.
- **B2 (rename/GC break — config home is name-keyed, not persisted).** A rename would orphan the old
  home's transcripts and GC could delete them. FIX (v1, fail-closed, matches the fork posture): **block
  renaming a harness agent**; without rename the by-name GC is safe. Persist-configHome is the follow pass.
- **M3 (dangling auth symlink).** `symlinkSync` succeeds even if the real `.credentials.json` is absent
  → unauthenticated spawn. FIX: check the target exists, throw `HarnessUnavailableError` if not.
- **M4 (`--flag=value` bypass).** The reserved-flag check was token-exact. FIX: also match `--flag=…`.
- **M5 (schema parity).** Cross-field rules aren't expressible in pure JSON Schema → documented the
  loadConfig validator as authoritative (schema note + the validator tests are the parity record).
- **M6 (UI offered Fork on a harness agent).** FIX: `canForkOf` excludes `def.harness` (manager already blocked it).
**v1 limitations now explicit (all fail-closed, follow-pass):** no fork of a harness agent, no rename of
one, secrets must be in the ambient env before start. Round-2 self-reviewed (codex usage permitting).

## codex design debate — 2026-06-16 (gpt-5.5, high, read-only) → VERDICT: CHANGES
2 BLOCKER + 7 MAJOR. Both BLOCKERs trace to ONE choice: **redirecting the config home**
(`CLAUDE_CONFIG_DIR`, locked Decision 3). Findings:
1. **BLOCKER — auth.** A fresh `CLAUDE_CONFIG_DIR` likely drops claude's OAuth/keychain login → the
   harness agent fails to start before MCP even matters. MVP seeds `none|workspace`, not auth. → must
   live-prove a redirected home starts authenticated, or seed/symlink ONLY auth material.
2. **BLOCKER — resume/fork/readiness break.** `adapters.transcriptPath`/`resolvers` hardcode
   `~/.claude/projects/…` (`adapters.ts:137`, `resolvers.ts:140,156`); `AgentManager` passes OS home
   (`:706`,`:747`). A redirected home puts transcripts under `<CLAUDE_CONFIG_DIR>/projects/…` →
   invisible to resume-by-title (220), the resumable badge (221), and session fork (225). → thread the
   effective config home through every resolver, or don't redirect it.
3. **MAJOR** — flags only appended at first spawn → restart/resume/fork silently lose isolation. Make
   "materialize harness + augment cmd/env" ONE shared pipeline across spawn/restart/resume/fork.
4. **MAJOR** — cmd/env collisions defeat no-leak (`cmd: claude --mcp-config ~/x.json`; user-declared
   `env.CLAUDE_CONFIG_DIR`). Reject a harness agent whose cmd already carries `--mcp-config`/
   `--strict-mcp-config`/`--settings` or a config-home env override.
5. **MAJOR** — "no sibling leak" ≠ "no project/global pickup". Define & test TWO guarantees:
   `inherit:none` excludes cwd/global MCP; `inherit:workspace` includes ONLY an explicit copied
   workspace-MCP snapshot + overlay.
6. **MAJOR** — seeding under-specified. v1: COPY/merge only the workspace `.mcp.json` at materialize
   time, never symlink (write-back pollution); rematerialize each spawn/restart/resume.
7. **MAJOR** — secrets: do NOT resolve `${ENV}` into the generated file. Write the literal `${VAR}`
   reference, require the real var in the spawned process env, fail before spawn if missing.
8. **MAJOR** — GC-on-Dismiss can delete a resumable agent's transcript/home + crash orphans. Tie GC to
   ledger state (never delete while a live session / resumable row / fork source references it) +
   startup GC for ownerless dirs.
9. **MAJOR** — fail closed. Error on `harness:` for terminals / non-claude runtimes / `inherit:global`
   / empty-invalid `mcp` / literal secrets / not-yet-built `skills|rules|hooks`. Mirror in the schema.

**Post-debate analysis (mine):** findings 1, 2, 6, 8 ALL dissolve if the mcp-only MVP uses
**flag-overlay** (`--mcp-config <materialized.json>` + `--strict-mcp-config`) and does NOT redirect the
config home. Auth + transcripts stay in `~/.claude` (resume/fork untouched); `--strict-mcp-config`
("only use MCP from --mcp-config", verified live) still gives no-leak; the materialized file lives in
`.tachyon/harness/<agent>/` but holds no transcripts so GC is safe. Config-home redirection is only
needed once we isolate skills/hooks/settings (deferred) — and THEN we solve auth+resume threading.
→ Recommend re-scoping Decision 3 (config-home → flag-overlay) for v1. AWAITING maintainer confirm.
Findings 3,4,5,7,9 fold in regardless (and simplify under flag-overlay).

## BLOCKER verification — LIVE (2026-06-16) → config-home redirection IS viable; pivot NOT needed
Tested with throwaway `CLAUDE_CONFIG_DIR` dirs in /tmp (credential copies deleted after). claude 2.1.179.
- **Auth storage:** `~/.claude/.credentials.json` (749 B OAuth token). No keychain, no `apiKeyHelper`.
- **TEST A — fresh redirected home, NO auth seeded:** `claude -p "…"` → **"Not logged in · Please run
  /login", exit 1.** → BLOCKER 1 is real: a bare `CLAUDE_CONFIG_DIR` drops auth.
- **TEST B — fresh home + ONLY `.credentials.json` seeded:** → **`AUTHOK`, exit 0.** Auth blocker is
  solved by seeding ONE 749 B file. claude auto-creates the rest (`.claude.json`, `sessions/`,
  `backups/`, `session-env/`) on first run — no need to seed them.
  - **Use a SYMLINK, not a copy**, for `.credentials.json` → the real `~/.claude/.credentials.json`, so
    an OAuth token refresh stays valid (a copy goes stale on rotation). Caveat: if claude writes creds
    via temp+atomic-rename it replaces the symlink with a regular file in the redirected home (real
    file then won't update; agent keeps valid refreshed creds; re-symlink on next materialize). Fine v1.
- **TEST B also confirmed BLOCKER 2 concretely:** the redirected home created its OWN `projects/` dir →
  transcripts live under `<CLAUDE_CONFIG_DIR>/projects/…`, invisible to the `~/.claude`-hardcoded
  resolvers. Fix = thread the effective home through `adapters.transcriptPath` / `resolvers` /
  `AgentManager` resume/fork/readiness call sites (codex finding 2 — bounded, ~3 sites).

### H7 verification — LIVE (2026-06-16) → claude DOES expand `${VAR}`
Probe: a `--mcp-config` server `{command:sh, args:[…,"${TACHYON_PROBE_VAR}"], env:{INNER:"${TACHYON_PROBE_VAR}"}}`
spawned with `--strict-mcp-config --dangerously-skip-permissions` (needed — unapproved `.mcp.json`
servers are NOT connected/spawned otherwise) wrote a marker of what the process actually received:
**`ARG=[EXPANDED_OK] ENV=[EXPANDED_OK]`** with `TACHYON_PROBE_VAR=EXPANDED_OK` in the parent env.
→ claude expands `${VAR}` from the process env in BOTH `args` and the `env` block. So H7 design holds:
write `${VAR}` literally into the materialized `.mcp.json` (no secret on disk), ensure the real var is
in the agent's spawned process env (the existing `AgentDef.env` threading), claude expands at spawn.

**Conclusion — REVISED recommendation:** the flag-overlay pivot is NO LONGER recommended. Config-home
redirection (locked Decision 3) is VIABLE — both BLOCKERs are now bounded, proven-solvable tasks
(auth = symlink one file; resume = thread one path). Keeping config-home means the FULL isolated
harness (skills/rules/hooks) extends cleanly later by writing more into the same home, instead of a
flag-overlay→config-home re-architecture. mcp-only v1 stays a real first slice of the real feature, not
a detour. → Decision 3 STANDS (config-home), now with auth-seed + resume-home-threading folded in.
