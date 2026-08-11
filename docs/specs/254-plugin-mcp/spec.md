# Spec 254 — Plugin MCP servers (the third plugin capability, after hooks + skills)

**Status:** shipped
**Closure:** Commit `f1186dbe` records all six v1 steps landed and reviewed, with live dogfood against `tachyon-plugin-example@v4.0.0`.

> **Origin.** The plugin system shipped hooks (250) then skills (251), each time keeping the system the **common denominator between runtimes**. MCP is the maintainer's chosen next capability: both Claude Code and Codex CLI load MCP servers natively, so — like skills — a server is genuinely portable; only its *config format* differs per runtime. This is the third confirmation of the common-denominator thesis, not an exception to it.

## Problem

A plugin can wire hooks (250) and skills (251) into a workspace's runtimes, but **not MCP servers** — today a primary way to give an agent new *tools* (databases, issue trackers, browsers, APIs). The engine reserves an `mcp-server` `TargetKind` in the lockfile (`ref` documented as "an mcp server name") but never materializes one. There is no way to package an MCP-server declaration once and have Tachyon install it — with consent, collision safety, and clean removal — into each present runtime that loads MCP.

Note the existing seam: `src/registration/adapters.ts` already merges **the Tachyon Bridge** MCP server into claude `.mcp.json` (`mcpServers.tachyon`) and codex `.codex/config.toml` (`[mcp_servers.tachyon]`). Those are **Bridge-specific** (a single hard-coded server name, HTTP-only) but carry the proven mechanics — parse-merge a JSON object, targeted TOML-block (re)write, an idempotent already-registered check — that the plugin path should **generalize and reuse**, not reinvent.

## Goal

A plugin may ship **MCP servers** as a **runtime-neutral declaration**. On install, each present runtime's adapter renders each declared server into **that runtime's** MCP config format; a runtime with no MCP loader is **skipped** (the same honest declare-and-skip model hooks/skills use). The consent drawer shows each server (transport, exact command+args or url, referenced env-var names, destination) **before any write** — this is the highest-risk capability the plugin system offers, because an installed server is an arbitrary local process (stdio) or network endpoint (http) the agent can invoke at will. A name collision with a server the user already configured is **the human's decision (Keep / Replace)**, never a silent clobber or hard refuse. Removal un-merges exactly the server entries Tachyon wrote (recorded in the lockfile by server name), never a user's own server. **No secret values ever live in the (committed, possibly-public) payload** — only env-var *references*.

## Prior art (verified against official docs, 2026-06-24)

An MCP server is configured per runtime; the **declaration is portable, only the format differs** — the inverse of hooks (where content differs) and the same shape as skills (where only the destination differs).

| Runtime | Project-scoped MCP config | stdio shape | http shape | Secret handling |
|---|---|---|---|---|
| **claude** | `.mcp.json` (key `mcpServers`) | `{ "command", "args", "env" }` | `{ "type": "http", "url", "headers" }` (`streamable-http` is an alias; `ws` ok; `sse` deprecated) | `${VAR}` expansion in `env`/`args` (set in the server's env) |
| **codex** | `.codex/config.toml` `[mcp_servers.<name>]` (trusted project) | `command`, `args`, `env`, `env_vars` (allow-forward), `cwd` | `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers` | `bearer_token_env_var` / `env_vars` reference names, never values |

Sources: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp), [MCP — Codex (OpenAI)](https://developers.openai.com/codex/mcp).

The takeaway driving the design: **the server identity (run THIS command / connect to THIS url, with THESE env-var references) is identical across runtimes; only the config syntax differs.** So MCP gets a **neutral declaration** translated per runtime — exactly like skills, and unlike hooks.

> **Claude has its own native plugin→MCP path** (`.mcp.json` at the plugin root / inline in `plugin.json`, resolving `${CLAUDE_PLUGIN_ROOT}`). Tachyon's plugin system is a *separate, cross-runtime* mechanism; we do not depend on or emulate claude's plugin loader — we write the workspace-level `.mcp.json` / `config.toml` directly, the same files the Bridge registration already writes.

## Proposed decisions (to pressure-test with codex, then agree with the maintainer)

- **D1 — MCP is the third plugin capability; common-denominator holds.** Both v1 runtimes load MCP; only the config format differs → neutral declaration. Verified, not assumed.
- **D2 — Neutral server declaration, per-runtime FORMAT mapping (mirrors skills, not hooks).** A plugin declares each server once; each adapter renders it into the runtime's syntax (claude JSON `mcpServers.<name>`, codex TOML `[mcp_servers.<name>]`).
- **D3 — Both transports.** The neutral shape covers **stdio** (`command`, `args`, `env`) and **http** (`url`, `headers`). stdio is the common plugin case; both runtimes support both.
- **D4 — Secrets by env-var INDIRECTION; never values in the payload.** The declaration references env-var *names* only (the payload is committed and may be public). The consent drawer lists the env vars each server needs so the user provisions them out-of-band — mirrors the Bridge's `TACHYON_BRIDGE_TOKEN` indirection. An adapter maps the neutral reference to each runtime's idiom (claude `env: {K: "${K}"}`; codex `env_vars` / `bearer_token_env_var`).
- **D5 — Consent: the highest-risk capability yet.** The drawer shows, per server: name, transport, the **exact command + args** (stdio) or **url** (http), the **referenced env vars**, and the destination per runtime — before any write. Fail-closed at the engine layer (no silent write).
- **D6 — Reuse the reserved `mcp-server` `TargetKind` + generalize the Bridge writers.** No lockfile enum change. `ref` = the server name; `removal` carries the content-based un-merge identity. Lift the merge/targeted-TOML/idempotency mechanics out of `registration/adapters.ts` into a shared, server-name-generic helper used by both the Bridge registration and the plugin adapter (one writer, two callers).
- **D7 — Collision = the human decides (Keep / Replace).** A server name already at a destination that is NOT one of this plugin's prior `mcp-server` targets is a USER collision → Keep (skip, leave the user's server) or Replace (overwrite), per colliding destination; fail-closed at apply without an explicit decision — identical to spec 251 skills.
- **D8 — Project-level only in v1.** Materialize to the committed `.mcp.json` / `.codex/config.toml`, consistent with hooks/skills. User-level (`~/.claude.json`, `~/.codex/config.toml`) is out of scope.

## Open questions — RESOLVED (see § Codex debate adjudication for rationale)

- **OQ1 — Declaration location & shape.** A manifest field (`mcp: [...]`, central + auditable) vs a neutral payload file auto-discovered at the plugin root (e.g. `mcp/servers.json`, mirroring how `skills/` is discovered)? Servers are small JSON, not directories, so a single declaration file or manifest field fits better than a per-server dir. **Lean:** a top-level `mcp.json` payload file (neutral schema), auto-discovered like `skills/`; validate fail-closed at load. Pressure-test against the manifest-field alternative.
- **OQ2 — Strict neutral schema vs near-`.mcp.json` passthrough.** Define a strict neutral schema (`{name, transport, command/args/env | url/headers, requiresEnv[]}`) and translate to each runtime, or accept a claude-shaped entry and translate to TOML? **Lean:** strict neutral schema — translating cleanly to both, validating untrusted input fail-closed, and not leaking claude-isms into codex.
- **OQ3 — Env-var indirection across the format gap.** claude expands `${VAR}` inside `env`/`args`; codex uses `env_vars` (allow-forward) and `bearer_token_env_var`. How does the neutral shape express "needs env var X" so each adapter emits the right idiom (and the drawer can list them)? **Lean:** neutral `env: {K: "${K}"}` + an explicit `requiresEnv: [...]` for the consent surface; adapters map per runtime.
- **OQ4 — Bundled-binary command paths.** If a plugin SHIPS a server executable (not a public `npx` package), its `command` must resolve to the materialized payload (`.tachyon/plugins/<name>/…`). claude offers `${CLAUDE_PLUGIN_ROOT}`; codex has no equivalent. **Lean:** Tachyon resolves a neutral `${PLUGIN_ROOT}` token to the committed payload path at materialization (workspace-relative), so both runtimes get a working path; pure `npx`/PATH commands pass through unchanged. Verify codex variable-expansion limits.
- **OQ5 — Confirmation strength on first install.** Given arbitrary-command-on-demand, is normal consent enough, or should MCP require a second confirmation even on a non-colliding first install (stronger than skills, where double-confirm is Replace-only)? **Lean:** prominent command/url display + the existing fail-closed consent; reserve double-confirm for Replace (consistency) — but explicitly pressure-test whether MCP's risk profile warrants more.
- **OQ6 — `enabled`/auto-start semantics.** Claude starts plugin servers automatically; a bare `.mcp.json` entry is "pending approval" until the user approves in-session. Does Tachyon write the entry and let each runtime's own approval gate it (honest, no surprise auto-run), or attempt any enable? **Lean:** write the entry only; never auto-enable — the runtime's own MCP approval remains the final gate, which compounds Tachyon's consent.

## Codex debate adjudication (2026-06-24 — verdict REVISE, folded)

Codex pressure-tested the design read-only against `manifest.ts`, `lockfile.ts`, `engine.ts`, `registration/adapters.ts`, and the spec-251 pattern. Direction agreed (D1–D3, D8 stand as written); the following are folded as binding amendments. Transcript artifact: scratchpad `mcp-debate-result.md`.

**OQ resolutions:**
- **OQ1 → top-level `mcp.json` payload file** (auto-discovered like `skills/`), NOT a `tachyon-plugin.json` field — keeps the manifest lean and mirrors neutral-payload discovery.
- **OQ2 → strict neutral union schema** (stdio | http), validated fail-closed with the same key-closure + resource-cap treatment `manifest.ts` already applies (`KNOWN_FIELDS`, `MAX_*`). Passthrough is rejected — it leaks claude-isms into codex and weakens validation.
- **OQ3 → derive the consent env list from STRUCTURAL refs**, not a hand-maintained `requiresEnv` (duplicate lists drift). The drawer's env names come from the `env`/`header`/bearer reference fields themselves.
- **OQ4 → `${PLUGIN_ROOT}` only as a LEADING token in path-like fields**, with the suffix validated by the same contained-relative-path rules as `paths.ts`/`validBlockPath` (no absolute, no `..`, no backslash, no controls). NO general string substitution inside arbitrary `args`.
- **OQ5 → RESOLVED (maintainer, 2026-06-24): double-confirm EVERY MCP install, and again on Replace.** An installed server is agent-invokable process/network authority — strictly riskier than a skill, so it earns a stronger gate than skills' Replace-only double-confirm. The consent drawer's MCP section requires an explicit second confirmation before any server is written (fail-closed at the engine layer); Replace adds the collision-overwrite confirmation on top.
- **OQ6 → write entries only, never auto-enable.** Each runtime's own MCP approval stays the final gate (compounds Tachyon's consent).

**Binding amendments to the decisions:**
- **D4 (secrets) — hardened.** Forbid literal secret-bearing values in `env`, `headers.Authorization`, and any bearer/`env_http_headers` field; accept only structural env references. **Precedent to reuse:** the harness MCP config loader already rejects non-`${VAR}` env values for exactly this reason (`src/config/loadConfig.ts:345`, `:379`) — the plugin path applies the same rule.
- **D5 (consent) — bind to the engine.** `previewInstall` must fingerprint the MCP plan and `applyInstall` must re-derive + refuse stale consent, identical to skills/hooks (`engine.ts:486`, `:570`), with the per-file lost-update check.
- **D6 (reuse) — escaping-safe writer required.** The current codex writer is safe ONLY because `tachyon` is hard-coded and the URL trusted (`registration/adapters.ts:111` interpolates `url = "${url}"`). For arbitrary names/values: validate server names against a kebab regex AND TOML-escape every rendered value (or use a TOML encoder); JSON stays safe via `JSON.stringify`. **Add Bridge regression tests pinning current behavior BEFORE sharing the writer** (`test/unit/adapters.test.ts` already pins: stale-port overwrite, other-server preservation, exact `mcpServers.tachyon` / `[mcp_servers.tachyon]` names, idempotent no-op, token indirection, TOML targeted-block-only edit).
- **D7 (collision) — validate recorded targets.** A corrupted/forged lockfile target must not suppress a real collision; validate each recorded `runtime`/`file`/`ref` before trusting it as "ours" (skills already do this — `engine.ts:582`, `:721`).

**Required changes before "DESIGN AGREED" (codex checklist, retained as the plan gate):**
1. Close OQ1–OQ6 in the spec with the picks above. ✓ (done here; OQ5 pending maintainer)
2. Define the exact `mcp.json` schema: name regex, transport union, max counts/sizes, no unknown keys, no controls/nulls.
3. Replace any `requiresEnv` duplication with env requirements derived from structural refs.
4. Specify `${PLUGIN_ROOT}` resolution + containment; no broad string interpolation.
5. Require escaping-safe JSON/TOML writers (TOML-safe names + value encoding).
6. Mirror engine consent mechanics: preview fingerprint, apply re-derive, lost-update, fail-closed undecided collisions.
7. Define `mcp-server` lockfile target validation + removal identity (`runtime`, file, `ref` server name, expected rendered entry/hash before un-merge).
8. OQ5 decided (double-confirm every MCP install + Replace) — implement the second-confirmation gate in the consent drawer + fail-closed at the engine.
9. Add Bridge regression tests before sharing the writer.

## Acceptance

- [ ] A plugin shipping an MCP-server declaration installs that server into every present runtime that loads MCP (claude → `.mcp.json` `mcpServers.<name>`; codex → `.codex/config.toml` `[mcp_servers.<name>]`); a runtime without an MCP loader is reported as skipped.
- [ ] Both transports work: a stdio server (`command`/`args`/`env`) and an http server (`url`/`headers`) each render to the correct per-runtime shape, verified against the documented formats.
- [ ] No secret value is ever written from the payload — only env-var references; the consent drawer lists the env vars each server requires.
- [ ] The consent drawer shows, per server, before any write: name, transport, exact command+args or url, referenced env vars, and each runtime destination.
- [ ] A name collision at a destination surfaces **Keep / Replace**; Keep leaves the user's server untouched; Replace overwrites; an undecided collision is fail-closed (no write).
- [ ] Remove un-merges exactly the server entries recorded in the lockfile (by server name), preserves every other line/server/comment, and never touches a user's own (Kept) server.
- [ ] A plugin mixing hooks + skills + MCP installs all three; hooks stay per-runtime blocks, skills + MCP come from neutral payloads.
- [ ] The Bridge registration (`registration/adapters.ts`) and the plugin MCP adapter share ONE server-name-generic writer (no duplicated merge/TOML logic); the Bridge's existing behavior is unchanged (regression-covered).
- [ ] Engine unit tests cover: install/skip per runtime, stdio + http rendering, collision Keep, collision Replace, undecided-collision fail-closed, and content-preserving removal. UI proven by driving the real built bundle (consent drawer MCP section + Keep/Replace).
