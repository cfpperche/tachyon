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

## P2 DESIGN DETAIL — folded from p2Design proposal (2026-07-06, full text in task t-38285f journal)

_Supersedes the P2–P4 stubs above. Security-conservative operationalization of the 2nd dueto's requirements.
DESIGN-FIRST — awaiting maintainer ratification (esp. the 7 questions below) before ANY P2 implementation.
Core thesis: P2 exists only for ARG-BEARING and DISPATCHER actions; P1 (reload, no args) already ships. The
security line: descriptor/workspace/adapter must NOT declare their own security — the broker derives it from
an independent SIGNED registry + host-semantic arg resolution before authorizing._

**The 9 slices:**
1. **Signed classification registry** (trust root, independent of the enablement policy): source of truth for
   command identity, allowed semantic arg types, effects, risk_tier, dispatcher flags, host/version
   constraints, provenance, owner/reviewer, registry version, classification hash, revocation. The human
   policy only ENABLES from valid classification ids; descriptor/policy can't override effects/risk_tier/
   semantic types. Unknown/absent/revoked/bad-signature → unbounded-by-default + denied for standing grants.
   reloadWindow migrates to a builtin/pinned classification. Broker audit adds registry_version/
   classification_id/classification_hash/revocation.
2. **Supply chain** — three separated artifacts: signed classification registry (trust root) / human
   enablement policy (what this user/workspace allows) / principal grants (who may use it, how long, which
   args/context). Workspace-originated descriptors DENIED. Metadata: owner/reviewer/signed_at/signer-key/
   provenance/adapter-version-range/revocation. Fail-safe: valid policy + invalid registry = deny; valid
   registry + absent policy = deny; policy → stale/revoked classification hash = deny.
3. **Semantic type system (host-aware)** — closed schema gains per-field `semanticType`, but the SEMANTICS
   come from the registry, not the local descriptor. Types: SafeFilePath, WorkspaceRelativePath,
   NonCommandUri, NoRemoteAuthorityUri, ViewIdLiteralFromEnum, ExtensionIdFromRegistry,
   TaskLabelFromResolvedTasks, LaunchConfigNameFromResolvedLaunches, CommandIdFromSignedRegistry, etc. Each
   has a resolver: raw → resolved canonical identity → discovered risk/effects → authorization target.
   **Authorize the RESOLVED identity, never the raw string.** Any field without a semantic model / with
   provider-activation / remote-authority / command-URI / task-launch-extension indirection → dispatcher-
   indirect/compound or unbounded.
4. **Resolve-then-authorize pipeline** (broker): parse/canonicalize → validate closed schema → semantic
   resolve via adapter host-state resolver → derive resolvedArgsHash/effects → registry reconciliation →
   policy/grant authorization → audit-before-execute → dispatch. The adapter stays an untrusted executor but
   gains a resolution/observation interface returning host-aware facts (auditable, timeout-bounded). Envelope
   carries canonicalArgs + resolvedArgs + resolvedArgsHash + classificationHash + grantId (so a re-interpreting
   executor can't be invisible). host_state_fingerprint invalidates the decision if it changes before dispatch.
5. **Principal-scoped grants + consent tiers**: grant = {subject agent identity, delegation chain,
   workspace_id, task_id, classification_id, policy_version, registry_version, hash, expiry, max risk tier,
   optional concrete-args-hash, allowed resolved targets, revocation}. bounded → standing grant OK
   (deterministic/no-activation/enum-only); compound → narrow grant per resolved target + short expiry +
   mandatory observation; unbounded/dispatcher → NO standing grant, per-invocation/narrow break-glass with
   concrete-args-hash + timeout/quota/cwd/env/network/file boundaries + kill switch. Global enable only makes
   an action ELIGIBLE; the principal grant authorizes the concrete call.
6. **Dispatcher confinement** — runTask/terminal/launch-debug/extension-commands/command-URI/URI-handlers/
   custom-editors = dispatchers. Require pre-resolved binding to an approved entity (task-def hash, launch
   hash, ext id+version+publisher, handler id+owner, fixed cwd/env). Audit marks reaches_code/unbounded; an
   enum of NAMES doesn't hide arbitrary execution (enum restricts which entity, not what it does). Dispatcher
   without sufficient observation → result_unknown or denied, never silent success.
7. **Audit decision + observation** — keep P1 fsync-before-execute; add observation events
   (host_state_fingerprint, provider/handler chosen, activation events, files touched, process/task receipt,
   reload/disconnect receipt, timeout/kill result, result_unknown reason). Compound actions return ok ONLY if
   observation satisfies expected effects, else ok:false result_unknown. Redact/hash sensitive fields but keep
   canonical hashes for correlation.
8. **Adapter conformance P2** — suite for registry invalid/revoked/unknown, descriptor self-label ignored,
   workspace-originated denied, resolver-unresolved, symlink escape, remote URI, command URI, provider
   activation, policy/registry hash drift, grant expiry, concrete-args mismatch, dispatcher standing-grant
   denied, break-glass scoped success, missing observation → result_unknown. Reinforce the architectural test
   (no vscode imports / no host command-id constants in core).

**Implementation order:** P2.1 signed-registry types+loader+verifier (read-only integration, no new arg
actions) → P2.2 principal-scoped grants + deny-by-default for compound/unbounded (reload keeps working) →
P2.3 semantic-type framework + generic/test-double resolvers (no real dispatcher) → P2.4 FIRST arg-bearing
bounded action (openView with ViewIdLiteralFromEnum from registry — proves resolve-then-authorize without
reaches_code) → P2.5 observability + result_unknown for compound → P2.6 first dispatcher under narrow
break-glass, WITH its own dueto before implementing.

**7 QUESTIONS FOR THE MAINTAINER (ratification — these are yours, not the design's):**
1. Registry signing format/authority — key embedded in the build, local trust store, or a versioned bundle
   signed by the maintainer?
2. Unknown/unclassified command — allow human per-invocation break-glass, or hard-deny until a signed
   classification exists?
3. Where does the protected registry/policy/grants storage live per host, and what REAL guarantee do we have
   that agents can't write it? (P1's answer was source-pinned hash; P2 needs more.)
4. Registry distributed WITH the product or updatable via a data channel? If updatable — revocation/offline/
   stale flow?
5. Which observations are actually feasible in VS Code without a FALSE sense of confinement? For the
   non-observable, is the default result_unknown?
6. Is openView really bounded? (Opening a view can activate a provider/webview/extension → maybe start it as
   compound until registry+host-state prove otherwise.)
7. For task/debug/terminal — the minimum mandatory preventive controls before ANY unattended dogfood: fixed
   cwd/env, timeout, network/file sandbox, human per-invocation, kill switch?

**Conclusion:** P2 is NOT "add more schemas to capability.ts." The next safe rung is the external trust root
(signed registry) + principal-scoped grants + semantic resolve-then-authorize. Only after that does an
arg-bearing action make sense; dispatchers wait for break-glass/confinement + a fresh dueto.
