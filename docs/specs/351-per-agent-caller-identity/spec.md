# 351 — per-agent-caller-identity

_Created 2026-07-04._

**Status:** shipped
**Closure:** shipped 2026-07-04 — digest-only caller registry (HMAC key in SecretStorage, persistence
preserving the no-plaintext invariant + surviving-tmux resolution), per-agent token mint/revoke at
spawn/resume, Bridge per-request caller snapshots with reason codes, actor resolution + mismatch across all
self-identifying tools, self-assign suppression, probe per-run tokens, fenced+logged legacy compat,
diagnostics redaction. Implemented by ad-hoc Sonnet identityB (aaf9b34..286908f, incl. an API-error stall
rescued via the 341 idle queue); suite 2482 green; live dogfood PASS on 0.55.17 (see notes). Follow-up:
t-600324 (dedicated external token).

## Intent

The Bridge authenticates every caller with ONE shared Bearer token, so it cannot tell agents apart: every
self-identifying tool param is self-declared and unverifiable. Task t-d7b3a9 documented one evening of real
damage (guessed parent mis-rooting lineage + completion signal; a reviewer self-naming "codex"; self-assign
suppression unimplementable — 348's known limitation). Layer A (shipped) made identity discoverable; this
spec is **layer B: the Bridge RESOLVES the caller** via per-agent tokens (spec-230 nonce precedent).

Honest posture: env-held tokens are readable by same-user processes — this is **provenance hardening**
(mistakes impossible, casual spoofing becomes deliberate), not a sandbox. The dueto sharpened two systemic
risks the draft missed: the legacy compat path must not become a silent downgrade route, and persistence
must never turn ephemeral bearer secrets into plaintext workspace state.

## Mechanism

- **Mint**: at spawn AND resume, AgentManager mints a per-agent secret injected as
  **`TACHYON_AGENT_BRIDGE_TOKEN`** (dueto F7 — a NEW var; MCP config prefers it and falls back to
  `TACHYON_BRIDGE_TOKEN` for human/legacy, so token KIND is never ambiguous in scripts/logs). Agent tokens
  are **process-session credentials**, not durable helper credentials (dueto F14): child helpers inheriting
  an old token fail with `token_revoked` after restart — no grace period.
- **Registry, digest-only** (dueto F2/F13): the host stores fixed-length HMAC digests (keyed by a
  workspace-local bridge secret) — **plaintext tokens are never persisted**; auth hashes the presented
  Bearer and constant-time-compares digests, with indistinguishable timing/messages for unknown tokens.
  Entries are scoped by **workspace ID + bridge instance ID** (dueto F10) and carry lifecycle state + TTL
  (dueto F9): dismiss revokes immediately, orphans expire after a bounded idle period, non-live agents'
  tokens are rejected outside an allowed resume flow.
- **Resolve**: Bridge auth resolves the Bearer to `{kind: agent|master|legacy, name?}` and threads an
  **immutable caller snapshot** into the per-request `registerTools` deps — validity is checked exactly
  once at authentication; an in-flight request completes on its snapshot even if the token is invalidated
  mid-request, and restart invalidates the old token BEFORE minting the new one (dueto F4, tested
  before/during/after restart).
- **Master ≠ human** (dueto F5): the copied master token resolves to kind **`external`** (optional label).
  `"human"` exists only via an internal host-originated path unavailable to copied tokens (the UI's own
  bridge calls). Neither external nor human may claim an agent identity in self-identifying params.
- **Actor vs subject** (dueto F6): resolved identity governs ACTOR params (sender, author, producer,
  parent-as-spawner). Legitimate on-behalf-of flows use explicit SUBJECT fields (`assignee`, target agent,
  or a tool-specific `onBehalfOf` with its own authorization), audited as "actor → subject" — the model
  never forces real workflows into spoof-shaped params.
- **Legacy compat, fenced** (dueto F1): the legacy shared token is accepted only while an explicit
  compatibility setting is enabled (default ON for existing workspaces during migration, OFF for new
  ones); every legacy-authenticated call is logged with tool + claimed identity; legacy callers may NOT
  claim live agent identities except on a small compatibility allowlist; the retirement path is documented.

## Acceptance criteria

- [x] **Scenario: minted identity + lifecycle** — unique per-agent token at spawn/resume; digest-only
  registry (workspace-scoped, TTL, revoke-on-dismiss, orphan expiry); kill/restart/dismiss invalidates;
  old-token requests before/during/after a restart behave per the snapshot policy (tested)
- [x] **Scenario: resolved caller wins** — omitted actor param → resolved caller; equal → ok; different →
  structured mismatch error naming both; covered for spawn parent, notify sender, create_task/create_pin
  agent, attach_evidence producer, continuity/handoff agent, probe caller
- [x] **Scenario: probes are first-class callers** (dueto F11) — probe runs get per-run tokens scoped to
  parent agent + workspace + run ID; omitted caller resolves to the probe identity; expiry tested
- [x] **Scenario: lineage cannot be mis-rooted** — for agent callers, omitted parent or parent=self roots
  the child at the caller; human/external callers either omit parent (human-rooted child) or use an
  explicit delegated field under authorization (dueto F15)
- [x] **Scenario: self-assign suppression works** — resolved caller X assigning to X fires no notification;
  assigning to a different live agent still notifies (closes 348's known limitation)
- [x] **Scenario: resume proves its env** (dueto F3) — an integration test proves the RESUMED CLI process
  observes the fresh token (covering tmux respawn/new-pane semantics AND a stale-env pane); if env refresh
  proves unreliable, the spec's fallback (token handoff via file/socket or bridge-side rotation) activates
  — resume must not silently strand an agent on a dead token
- [x] **Scenario: legacy is loud, narrow and mortal** (dueto F1) — setting-gated, logged per call, cannot
  claim live agent identities off-allowlist, documented retirement; existing bridge tests pass unchanged
  under the legacy path (behavior parity)
- [x] **Observability** (dueto F12) — stable reason codes on every auth/mismatch failure (`token_unknown`,
  `token_expired`, `token_workspace_mismatch`, `token_revoked`, `caller_mismatch`, `legacy_unvalidated`,
  `master_claim_denied`), tested; the dogfood includes a stale-token resume failure whose UI/log explains
  the rejection without leaking token bytes
- [x] **Redaction** (dueto F8) — Tachyon-generated diagnostics (postmortems, logs, error messages, env
  dumps it produces) redact both token vars, Authorization headers and registry entries; dogfood includes a
  diagnostics review proving it
- [x] Docs updated honestly: "Bridge-resolved when your session carries a per-agent token"; token-kind
  semantics (agent/master/legacy) explained; agent tokens marked identity-bearing (do not copy into shared
  scripts); the same-user residual stays documented
- [x] Tests: registry lifecycle incl. two workspaces with the same agent name and copied env between
  workspaces; resolution + mismatch per tool; reason codes; digest-only storage proven (no plaintext in
  persisted state); constant-time behavior; human/external/master paths
- [ ] Live dogfood: spawned agent calls notify with no param (resolved), right param (ok), wrong param
  (mismatch + reason code); self-assign no-poke; legacy-token call observed in the log

## Non-goals

- Sandboxing / cross-user security (documented residual).
- Per-agent authorization SCOPES (which tools an agent may call) — identity only; scopes are a future spec
  (the 349 plugin action broker wants them — deliberate sequencing).
- Retiring the legacy token in this delivery (the setting + logging land now; the default flip is a
  follow-up).
- Changing the 230 pipeline nonce (this generalizes its idea, not its code).

## Open questions

_All three draft-time forks were resolved by the dueto fold: mismatch is a hard error (with reason codes
and the actor/subject split absorbing legitimate flows); probes get per-run tokens (criterion above);
persistence keeps the no-plaintext-on-disk invariant via digest-only registry. Remaining for plan: the
exact HMAC key custody (workspace-local secret storage) and whether the compatibility allowlist ships empty._
