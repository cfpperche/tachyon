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

Post-fold: full suite 1270 green; tsc ×2 + engine-boundary clean. Confirming codex re-review: **SHIP**.

## Step 3 — shared escaping-safe writer + Bridge regression pinned

- **Pinned the Bridge first** (codex #9): `test/unit/adapters.test.ts` already fixed stale-port overwrite, other-server preservation, idempotent byte-stability, targeted TOML-block edit, `codexAlreadyRegistered`. Kept verbatim as the regression net (15 tests, all green post-refactor).
- **Generalized `src/registration/adapters.ts` IN-PLACE** into ONE server-name-generic writer (codex #5, D6) — the Bridge funcs now DELEGATE:
  - claude: `setClaudeMcpServer(existing,name,entry)` / `removeClaudeMcpServer` / `claudeMcpServerMatches` (+ `parseClaudeRoot`/`claudeServersOf` helpers). `buildClaudeMcpJson`/`claudeAlreadyRegistered` = these with `"tachyon"`.
  - codex: `codexMcpServerRange(text,name)` (name regex-escaped) / `setCodexMcpServer(existing,name,block)` / `removeCodexMcpServer`. `buildCodexToml` = `setCodexMcpServer(…,"tachyon",codexTachyonBlock(…))`. The merge/targeted-range/append logic is now in the generic fn; the Bridge block builder is unchanged.
  - Escaping: claude via `JSON.stringify` (safe); codex VALUE-escaping is the plugin renderer's `tomlStr` (Step 2); the writer only places the pre-built block by name (name is kebab-validated + regex-escaped).
- Placement: kept in `registration/adapters.ts` (the pure, no-vscode MCP-config module) so there's ONE writer; the Step-4 engine imports these generics. Bridge public API (buildOffers/build*/＊AlreadyRegistered) unchanged → its 15 tests stay green.
- removal paths (`removeClaudeMcpServer`/`removeCodexMcpServer`) added now (the Bridge never removes; the plugin path in Step 4 does) — byte-stable no-op when the server is absent.
- Tests: +5 generic-writer cases (arbitrary/hyphenated name, merge/replace/remove, idempotency, byte-stable no-op) alongside the 15 Bridge pins.

### Codex Step-3 review (SHIP-WITH-CHANGES → folded)

Bridge byte-for-byte equivalence CONFIRMED for tachyon+http/url+auth across all delegates; no name interpolated unescaped into a header. Folded:
- **[MEDIUM] `removeClaudeMcpServer` used `name in servers`** → a valid kebab name on the prototype chain (`constructor`) read as present, breaking the byte-stable absent no-op. Fixed → `Object.hasOwn`. Regression tests added (absent `constructor` → no-op; own `constructor` → removable).
- **[LOW] codex replace-at-EOF dropped the trailing newline** (inherited from the old `buildCodexToml`) → not byte-stable on repeat. Fixed `setCodexMcpServer` to re-add a terminating newline → repeated set is now byte-stable + the file keeps a final newline. Bridge replace test (block followed by another table) unaffected. Exact-string idempotency test added.

Post-fold: full suite 1277 green; tsc ×2 + engine-boundary clean. Step 3 ready to commit. Committed `a39b3a5`.

## Step 4 — engine mcp-server install/remove I/O

Mirrors the skills path (collision→fingerprint→fail-closed Keep/Replace) but uses HOOKS-style content-aware removal (an MCP entry is config, not a wholesale dir — closer to a hook group).

- **previewInstall:** `mcpTargets: McpPlanItem[]` (planMcpTargets + per-target `collision`). collision = the server NAME is present in the runtime's MCP config AND is not one of THIS plugin's prior `mcp-server` targets (keyed `runtime|file|ref`). The config is read once per file (cached). Bound into `fingerprintOf` (rendered entry + collision) so a payload edit or a collision flip invalidates consent.
- **applyInstall(`{mcpDecisions}`):** validate prior mcp-server targets (`validMcpDest`); resolve collisions (undecided → FAIL-CLOSED; keep → skip+don't record; replace/clean → write). Record `mcp-server` lockfile targets: `ref`=server name, `removal`=the rendered entry (claude object) / block (codex string). WRITE step 6 (after payload→lockfile→settings→skills): per runtime config, content-aware stale-cleanup of our prior servers the new version dropped, then merge each consented server (render Step-2 → Step-3 writer), write once; `writeMcpConfig` deletes a file that reduces to empty/`{}`.
- **applyRemove:** content-aware un-merge — remove a recorded server ONLY if the on-disk entry still equals `removal`; an edited one is LEFT and counted as an orphan (never clobbered). `removeFingerprint` + `RemovePreview.mcpCount` extended. `planRemove` validates mcp-server targets (validMcpDest + ref) fail-closed.
- **applyUpdate:** forwards `mcpDecisions` to applyInstall; previewUpdate already flows mcpTargets via previewInstall.
- `validMcpDest(rt,file)` = file === ADAPTERS[rt].mcpRel (mirror validSkillDest) — a corrupted lockfile can't touch an arbitrary file (test: target file forged to `package.json` → fail-closed).
- Tests (+6, pluginEngine.test.ts): install→both configs+lockfile targets→remove un-merges; preserve a user server across install+remove; collision undecided/Keep/Replace; content-aware orphan on user-edit; update stale-cleanup; corrupted-target fail-closed.

Post: full suite 1283 green; tsc ×2 + engine-boundary clean.

### Codex Step-4 review (BLOCK → folded → re-review pending)

The predicted security round. All folded:
- **[BLOCKER] no lost-update guard for MCP configs.** Added `McpConfigSnapshot` (per-dest text at preview) to InstallPreview + bound into the fingerprint (so a config change since consent invalidates it) AND a `settingsUnchanged`-style same-text check immediately before the step-6 write. The per-target `current` on-disk entry is also bound into the fingerprint.
- **[HIGH] prior-owned trusted the lockfile too much.** Ownership is now proven by CONTENT: a server is "ours" (collision suppressed) only if a prior mcp-server target records it AND `currentMcp == recorded removal`. Prior targets validated fail-closed in previewInstall (validMcpDest + ref kebab regex). A forged target with a valid path but mismatched content no longer grants overwrite (test added).
- **[HIGH] fail-open config reads.** New `readMcpConfig` (mirrors readSettings): absent → undefined; unreadable or invalid-JSON claude config → ERROR (never "absent"). Used in previewInstall (surfaces errors) and the step-6 write (fail-closed); the merge/remove/write is now inside the recoverable partial-install catch (a `setMcpServer` throw no longer escapes after payload+lockfile recorded).
- **[MEDIUM] remove fingerprint ignored MCP state.** `removeFingerprint` now binds each target's CURRENT on-disk rep (via `currentMcpReps`, fail-closed); previewRemove + applyRemove compute it, so a same-name server appearing/changing since the remove preview invalidates consent. (Content-aware removal already guards the write: a changed server ≠ removal → left as orphan.)
- **[LOW] tests.** +5: install lost-update refuse, broken-`.mcp.json` fail-closed, forged-prior-target content mismatch ⇒ collision, codex content-aware remove preserving `model=`/other tables. Confirmed non-findings: writeMcpConfig only deletes a trim-empty/`{}` husk; codex block removal preserves other TOML; applyUpdate forwards mcpDecisions.

Post-fold: full suite 1288 green; tsc ×2 + engine-boundary clean.

### Confirming codex re-review (NEEDS-REVISION → dispositioned)

BLOCKER + 2 of 3 HIGH/MEDIUM confirmed CLOSED. Two items dispositioned:
- **#2 [HIGH] — forged lockfile whose `removal` is copied from the user's CURRENT entry can suppress a collision.** Folded the actionable part: `validMcpRemoval` rejects a malformed/garbage `removal` (claude: a plain object; codex: a `[mcp_servers.<ref>]`-headed string) in previewInstall/applyInstall/planRemove. **The residual (a removal forged to equal the user's exact current entry) is an ACCEPTED trust boundary, not a Step-4 defect:** it is the same lockfile-ownership trust skills (`priorSkillDests`) and hooks (recorded `removal` groups) already rely on — codex itself noted (#4) it "remains the same open issue," i.e. systemic. Forging `.tachyon/plugins.lock.json` requires the same workspace-write access as editing `.mcp.json`/`config.toml` directly, so it grants NO escalation. The Step-5 consent drawer additionally surfaces every MCP server being written (incl. a suppressed-as-ours one) behind the double-confirm, so the user sees it before any write. A stronger guarantee would need a signed/external-trust lockfile (out of scope).
- **#6 [NEW MEDIUM] — the webview can't resolve MCP collisions yet (no `mcpDecisions` from the drawer).** This is exactly **Step 5's scope** (consent VM + drawer MCP section + thread mcpDecisions). Until then MCP collisions FAIL CLOSED (safe — install refuses, never silently clobbers). Not a Step-4 defect; Step 5 closes it.

Decision: commit Step 4 (engine I/O is sound + the actionable hardening is folded); the two dispositioned items are an accepted systemic boundary + Step-5 work. Suite 1288 green.
