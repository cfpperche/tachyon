# SDD 368 T4 adversarial review — `ecbd422`

**Verdict: FINDINGS**

Scope: focused review of canonical `delivery_id` resolution, legacy exactly-one sugar, identity and authorization mapping, segment provenance, waiver attribution, and verification-record binding. No T9 lease implementation is expected here.

## F1 — HIGH — canonical `delivery_id` bypasses the self-waiver authorization check

Evidence: `src/bridge/tools.ts:1038-1056` checks self-authored waivers only under `!delivery_id`:

```ts
if (!delivery_id && caller.kind === "agent" && caller.name === agent && (waivers?.length ?? 0) > 0) ...
```

For the preferred API, an execution agent can call `verify_task({ delivery_id: <its delivery>, waivers: [...] })`. The supplied legacy `agent` is irrelevant to resolution, and the guard is categorically disabled whenever `delivery_id` exists. The verifier then accepts the waivers and records the actual caller, but attribution after the fact does not prevent the unauthorized waiver from changing a blocked result to ACCEPT.

Required closure: resolve the canonical Delivery first, derive the authoritative relevant execution identity, and reject waivers when the resolved caller is that identity. Never authorize from caller-supplied legacy `agent`, including when both fields conflict. Add Bridge-level tests for delivery-only self-waiver, conflicting `delivery_id` + spoofed `agent`, coordinator waiver, and waiver-free self-verification.

## F2 — HIGH — adapter assigns operational identity to segment zero, not the current/tail segment

Evidence: `src/delivery/verifyAdapter.ts:9-21` selects `delivery.segments[0]` and returns `agent: first.executionAgent`; later segments are flattened into `fixerAttempts`. Existing verifier behavior uses this `agent` for worktree mutex selection, live-agent exclusion, doorbell attribution, and verification-record identity (`src/bridge/verifyTask.ts`, calls using `record.agent`).

After a reviewer/fixer/recovery successor exists, the current Delivery occupant is the tail segment, while this adapter continues checking and recording the original implementer. A live successor can therefore be missed while its worktree is mutated, and caller/doorbell/record identity is attributed to the wrong segment. This is distinct from T9's system lease: T4's transitional adapter must still map the canonical current segment correctly for the verifier behaviors it already invokes.

Required closure: retain immutable contract fields from `delivery.contract`, retain segment boundaries for scope checks, but derive current operational identity from the canonical tail/current segment (and fail closed for zero segments or a state with no provable current segment). Add a multi-segment test proving current-agent liveness, lock key, caller conflict, and emitted identity use the tail rather than segment zero.

## F3 — MEDIUM — verification artifact is not bound to `delivery_id` or segment identity

Evidence: the adapter does not carry `delivery.id`; `VerifyTaskRecord` construction persists `refSha`, `treeSha`, base/task ref and `agent`, then `writeVerificationRecord` keys the file only as `.tachyon/verifications/<refSha>.json`. Thus two canonical Deliveries that resolve to the same head SHA produce indistinguishable delivery identity and overwrite the same path. The integrity hash faithfully hashes the incomplete payload, so it cannot prove which Delivery/segment was authorized and verified.

Required closure: include canonical `deliveryId` and the relevant segment identity/index in the verification record and its integrity hash. Define collision-safe persistence or explicitly reject an existing same-SHA record for a different canonical identity. Preserve legacy records with an explicit legacy identity form. Test same-SHA/different-Delivery behavior and hash sensitivity.

## Confirmed behavior

- Explicit `delivery_id` takes precedence over conflicting legacy `agent` during resolution.
- Legacy sugar enumerates all non-archived same-name records and accepts exactly one; it does not select by timestamp or mtime.
- Immutable `baseSha`, `taskRef`, `owns`, `behaviorTest`, `stubPath`, and task id are sourced from `delivery.contract`.
- The adapter is transient and does not dual-write a DelegationRecord.
- Resolution errors are exposed as structured Bridge diagnostics with candidate paths/ids for ambiguous legacy names.

## Gate assessment

The generated ambiguity test covers the headline legacy gate, but canonical authorization and multi-segment identity are not covered. Because F1 can convert unauthorized waivers into ACCEPT and F2 can verify while checking the wrong occupant, the stated full ACCEPT-without-waivers gate is not sufficient to accept T4.
