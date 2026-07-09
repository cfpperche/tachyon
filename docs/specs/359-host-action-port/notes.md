# 359 — host-action-port — notes

_Created 2026-07-05._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **2026-07-09 — agent grant is `*`, not a Claude-only name list.** P1 pinned
  `allowedAgents: ["claude"]`, which blocked every other runtime (grok/codex/…) from
  `run_host_action("reloadWindow")` even with a valid Bridge agent token. That contradicted
  the product rule (capability parity via each CLI's native path) and the 359 non-goal that
  deferred per-agent scoping beyond the global action enablement. Fix: pinned policy
  `reload-window-v2` uses `allowedAgents: ["*"]` — any **resolved agent principal**
  (`kind: "agent"` + name from Bridge identity) is authorized; legacy/master tokens stay
  denied. Explicit name lists remain for tests. Human authorization remains the
  out-of-workspace hash-pinned policy (fail-closed on drift), not a runtime-name allowlist.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dueto disposition (probe 140c82b8) — codex adversarial security review
16 findings, 5 BLOCKERS, ALL accepted (nothing rebutted — the security analysis was correct). Central:
command-id allowlist = security theater; executeCommand is a broad dispatcher → the generic port is a
privilege-escalation API for unattended agents. CENTRAL REFRAME folded: NO generic executeCommand / command-id
allowlist — only purpose-built per-action WRAPPERS (reloadWindow, openView) with closed schemas + effects +
adversarial tests; executeCommand is adapter-internal, never exposed. Also folded: broker=authority /
adapter=minimal-untrusted-executor (per-agent+per-action authz in core, validated envelope only to adapter);
consent = explicit versioned grant, fail-closed; allowlist = human-owned root capability, signed/pinned/
fail-closed, un-editable by the governed agent; reload = async txn checkpointed OUTSIDE the ext host
(host_instance_id/build_id/session_epoch/reattach_nonce + health+build check), result_unknown as a dangerous
first-class state; audit = independent sink (hash chain + fsync-before-execute, separate from executor);
args canonicalized + effect-type classification; host-agnostic boundary = a canonical domain + conformance
tests, not just a no-vscode-import lint; thrashing interlocks (rate limit/circuit breaker/degraded).
SCOPE TENSION surfaced to maintainer: (A) full governed subsystem vs (B) minimal slice (one reloadWindow
wrapper + external checkpoint + independent audit, defer the general framework). Awaiting ratification +
the A-vs-B call.

## Stress dueto 2 disposition (probe 36e62c0a) — declarative+ladder model
6 BLOCKERS, all accepted. Core: declarative model shifts trust to labels/schemas without proving real host
semantics. Folded: (1) classification = SIGNED INDEPENDENT REGISTRY (not adapter/workspace); config enables
from the signed catalog (agility preserved), new commands need a signed classification step; unknown =
unbounded-by-default. (2) closed JSON schema insufficient → host-aware SEMANTIC TYPES + resolve-then-authorize
(authorize the resolved identifier); capability-bearing refs = dispatcher-indirect. (3) bounded/unbounded is a
spectrum → add compound tier + host_lifecycle_disruptive effect (reload always needs external checkpoint +
separate consent). (4) authorizing policy OUTSIDE the agent workspace, signed, human-only reload, hash-pinned,
fail-closed on change (kills the hot-reload self-grant vector). (5) dispatchers = per-invocation/narrow
break-glass + preventive controls (sandbox/quota/timeout/kill-switch), NOT standing grants + audit; grants
principal-scoped (identity/delegation/task/version/expiration), reconciles t-f8758f/351. (6) audit = decision
+ observation (host-state fingerprint, activation events, result_unknown). RE-SCOPING: full model is a large
security subsystem, but reloadWindow (no args) needs only broker skeleton + external checkpoint + audit +
signed out-of-workspace policy — Phase 1 ships the reload loop on the minimal surface; registry/semantic-types
/dispatcher-confinement land in later phases (each with its own dueto) when an arg-bearing/dispatcher action
is wanted.
