# Spec 254 — notes (in-flight design memory)

## Step 1 — `mcp.json` schema decisions (refining the spec's loose shape)

The spec stated http as `{url, headers}` and "secrets by env-ref" loosely. Implementing the loader forced concrete rules; recorded here for the codex dueto to ratify:

- **Payload shape = `{ "servers": [ {name, transport, …} ] }`** (an ordered array, not a name→def map). Ordered + dedupe-checkable + key-closable; mirrors how a marketplace lists servers. Top-level key closure: only `servers`.
- **env values = EXACT `${VAR}`** — mirrors the established H7 rule (`src/config/loadConfig.ts:380`, `ENV_REF_RE`). A literal is rejected outright ("would commit a secret to disk"). This deliberately also rejects literal NON-secret env (e.g. `LOG_LEVEL=debug`) — consistent with the precedent; static env is a follow pass if ever needed.
- **http `headers` values must reference ≥1 `${VAR}` and carry no bare `$`.** This permits the real-world `Authorization: Bearer ${TOKEN}` idiom (which exact-`${VAR}` would have rejected — and which the Bridge itself uses) while still forbidding a hard-coded literal secret and a no-ref static header. Trade-off: a static non-secret header (e.g. `X-Api-Version: 2`) is rejected in v1 — acceptable; static headers are a follow pass. Secret-hygiene beats completeness here.
- **`requiresEnv` is DERIVED** (OQ3) from the env + header refs during parse (deduped + sorted), never author-declared. Exported `mcpRequiredEnv(servers)` recomputes the identical list for the Step-5 consent surface so it can't drift.
- **`${PLUGIN_ROOT}` is leading-token-only** (OQ4): valid only as `${PLUGIN_ROOT}/<contained-rel>` in `command` and in a path arg; the suffix is validated by `paths.ts checkContainedRelPath` (no `..`/absolute/backslash/controls). A non-plugin-root `command` must be a BARE token (`npx`, `node`, …) — no separators, no absolute path, no metacharacters, no `${…}`. A non-plugin-root `arg` may be any literal but must contain NO `${…}` (no env/secret substitution smuggled into argv — args are an argv array, never shell-joined). `--config=${PLUGIN_ROOT}/x` (non-leading) is rejected → use two args `["--config", "${PLUGIN_ROOT}/x"]` (matches claude's own example idiom).
- **`url` is a literal http(s) URL** — no `${…}` substitution in v1 (URLs rarely need env; keeps the surface tight).
- **Reserved names** `tachyon` / `tachyon_bridge` rejected (the Bridge injects these; a plugin must not shadow them) — mirrors `loadConfig.ts:356`.
- **Caps:** 64KB payload, 32 servers, 64 args, 64 env, 32 headers, 1024-char strings.
- **`discoverMcp` is fail-closed**: `mcp.json` must be a REAL regular file (no symlink/special escaping the plugin boundary), mirroring `discoverSkills`. Absent → no MCP (not an error). `loadPlugin` now counts an MCP payload toward the "≥1 capability" rule.

Files: `src/plugins/mcp.ts` (new, pure), `src/plugins/engine.ts` (MCP_FILE + LoadedPlugin.mcp + discoverMcp + capability count), `test/unit/pluginMcp.test.ts` + `test/unit/pluginEngine.test.ts` (MCP discovery).

### Codex Step-1 review (NEEDS-REVISION → folded → re-review pending)

- **[HIGH] header secret-beside-ref bypass.** First fix (`[scheme] ${VAR}` with an *arbitrary* scheme word) still let `sk-live ${TOKEN}` through (a hyphenated secret masquerades as a scheme). FINAL rule: the scheme prefix is a **closed allowlist** `Bearer|Basic|Token` (case-insensitive); everything else must be a bare exact `${VAR}`. `HEADER_VALUE_RE = /^(?:(?:bearer|basic|token) )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/i`. Permits `${KEY}` and `Bearer ${TOKEN}`; rejects `Bearer ${T} sk-live`, `sk-live ${T}`, and multi-ref `${A} ${B}`.
- **[HIGH] prototype pollution / derived-list divergence.** `__proto__`/`constructor`/`prototype` rejected as env + header keys; `env`/`headers` built on `Object.create(null)`. `payload.requiresEnv` is now computed by `mcpRequiredEnv(servers)` from the FINAL validated servers (not a parse-time accumulator) so it provably equals a later recompute.
- **[MEDIUM] header case.** Case-insensitive duplicate detection (`Authorization` + `authorization` rejected); original casing preserved in storage.
- **[LOW] test gaps.** Added: secret-beside-ref + scheme-masquerade bypasses, lowercase auth, `env.__proto__`, multi-ref header, repeated-`mcpRequiredEnv` stability, arg/env/header/string caps, and engine-level `loadPlugin` MCP coverage (MCP-only, invalid `mcp.json`, symlink `mcp.json`, mixed hooks+skills+MCP).

Post-fold: full suite green; tsc ×2 + engine-boundary clean. Confirming codex re-review: **SHIP** (all 4 closed, no new issue).

## Step 2 — planner + per-runtime renderers

- `AdapterSpec.mcpRel` (claude `.mcp.json`, codex `.codex/config.toml`) + `runtimeSupportsMcp` + `McpTarget {runtime, server, ref, destRel}` + `planMcpTargets` (PURE; each server × each present MCP-capable declared runtime, runtime-then-server order; declare-and-skip) — mirrors `planSkillTargets`.
- `renderClaudeMcpEntry(server)` (adapters/claude.ts): neutral → `mcpServers.<name>` value verbatim (stdio `{command,args,env}` / http `{type:"http",url,headers}`, empties dropped); claude expands `${VAR}` itself; merge (Step 3) JSON-encodes safely.
- `renderCodexMcpBlock(server)` (adapters/codex.ts): neutral → `[mcp_servers.<name>]` TOML, every value `tomlStr`-escaped (the real injection guard — a literal `arg` may contain `"`/`\`). http auth maps to codex's STRUCTURED fields (no free-form header string): `Authorization: Bearer ${VAR}` → `bearer_token_env_var`; every other header → `env_http_headers { "Name" = "VAR" }`.

### Step-1 header model refined here (revealed by the codex mapping)

The Step-1 `[Bearer|Basic|Token] ${VAR}` on-any-header rule does NOT map losslessly to codex's structured auth (a scheme prefix on a non-Authorization header, or Basic/Token, has no codex representation). Refined to the lossless-to-BOTH set: **`Bearer ` prefix allowed ONLY on `Authorization`; every other header = bare `${VAR}`** (`AUTH_VALUE_RE` for Authorization, `ENV_REF_RE` otherwise). Still secret-safe. Tests updated (Bearer on a non-auth header / Basic anywhere → rejected). This is a follow-up commit on the (already-shipped, codex-SHIPped) Step 1 — honest iteration surfaced by Step 2.

Files: src/plugins/adapters/{claude,codex}.ts (renderers), src/plugins/engine.ts (planner + mcpRel), src/plugins/mcp.ts (name-aware header rule), test/unit/pluginEngine.test.ts (planner + renderer golden) + pluginMcp.test.ts (name-aware cases).

### Codex Step-2 review (NEEDS-REVISION → folded → re-review pending)

- **[HIGH] codex stdio `env` was wrong.** Rendered `env = { DB_URL = "${DB_URL}" }`, but codex does NOT expand `${VAR}` in `env` (it sets concrete values → the server would receive the literal `${DB_URL}`). codex's indirection is **`env_vars = ["DB_URL"]`** (forward named vars). Fix: (1) `mcp.ts` now requires each env **key == its referenced var** (`v === "${"+k+"}"`); an alias `SERVER_KEY: "${HOST_KEY}"` is rejected (a rename codex `env_vars` can't express). (2) codex renderer emits `env_vars = [<keys>]`; claude renderer keeps `env: {K: "${K}"}` (claude DOES expand). Both forward the same named var → lossless.
- **[LOW] escaper test breadth** — added golden for a unicode arg, hyphenated server name (safe bare key), and multi-key `env_vars` / `env_http_headers`. (Control chars — newline/CR/tab/DEL — can't reach the renderer: `validArg`/`validCommand` reject controls at load, so `tomlStr`'s control-escaping is unreachable-via-loader defense-in-depth.)
- **[LOW] v1 auth limitations — documented.** The lossless-to-both header model intentionally rejects `Authorization: Basic ${VAR}` / `Token ${VAR}` (codex `bearer_token_env_var` is Bearer-only) and a scheme prefix on any non-Authorization header (incl. `Proxy-Authorization: Bearer ${VAR}`). These map to neither runtime's structured field cleanly → follow pass.

Post-fold: full suite 1270 green; tsc ×2 + engine-boundary clean. Confirming codex re-review is the gate before Step 3.
