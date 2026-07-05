# 359 — host-action-port — notes

_Created 2026-07-05._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

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
