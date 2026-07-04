# 351 — per-agent-caller-identity — notes

_Created 2026-07-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-04, runId probe-98faf4db)

15 findings (3 blockers), spec inline per the probe-sandbox rule. ALL ACCEPTED — in an auth spec the probe's
strictness IS the deliverable:
- F1 (BLOCKER): legacy compat was a silent downgrade path — now setting-gated, per-call logged, barred from
  claiming live agent identities, with a documented retirement. "Compatibility" and "bypass" are different
  words for the same thing unless fenced.
- F2+F13 (BLOCKER): my leaning to persist the registry in workspaceState would have put plaintext bearer
  secrets on disk — replaced with digest-only persistence (HMAC keyed by a workspace-local secret),
  preserving the existing no-secret-on-disk invariant.
- F3 (BLOCKER): mint-at-resume assumed tmux delivers fresh env — now requires an integration proof, with a
  fallback protocol (handoff file/socket or rotation) if env refresh is unreliable.
- F4: in-flight snapshot policy stated + tested. F5: master token = kind "external", human only via
  host-internal path — copied tokens can never masquerade as the human. F6: actor/subject split so
  on-behalf-of flows don't get forced into spoof-shaped params. F7: separate TACHYON_AGENT_BRIDGE_TOKEN var.
  F8: diagnostics redaction. F9: TTL/eviction. F10: workspace+instance scoping. F11: probes get per-run
  tokens now (was an open question, is a criterion). F12: stable reason codes. F14: tokens are
  process-session credentials, helpers fail loud. F15: human/external spawn-parent semantics defined.

## Live dogfood (claude, installed 0.55.17, 2026-07-04 ~13:0x) — PASS
Choreography: window reload + stop/resume of the claude session (fresh per-agent token minted at resume —
itself validating T6's surviving-session promise). Results:
- **Self-assign suppression**: claude claimed t-d65be2 (assignee=claude) → NO assign poke. The two-day-old
  self-poke class (348 known limitation) is dead — killed by the spec it motivated.
- **caller_mismatch**: claude called notify_agent declaring agent:"codex" → structured error "caller_mismatch:
  resolved caller is 'claude' but the call declared 'codex'", nothing delivered. The Bridge resolves callers.
- Legacy path: pre-351 sessions (shared token) keep working under compat-ON with per-call logging, as spec'd.
Human-observable residue: none — which is the point.
