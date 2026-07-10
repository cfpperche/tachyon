# T0.3 Adversarial Closure Review — SDD 368 process fence

**Reviewer:** review368r2 (spawned by codex)  
**Date:** 2026-07-10  
**Scope:** R3-F1 fold only in `docs/specs/368-delivery-worktree-leases/{spec,plan,tasks,notes}.md`; read-only
architecture closure review.  
**Verdict:** **ACCEPT** — R3-F1 is explicitly and consistently closed. No concrete regression found.

## Closure result

The revised design no longer treats pane-root or PID-tree disappearance as proof of isolation. It requires every
Delivery execution to launch through `ProcessFencePort` under a durable execution nonce and a platform containment
group that continues to own descendants after detachment or reparenting. Both handoff and crash reconciliation
use the same tri-state absence predicate:

- `proven_empty` is the only result that permits `draining → pending` and successor spawn;
- `survivors` quarantines and blocks spawn;
- `unknown`, incomplete proof, or unsupported-host capability quarantines/returns unavailable and blocks spawn.

Before the transition, the adapter freezes/terminates the complete containment group and independently audits
processes bound through canonical cwd/root/open-path state to the Delivery worktree. Git is then revalidated in
the short locked transition that closes the predecessor segment and installs the nonce-bound successor
reservation. Authority remains continuously occupied as `held → draining → pending`; runtime spawn remains
outside durable locks without reviving the predecessor.

## Adversarial checks

| Failure scenario | Required outcome | Folded mechanism | Result |
|---|---|---|---|
| Child detaches or reparents before pane-root death | child remains discoverable and blocks spawn | complete containment group includes detached/reparented descendants | closed |
| Pane/root PID exits while child retains worktree access | root death alone cannot authorize handoff | `proveEmpty` plus canonical cwd/root/open-binding audit | closed |
| PID is reused after predecessor death | replacement process cannot satisfy old execution identity | durable execution nonce plus persisted process/boot identity | closed |
| Adapter sees a survivor | no successor starts | `survivors → quarantined` | closed |
| Audit or containment proof is incomplete | no optimistic handoff | `unknown → quarantined` | closed |
| Host cannot provide sound containment | feature cannot weaken or fork | capability unavailable; sequential handoff disabled | closed |
| Handoff and crash paths disagree | neither path may free what the other quarantines | exact shared absence predicate | closed |

The remaining implementation risk is appropriately gated by the mandatory empirical spike: launch a
detached/reparented writer, terminate the pane root, and prove the adapter continues reporting survivors until
the whole containment group is empty. This is a verification obligation, not an unresolved architecture clause.

## Cross-document evidence

- `spec.md:71–81` requires whole-group freeze/stop, descendant/reparented-member absence, canonical-worktree audit,
  Git revalidation, and fail-closed unsupported/incomplete fencing.
- `spec.md:147–153` requires the durable anti-PID-reuse token and the same absence predicate for handoff and crash
  reconciliation.
- `plan.md:67–73` defines `ProcessFencePort`, durable execution nonce, `freeze`/`terminate`/`proveEmpty`, the complete
  containment group, independent worktree audit, tri-state outcomes, and unsupported-host refusal.
- `plan.md:90–101` places `proven_empty` before the locked close/reserve transition and keeps spawn outside locks
  without an authority-free interval.
- `tasks.md:10–12` requires the supported-host detached-child empirical spike and unsupported-host proof.
- `tasks.md:35–42` routes every successor through the containment adapter and makes detached-child exclusion a T7
  gate; `tasks.md:56–58` reuses the same predicate for crash reconciliation.
- `notes.md:55–66` explicitly records R3-F1 as folded and keeps T1 blocked on this T0.3 closure.

No style-only or hypothetical portability finding is reported. The contract is fail-closed; production support
for a host is conditional on empirical proof of its adapter rather than assumed by the architecture.
