# 359 — host-action-port — plan

_Drafted 2026-07-05. Scope A (full governed subsystem), ratified. Model: total gate behind a broker +
declarative capability specs + risk-tier ladder, all config-governed (see spec RESOLUTION). PHASED — each
phase independently landable; the security-critical core lands before the mechanism._

_UPDATE (post 2nd dueto, probe-36e62c0a): the declarative model needs an INDEPENDENT SIGNED REGISTRY (source
of truth for effects/risk_tier/semantic types — not the adapter/workspace), host-aware semantic arg types
(resolve-then-authorize), a compound tier + `host_lifecycle_disruptive` effect, the authorizing policy OUT of
the agent's workspace (signed, human-only reload — kills the hot-reload self-grant), and per-invocation/narrow
confinement for dispatchers (not standing grants). RE-SCOPED: Phase 1 = the reload loop (no args → minimal
surface, no registry/semantic-types/dispatcher machinery needed); the heavy security machinery lands in
Phases 2–4, each with its own hardening dueto before impl. Dueto-pending plan items all resolved in the spec's
STRESS DUETO 2 FOLD._

## Approach — phased

### Phase 1 — Host-agnostic CORE domain + broker + capability-spec schema (zero vscode)
The moat piece. No VS Code anywhere.
- Canonical host-neutral domain: `HostActionName`, own args model, error taxonomy, lifecycle states
  (`dispatched | disconnected | reattached_verified | failed_to_return | returned_wrong_host |
  result_unknown`). Architectural test bans `vscode` imports AND host-shaped types AND command-id constants in
  core.
- `HostActionPort` (adapter contract) + `HostActionBroker` (the authority): resolve caller (351), authorize
  per-agent + per-action against the policy snapshot, canonicalize + validate args against the capability
  spec's CLOSED schema, emit the audit envelope BEFORE execution, dispatch to the adapter, record the outcome.
  Default-deny.
- Declarative capability-spec schema `{ command, args.schema (closed), effects[], risk_tier }` + the generic
  validator (reject unknown fields, callbacks, command:/URI schemes, nested commands; size/depth limits;
  Unicode canonicalization; payload hash).
- Independent audit sink: hash chain + fsync-before-execute + monotonic sequence, writer separated from the
  executor. Decision chain logged (`requested_by, delegated_by, policy_version, spec_id, validated_args_hash,
  executor_adapter`).
- Test-double `agent-noop` adapter + CONFORMANCE suite (deny path, malformed args, lifecycle,
  audit-before-execute, adapter-unavailable, timeout, disconnect, policy-mismatch, result_unknown).

### Phase 2 — Policy governance + risk-tier ladder + consent
- Policy store: human-owned, signed/hashed, per-session pinned, visible diff, fail-closed if
  absent/invalid/stale/divergent. The governed agent CANNOT edit the policy that authorizes it (reconcile with
  hot-reload — dueto-pending). Allowlist changes audited separately.
- Risk-tier ladder `bounded | unbounded`; enable is config-driven at every tier; consent strength + audit
  loudness scale with `risk_tier`. Unbounded requires deliberate elevated consent (grant: subject, actions,
  arg constraints, workspace, duration, adapter/policy version, max risk tier, revocation).
- Effect-type classification + who validates it (dueto-pending: source of truth for `effects/risk_tier`).
- Thrashing interlocks: rate limits per agent/action, reload cooldown, circuit breaker, `degraded` state.

### Phase 3 — agent-vscode adapter + the reload transaction
- `agent-vscode`: implements `HostActionPort` via `executeCommand` (adapter-internal, never exposed); a
  minimal stable host shim split from the reloadable plugin part (the shim survives reload/update).
- Reload transaction: `action_id` + reattach identity bundle (`host_instance_id, workspace_id,
  extension_build_id, session_epoch, reattach_nonce`) persisted OUTSIDE the ext host; post-reload health +
  build-version check; broker continues only on full match + pending-action confirmation; `result_unknown`
  surfaced.
- First real capability specs: `reloadWindow` (bounded/lifecycle), open-view (bounded/ui).

### Phase 4 — run_host_action Bridge tool + the dogfood loop
- The `run_host_action` MCP tool (caller = resolved identity, never a param); wires the coordinator's
  install→reload→validate loop unattended.
- Human review surface: "what did the agent do in my host" (audit incl. result_unknown + denied attempts).

## Key decisions
- **Config-driven end-to-end** — chosen because the maintainer requires agility (no build to add/remove/narrow
  an action); rejected per-action hand-coded wrappers because a build per action is unsustainable.
- **Security via a generic broker enforcing declarative specs** — chosen because it gives arg-level safety
  (the 1st dueto's demand) without per-action code; rejected command-id allowlist (security theater — args
  smuggle code).
- **Risk-tier ladder, human dials the reach** — chosen because the agent must not be capped by "was code
  written"; rejected hard-deny-needs-wrapper because it re-introduces the build bottleneck + caps the agent.
- **Broker=authority, adapter=minimal executor** — chosen so a buggy/untrusted adapter can't self-authorize;
  the adapter gets only validated envelopes.

## Files touched (indicative — finalize after the stress dueto)
- `src/host-action/` (NEW, core): domain types, broker, capability-spec schema + validator, audit sink, port.
- `src/host-action/policy/` (NEW): policy store, risk ladder, consent grants.
- the `agent-vscode` adapter (location = the plugin-vs-shell open question) — executeCommand + reload txn.
- Bridge: `run_host_action` tool + `list_commands`-style introspection of enabled actions.
- tests: architectural (no-vscode-in-core), conformance suite, adversarial arg-smuggling.

## Risks & unknowns (mostly dueto-pending)
- Does the closed schema truly bound "bounded" actions, or do some VS Code args have surprising composite
  effects? (stress dueto q1/q2)
- Who is the source of truth for `effects/risk_tier` — a mis-classified dispatcher collapses safety silently.
  (q3/q5)
- Hot-reload config vs signed/pinned/fail-closed policy — the reconciliation. (q4)
- Standing grant vs per-invocation consent for unbounded/dispatcher actions. (q6)

## Sources consulted
spec 359 (intent + dueto fold + RESOLUTION) · [[tachyon-orchestration-moat]] · 349 (action broker) · 351
(identity) · t-f8758f (policy guard) · 358/t-ee7d5f (delegation governance). Tracking task t-38285f.
