# 483 — governed Saved Agent proposal v2

_Created and ratified 2026-07-30._

**Status:** shipped

## Intent

The governed proposal door shipped with three accidental restrictions: it always makes the proposer
the durable owner, cannot select the runtime model/reasoning exposed by Agent Studio, and forbids the
new agent from receiving the same narrowly governed proposal grant. That made the approved
`claude-coordinator` proposal structurally wrong.

The proposal must carry these choices as inert, digest-bound data; show them to the human; and apply
only the exact approved values through the canonical profile transaction. Approval creates an enabled,
stopped Saved Agent and remains distinct from starting it.

## Acceptance criteria

- [x] A proposal can choose `ownership: proposer` or `ownership: top-level`; absent preserves proposer ownership.
- [x] A top-level proposal creates no `declaredOwner` edge and does not edit the proposer's profile.
- [x] A proposal can select model and reasoning effort through the runtime's typed native-config policy.
- [x] A proposal may request `grants.proposeSavedAgent=true`; the review names the authority and the canonical profile stores it only after human approval.
- [x] The Human Inbox renders ownership, model, reasoning and requested grants before approval.
- [x] Old strict `agent-profile.saved-agent-create` payloads remain unchanged; v2 crosses an additive named action.
- [x] Digest, expiry, proposer-grant revocation, config CAS, disabled-by-default creation and no-autostart controls remain intact.
- [x] Focused tests and the full verification gate pass on the final tree.

## Non-goals

- Starting the created agent.
- Granting skills, MCP servers or hooks during creation.
- Arbitrary profile/YAML input, arbitrary paths, branches or working directories.
- Automatically repairing the earlier malformed `claude-coordinator` proposal without a fresh human decision.

## Open questions

None. The human ratified top-level ownership, model/reasoning selection and explicit delegation of the
proposal grant on 2026-07-30.

## Closure

**Closure:** shipped on 2026-07-30 after focused dogfood, typecheck and the full verification gate.

The proposal contract, review projection and canonical create path now carry the ratified choices.
The prior v1 action remains byte-shape compatible; v2 is an additive action. Approval still creates
an enabled, stopped agent and never starts it.
