# 351 — per-agent-caller-identity — plan

_Drafted 2026-07-04 (post-dueto, 15 findings folded). Implementation delegated; this is the implementer map.
The spec's Mechanism section is deliberately prescriptive — treat it as the design; this plan adds file
geography, sequencing and risk control._

## Approach

1. **`src/bridge/callerIdentity.ts` (new, the core)** — digest-only registry + resolution:
   `mint(agentName, {workspaceId, bridgeInstanceId})` returns the plaintext token ONCE (never stored);
   registry keeps `{digestHex, name, kind, workspaceId, instanceId, state, mintedAt, lastSeenAt}` where
   `digest = HMAC-SHA256(bridgeLocalKey, token)`. `resolve(bearer)` hashes and constant-time-compares
   against candidates, returns an immutable `CallerSnapshot {kind: agent|master|legacy|external, name?}`
   plus reason-code failures (`token_unknown|token_expired|token_workspace_mismatch|token_revoked`).
   Lifecycle: `revoke(name)`, TTL sweep for orphans, restart = revoke-old-then-mint-new (ordering tested).
   HMAC key custody: VS Code `SecretStorage` (context.secrets) — machine-local, not in workspaceState, not
   synced; digests may persist in workspaceState (they are non-reversible without the key).
2. **AgentManager** — mint at spawn + resume, inject `TACHYON_AGENT_BRIDGE_TOKEN`; revoke on
   kill/dismiss; the MCP config template prefers the new var with fallback to `TACHYON_BRIDGE_TOKEN`.
3. **Bridge.ts** — the auth block resolves the Bearer (master token → kind external; legacy shared token →
   kind legacy IF the compat setting is on, else 401 `legacy_unvalidated`); threads the snapshot into
   `registerTools(mcp, {...deps, caller})`. Legacy calls log tool + claimed identity fields.
4. **tools.ts** — a small `resolveActor(caller, declaredParam, toolName)` helper implements
   omitted→caller / equal→ok / different→`caller_mismatch` (with `master_claim_denied` for
   external/human claiming agents), applied to: spawn parent, notify sender, create_task/create_pin agent,
   attach_evidence producer, continuity/handoff agent, probe caller. update_task gains self-assign
   suppression via the snapshot. Legacy snapshot (kind legacy) bypasses validation verbatim (parity).
5. **ProbeService** — per-run tokens minted through the same registry (kind agent, name scoped like
   `probe:<runId>` attributed to the parent), expiring with the run.
6. **Resume env proof** — integration test in the tmux harness: resume an agent, assert the resumed
   process env carries the NEW token and a bridge call authenticates; cover the stale-pane case. If the
   harness shows env cannot refresh on some path, implement the fallback (token handoff file under
   .tachyon/ with 0600 + immediate consume-and-delete) — decision recorded in notes.
7. **Redaction** — audit Tachyon-generated diagnostics (postmortem capture, error messages, logs) for both
   token vars/Authorization; add redaction where produced; test with a fake token in env.

## Sequencing (tasks.md T1..T7 mirror this)

T1 callerIdentity core + tests → T2 AgentManager mint/revoke + env var + MCP config → T3 Bridge resolution
+ legacy fence + reason codes → T4 tools.ts actor resolution + self-assign suppression + per-tool tests →
T5 probe tokens → T6 resume integration proof (+ fallback if needed) → T7 redaction + docs + full suite.

## Key decisions

- SecretStorage for the HMAC key (machine-local, survives reloads, never synced) — rejected workspaceState
  for the key (synced/backed up) and rejected re-mint-on-reload (would 401 surviving tmux sessions, the
  t-2d3580 normal).
- Compatibility allowlist ships EMPTY (spec open question resolved: no legacy identity claims at all).
- Reason codes are API: stable strings, documented in the tool error text.

## Risks

- The resume env question (T6) is genuinely open — the fallback is designed, not hoped for.
- tools.ts is HOT (348/341 logic): actor resolution must wrap, not rewrite, existing handlers.
- Multi-workspace: workspaceId scoping tested with two workspaces same-name agents.

## Sources consulted

spec 351 post-dueto + notes disposition · Bridge.ts auth block · AgentManager spawn/resume env (:579,
:1224) · completeNode.ts (230 nonce, constant-time compare) · 348 known-limitation note · probe-98faf4db.
