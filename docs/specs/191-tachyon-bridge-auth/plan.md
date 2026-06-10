# 191 — tachyon-bridge-auth — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

(1) `src/bridge/token.ts`: loadOrCreateToken(storageDir, wsHash) — 32-byte hex, 0600, stable per workspace; tokenMatches via sha256+timingSafeEqual. (2) Bridge takes `{token}`; POST handler 401s before any MCP processing when the bearer is absent/wrong. (3) Config/schema: settings.auth (default true, resolved in the extension). (4) AgentManager gains getExtraEnv() merged under declared env — extension injects TACHYON_BRIDGE_URL/TOKEN into every spawn/restart. (5) Adapters: expectedClaudeEntry/expectedOpencodeEntry with env-var header refs; codexSnippet bearer_token_env_var; buildOffers(auth) threads upToDate + notes. (6) extension: early config read for auth flag, token resolution from globalStorage, Copy Bridge Token command, auth-change reload hint. Validation pyramid: unit (token/401/injection/adapters) → host integration (raw 401 + clipboard-token pass) → live claude -p E2E proving ${VAR} expansion.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `src/bridge/token.ts`, `test/unit/auth.test.ts`.

**Modify:** `src/bridge/Bridge.ts`, `src/config/loadConfig.ts` + schema, `src/agents/AgentManager.ts` (getExtraEnv), `src/registration/adapters.ts`, `src/extension.ts`, `package.json` (Copy Bridge Token), `test/e2e/bridge-host.ts` (TACHYON_E2E_TOKEN), `test/integration/extension.test.js`, `README.md`, `examples/tachyon.yml`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Literal token written into registered config files

Rejected: .mcp.json/opencode.json are team-committable; a machine-local secret there leaks into git and breaks teammates. Env-var indirection keeps the files shareable.

### Peer-credential auth (SO_PEERCRED / /proc/net/tcp UID matching)

Rejected: SO_PEERCRED needs Unix sockets (MCP clients speak HTTP/TCP); UID matching over /proc only blocks other users — the realistic adversary is same-user, so it adds complexity without moving the real bar.

### Per-boot ephemeral token

Rejected: recreates the registration churn F12 just eliminated; stability is the point.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Claude Code ${VAR}-in-headers expansion has open bug reports (mostly Windows) — live-validated here on WSL with a real claude -p; fallback documented (literal token in a local non-committed config).
- OpenCode {env:VAR} header substitution not live-validated (no opencode session driven) — snippet carries the reference; mcp-remote fallback documented.
- Surviving sessions from before F3 lack the injected env — one ↻ restart per agent after upgrade (dogfood notes this).

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- code.claude.com/docs/en/mcp (env expansion in command/args/env/url/headers); developers.openai.com/codex/config-reference (bearer_token_env_var, http_headers); live E2E this session (claude -p + tokened bridge-host).
