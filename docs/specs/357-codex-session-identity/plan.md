# 357 — codex-session-identity — plan

_Drafted 2026-07-05 after the T0 spike RESOLVED the design. Codex respects CODEX_HOME for its session root
(verified). The mechanism: give every codex instance a private, lifetime-scoped CODEX_HOME so rollouts are
physically isolated — no cwd collision, no resolve-then-lock race, no fail-closed needed._

## Approach

1. **Private codex home is the DEFAULT, auto-provisioned per agent lifetime** — reuse the spec-240
   `HarnessManager.materializeHomeOnly` path but make it automatic for codex agents (not only when
   `isolate: transcript` is set). The home is keyed to the agent's ledger lifetime (created on create/first
   spawn, reused on resume, deleted on removal).
2. **Fix the auth seed gap** — `seedCodexHomeOnlyConfig` must ALSO carry `auth.json` (copy or symlink from
   the real `~/.codex`), not just `config.toml`. Without it the isolated codex 401s (spike-confirmed).
   Consider symlink so re-auth in the real home propagates.
3. **Scope session resolution to the private home** — `resolveCaptureId`/`resolveCaptureSession` for codex
   read only `<CODEX_HOME>/sessions` (they already accept `configHome`); with exactly one rollout there, the
   "newest by cwd" ambiguity is gone. Lock `resume.sessionId` to that rollout's uuid (fixes t-ff6429).
4. **Removal deletes the private home** — wire into the same removal path as deleteActivityLog (t-d3f62b) +
   session-owners prune (t-123143): agent removal clears the private CODEX_HOME too. One lifecycle.
5. **Resume re-binds** — since the home persists across stop/resume, resume finds the agent's own rollout in
   its private home (append or codex successor). No cwd/newest fallback.

## Key decisions
- Physical isolation (private home) over correlator/heuristic — the spike proved it works and it dissolves
  the race + concurrency blockers by construction.
- Lifetime-scoped (not per-session, not per-name-forever): created→removed. A reused name post-removal gets a
  fresh home → clean (the resurrection fix).
- Default-on for codex — the maintainer wants the DEFAULT fixed; auto-provisioning the private home is that
  fix. isolate:transcript becomes redundant-but-harmless (same mechanism).

## Files touched
- src/harness/HarnessManager.ts (seedCodexHomeOnlyConfig: carry auth.json; materializeHomeOnly reuse).
- src/workspace/Workspace.ts (auto-provision private home for codex by default, not only isolate:transcript;
  wire removal to delete the home).
- src/agents/AgentManager.ts (resolveCapture* scope to the private home; lock resume.sessionId).
- Tests: filesystem-observing (rollout lands in private home, not global ~/.codex; auth carried; removal
  deletes home; reused name → fresh home → empty activity; concurrent two-codex → distinct homes).

## Risks
- Disk/setup cost per codex spawn (a home dir each) — mitigate with symlinks for auth/config, real files only
  for sessions.
- Existing declared codex agents (codex, codex-2) MIGRATE to private homes — ensure their in-flight sessions
  aren't orphaned on the switch (a one-time transition; test resume across the change).
- The auth symlink vs copy tradeoff (re-auth propagation) — decide in impl.

## Sources
T0 spike (CODEX_HOME redirect verified) · HarnessManager.materializeHomeOnly/seedCodexHomeOnlyConfig ·
Workspace.ts:341-343 (spec 240 isolate:transcript) · loadConfig CODEX_HOME · the dueto (probe-55ef12d7) ·
t-8f2f5b/t-ff6429/t-d3f62b/t-123143 (the cluster this closes).
