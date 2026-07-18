# Plan — 408 Pi OAuth coordination

## Affected Product Invariants

None. This changes runtime credential plumbing while preserving PI-001's default-deny Bridge boundary and the established private-home isolation contract.

## Design

### 1. Upstream Pi contract

Add `ENV_AUTH_FILE` / `getAuthPath()` support for `${APP_NAME}_CODING_AGENT_AUTH_FILE` (normally `PI_CODING_AGENT_AUTH_FILE`). The value is expanded with Pi's normal path normalization. With no override, `getAuthPath()` remains `<getAgentDir()>/auth.json`.

Thread an explicit `authPath` through agent-session service and SDK construction. CLI-owned paths—including ordinary runtime creation, package-command model-catalog refresh, auth migration targeting, login/logout status text, and default `AuthStorage` helpers—must resolve through the same contract. Explicit `modelRuntime`/credential-store injection remains highest precedence.

An explicit external auth file must not silently consume/move legacy `oauth.json` or `settings.json.apiKeys` from a different private agent directory. Legacy migration remains scoped to the default auth path; the external authority is created by normal credential storage/login when needed.

### 2. Upstream proof

Add path-resolution and construction tests. Add a concurrency test using two runtimes/stores rooted in distinct agent directories but one shared auth file and a rotating refresh fixture. Assert one refresh callback, one replacement record, and convergence without logging secrets.

Prepare the upstream change on a dedicated branch/commit and export a reviewable patch pointer. Do not push, merge, or publish without explicit human authorization.

### 3. Tachyon integration after an upstream release exists

Inject the official auth-file environment variable for Pi only. Its value is the canonical real Pi `auth.json` path already used as the seed source. Keep `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` private per agent. Do not symlink or reconcile private credential copies.

At materialization, validate an existing canonical auth path no-follow as a regular readable JSON object; absence remains allowed for environment-only auth. The environment key is Tachyon-owned/reserved and cannot be overridden by agent config. Require a Pi version that includes the contract; older Pi must fail preflight rather than ignore the variable and reintroduce split lock domains.

Once the shared path is active, stop seeding `auth.json` into new Pi private homes. Existing private files may be retained as inert compatibility data but are never selected while the override is active; canonical cleanup must not delete the user auth authority.

### 4. Verification and dogfood

Run focused upstream tests and typecheck, then Tachyon unit/integration tests and typecheck. Dogfood two Pi processes with distinct private homes and one disposable shared expired OAuth fixture/provider so both request auth concurrently and only one refresh exchange is counted. Capture only structural counters and redacted metadata.

Run Tachyon `npm run verify:full:quiet` and classify pre-existing baseline failures separately. Obtain explicit authorization before any upstream push and again before Tachyon integration/merge if required by repository governance.

## Failure behavior

- Malformed, non-object, symlinked, or special canonical auth files refuse launch without exposing content.
- Unsupported Pi versions refuse launch; there is no fallback to copied private OAuth files.
- Pi's shared-store lock acquisition/refresh failures surface normally and never fall back to another credential source.
- Missing explicit auth files remain creatable by Pi under its normal 0600/parent-directory contract; Tachyon itself does not create one for environment-only auth.
