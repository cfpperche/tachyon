# 359 — host-action-port — tasks

_Generated from `plan.md` (2026-07-05, after 2 hardening duetos). PHASED. Phase 1 (the reload loop, minimal
security surface — no args) is implementable now. Phases 2–4 (registry, semantic types, dispatcher
confinement) are DESIGN-FIRST — each gets its own hardening dueto before implementation, because the 2nd
dueto proved they are a serious security subsystem, not config._

## Phase 1 — reload loop on the minimal surface (IMPLEMENTABLE)

Scope: the host-agnostic core skeleton + the single `reloadWindow` action (no args →
`host_lifecycle_disruptive`, needs the external checkpoint but NOT the registry/semantic-types/dispatcher
machinery). Closes the install→reload→validate dogfood loop safely.

- [ ] `src/host-action/` core (ZERO vscode): `HostActionName`, args model, error taxonomy, lifecycle states
      (`dispatched|disconnected|reattached_verified|failed_to_return|returned_wrong_host|result_unknown`).
      Architectural test bans vscode imports + host-shaped types + command-id constants in core.
- [ ] `HostActionBroker` (authority): resolve caller (351) → authorize against a signed policy snapshot →
      emit audit envelope (hash chain + fsync-BEFORE execute) → dispatch to the adapter → record outcome.
      Default-deny. For v1 the only enabled action is `reloadWindow`.
- [ ] Signed policy store OUTSIDE the agent workspace (not a hot-editable workspace file): human-signed,
      hash-pinned; each authorization records `policy_hash` + `descriptor_hash`; change → fail-closed.
- [ ] `host_lifecycle_disruptive` effect + the reload TRANSACTION: persist `action_id` + reattach bundle
      (`host_instance_id, workspace_id, extension_build_id, session_epoch, reattach_nonce`) OUTSIDE the ext
      host; post-reload health + build-version check; continue only on full match + pending-action confirm;
      `result_unknown` as a first-class surfaced state.
- [ ] `agent-vscode` adapter (minimal executor): implements the port; `reloadWindow` via
      `vscode.commands.executeCommand` (adapter-internal, never exposed); receives only a broker-signed
      envelope, cannot choose a command outside it. Split a stable host shim from the reloadable part.
- [ ] `run_host_action` Bridge tool (caller = resolved identity, never a param); wires the coordinator's
      install→reload→validate loop.
- [ ] Rate limit / cooldown on reload + a `degraded` state after repeated `result_unknown`.
- [ ] Test-double `agent-noop` adapter + CONFORMANCE suite (deny path, audit-before-execute,
      adapter-unavailable, timeout, disconnect, policy-mismatch, result_unknown).

## Phase 2 — signed classification registry + supply chain (DESIGN-FIRST → dueto before impl)
Independent signed registry as the source of truth for `effects/risk_tier/semantic arg types`; descriptor
supply chain (owner/review/sign/provenance/revocation); workspace-originated descriptors denied; unknown =
unbounded-by-default; config enables from the signed catalog.

## Phase 3 — host-aware semantic arg types + resolve-then-authorize (DESIGN-FIRST → dueto before impl)
`SafeFilePath/NonCommandUri/ViewIdLiteralFromEnum/NoRemoteAuthority/…`; canonicalize+resolve at the boundary,
authorize the resolved identifier; `dispatcher-indirect` fields bind to pre-approved entities. Unlocks the
first ARG-bearing actions (open-view, open-file).

## Phase 4 — risk ladder tiers + dispatcher confinement + principal-scoped grants (DESIGN-FIRST → dueto before impl)
`bounded|compound|unbounded` tiers; dispatchers = per-invocation/break-glass + preventive controls
(sandbox/quota/timeout/kill-switch); grants principal-scoped (identity/delegation/task/version/expiration);
audit = decision + observation (host-state fingerprint, activation events). Reconciles t-f8758f/351.

## Verification (Phase 1)
- [ ] Core has zero vscode imports / host-shaped types / command-id constants (architectural test green).
- [ ] `run_host_action("reloadWindow")` reloads with the new build; audited (caller, hashes, outcome);
      coordinator re-attaches; a wrong-host/failed-return path yields `result_unknown`, never false success.
- [ ] A non-enabled action is denied + audited; nothing executes (default-deny).
- [ ] The `agent-noop` conformance suite passes; the adapter cannot execute outside a broker-signed envelope.

**Verify:** `npm test`

## Dogfood
**Dogfood:** the coordinator installs a VSIX then calls `run_host_action("reloadWindow")` and confirms the new
build is live post-reattach (the exact loop this spec exists to close).

**Human dogfood:** maintainer watches a coordinator install+reload happen with no manual reload, and reviews
the host-action audit entry.

## Visual QA
**Visual QA Opt-Out:** Phase 1 is a Bridge/host-action mechanism with no rendered surface (the audit-review UI
is a later phase).
