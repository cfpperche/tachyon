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

Post-fold: full suite green; tsc ×2 + engine-boundary clean. A confirming codex re-review is the gate before Step 2.
