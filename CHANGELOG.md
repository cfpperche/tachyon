# Changelog

All notable changes to Tachyon are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Older history lives in the git log and the
Marketplace release notes.

## 0.26.0 — Zero-config Bridge

### Added
- **Every Tachyon-spawned agent reaches the MCP Bridge automatically.** Tachyon injects the
  Bridge at spawn — Claude via an additive `--mcp-config`, Codex via an additive
  `-c mcp_servers.tachyon_bridge=…`, and an isolated-harness Claude has it folded into its
  scoped (`--strict-mcp-config`) file. Injection re-runs on **spawn, restart, resume, and fork**
  (a momentarily-down Bridge self-heals on the next start), and the token never lands on the
  command line. **No `.mcp.json` / `config.toml` registration is needed** for agents Tachyon
  spawns. `Tachyon: Connect Agent Runtime` remains, now scoped to **external/manual** sessions
  you start yourself.

### Fixed
- An isolated-harness agent with `inherit: none` no longer silently loses the Bridge — it is
  always folded into the materialized strict MCP file, so the agent can still call
  `complete_node` / `write_input`.

### Changed
- Pipeline preflight now treats a Tachyon-spawned Claude node as Bridge-capable (injection
  guarantees it — no project `.mcp.json` evidence required); a node whose command disables MCP
  (`--safe-mode`) is correctly reported as unable to signal completion.

### Removed
- The discontinued **layouts** feature was retired (legacy config keys remain tolerated).

### Internal
- The engine is now decoupled from VS Code behind a host port, enforced by a CI boundary guard.
- The `Workspace` is headless-testable (`createForTest` + an in-memory host).

## 0.25.0 — Agent Pipelines, input-driven
- Input-driven pipelines: one definition becomes a reusable workflow run per issue, with agent
  personas and a handoff bus that carries context down the chain.
- Codex pipeline nodes reach the Bridge automatically via an injected `-c` override.
