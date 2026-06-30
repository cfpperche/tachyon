# 298 — codex-isolated-harness — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add Codex as a first-class isolated-home runtime without changing the spawn pipeline's single harness hook:

1. Generalize `ResumeAdapter.harness` from a Claude-only shape into a small runtime contract:
   private home env var, auth files, session subdir, and an MCP materialization mode.
2. Keep Claude on the existing `mcp.json + --mcp-config + --strict-mcp-config` path.
3. Add Codex on a `CODEX_HOME + config.toml` path. The private home is the Codex home itself; `config.toml`
   is written inside it and no MCP CLI args are appended.
4. Teach the session resolver that Codex can have a redirected home, so capture/resume/activity scans
   `<CODEX_HOME>/sessions` instead of always `~/.codex/sessions`.
5. Update config validation so `harness:` and `isolate: transcript` accept both `claude` and `codex`, with
   runtime-specific reserved env checks.
6. Add targeted unit coverage for materialization, config validation, spawn wiring, and redirected transcript
   lookup, then run the SDD verify/dogfood commands.

## Key decisions

- **Use `CODEX_HOME` as the private home root** — the installed Codex CLI `0.142.4` help explicitly says config
  is loaded from `$CODEX_HOME/config.toml`, and the real home has `auth.json`, `config.toml`, and `sessions/`.
  Rejected a nested `.codex` under the harness home because that would fight Codex's own home contract.
- **Symlink Codex `auth.json`, copy or seed config intentionally** — auth should stay fresh like Claude's
  `.credentials.json`; config must be runtime-owned in the private home so harness MCP can be isolated.
- **Render Codex MCP with existing TOML helpers** — reuse the already tested `[mcp_servers.<name>]` block writer
  instead of adding a TOML parser. For harness materialization, replacing the private home's owned blocks is enough
  because the file is Tachyon-owned.
- **For `isolate: transcript`, copy the current Codex config into the private home** — redirecting `CODEX_HOME`
  is the only transcript-isolation mechanism; copying the current config preserves the normal workspace/global
  Codex behavior as closely as possible without adding harness MCP isolation.
- **Keep Bridge injection out of CLI args for harness agents** — for Codex harness, the Bridge block must live in
  the private `config.toml`; `withRuntimeBridge` already skips `def.harness`, matching Claude's strict-file model.
- **Do not claim Codex rules/skills/hooks parity in this pass** — the acceptance-critical feature is MCP and
  transcript isolation. Codex `rules`/`skills`/`hooks` are rejected by validation until their native paths are
  specified and dogfooded.

## Files touched

- `src/resume/adapters.ts` — generalize harness capability and add Codex `CODEX_HOME` support.
- `src/harness/HarnessManager.ts` — materialize Codex private homes and `config.toml` MCP blocks.
- `src/resume/resolvers.ts` — let Codex session scans use a redirected Codex home.
- `src/agents/AgentManager.ts` — derive runtime-specific config homes for ledger/resume, not only Claude homes.
- `src/workspace/Workspace.ts` — pass the redirected Codex home into resolvers.
- `src/config/loadConfig.ts` and schema/form hints if needed — accept Codex harness/isolate and reject reserved envs.
- `test/unit/harness.test.ts`, `test/unit/config.test.ts`, `test/unit/agentManager.test.ts`, `test/unit/resume.test.ts` — regression coverage.
- `docs/specs/298-codex-isolated-harness/*` — SDD plan/tasks/notes/evidence.

## Risks & unknowns

- Codex config layering under redirected `CODEX_HOME` may not preserve project `.codex/config.toml` exactly. The
  implementation should be explicit: harness writes an isolated config; isolate transcript copies the user's current
  home config to avoid losing base config.
- Codex `auth.json` symlink may be sufficient, but if Codex also needs sqlite state, first real dogfood may reveal
  another auth dependency. Keep the auth file list easy to extend.
- Codex session IDs are capture-based and filenames include timestamps, so deterministic `transcriptPath` is still
  out of scope. The resolver root change is the required proof.
- Existing `configHome` naming is Claude-biased. Rename only where necessary; avoid a broad ledger migration.
- Claude regressions are high risk because the harness path is mature. Tests must prove the old env/args/files are
  unchanged.

## Sources consulted

- `src/resume/adapters.ts` — current harness capability and runtime adapters.
- `src/harness/HarnessManager.ts` — existing isolated-home materialization.
- `src/agents/AgentManager.ts` and `src/workspace/Workspace.ts` — spawn/resume wiring and resolver env.
- `src/resume/resolvers.ts` — Codex and Claude transcript scan roots.
- `src/plugins/adapters/codex.ts` and `src/registration/adapters.ts` — existing Codex MCP TOML rendering/merge helpers.
- Local `codex --help` / `~/.codex` inspection — confirmed `$CODEX_HOME/config.toml`, `auth.json`, and `sessions/`.
- Claude ad-hoc probes attempted (`probe-17a736ec-87ee-4a94-b9d2-e17fd4eb0ad9`, `probe-2d06ed52-39da-40a9-8ba9-f3e982a91e92`, `probe-8055ada1-6f94-4de6-b2c4-b95caef847d6`) but did not return usable guidance.
