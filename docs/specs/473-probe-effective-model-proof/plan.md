# 473 — probe-effective-model-proof — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## What the evidence actually shows

The real `modelUsage` payload from a stored run:

```json
"modelUsage": { "claude-haiku-4-5-20251001": { …, "canonicalModel": "claude-haiku-4-5", "provider": "firstParty" } }
```

Two identities: the **key** is the provider-native identifier, `canonicalModel` is the family.
`reportedModels()` in `src/probe/adapters/claude.ts` keeps only the family and discards the key —
so the most precise evidence available is thrown away before it is stored.

`ProbeService.execute` already writes `requestedModel` at launch and `reportedModels` at the end.
Nothing compares them, and neither reaches the envelope the caller reads.

## Approach

Introduce one derived fact — a **model proof verdict** — computed where both halves are already in
hand, in `ProbeService.execute`, and carried into both the stored metadata and the envelope so the
Bridge read/list surface exposes it without a second source of truth.

The verdict is one of `not-requested` | `proven` | `mismatch` | `unproven`. Matching is deliberately
conservative: a requested string matches when it equals a reported canonical model, equals a native
identifier, or is the prefix of a native identifier at a `-` boundary (`claude-opus-5` matches
`claude-opus-5-20260101`). Anything else is a mismatch, so a loose alias fails closed rather than
being talked into agreement.

Enforcement layers on top:

- `mismatch` overrides the result to failed with a new `model_mismatch` reason. This is unambiguous
  evidence the wrong model ran, and it applies to every runtime.
- `unproven` overrides an otherwise-`ok` result to failed with `model_unproven`, **but only when the
  adapter declares it can report models**. Enforcing it where proof is impossible would fail every
  Codex/Grok probe that names a model, with no security gain.
- A result that already failed is left alone; its reason is the useful one, and the verdict is
  recorded alongside rather than overwriting it.

The Claude adapter starts reporting both identities, so `native.reportedModels` keeps the canonical
family (unchanged shape for existing readers) and a new `native.reportedNativeModels` carries the
keys.

## Key decisions

- **The verdict is computed in the service, not the adapter** — adapters report what the runtime
  said; deciding whether that satisfies the request is policy, and policy belongs where the request
  and the report meet. Rejected computing it in each adapter, which would duplicate the matching
  rule three times and let runtimes disagree about what "proven" means.
- **Capability is declared per adapter (`reportsEffectiveModel`)** — rather than hard-coding
  `runtime === "claude"` in the service. Rejected the string check because it hides the reason the
  other runtimes are exempt; a declared capability states it and makes the stricter policy a
  one-line change when they gain reporting.
- **Prefix matching only at a `-` boundary** — chosen so a dated release satisfies a family request
  without `claude-opus` silently matching `claude-opus-5`. Rejected substring matching (too loose)
  and exact-only (would fail the common dated-identifier case, making the feature unusable).
- **Historical runs are unproven by construction** — the verdict is absent from pre-473 metadata and
  the read path reports absence as `unproven` rather than defaulting to anything friendlier. This is
  the task's explicit "do not alter historical results as if they were proven".
- **A failed run keeps its original reason** — a timeout that also could not prove its model is
  still a timeout. Overwriting would lose the more actionable fact.

## Files touched

- `src/probe/taxonomy.ts` — `model_mismatch` / `model_unproven` reasons, verdict type, the envelope
  field.
- `src/probe/ProbeService.ts` — compute the verdict, persist it, apply enforcement.
- `src/probe/ProbeStore.ts` — metadata fields.
- `src/probe/adapters/types.ts` — the `reportsEffectiveModel` capability.
- `src/probe/adapters/claude.ts` — report native identifiers alongside canonical families.
- `src/probe/probeView.ts` — surface the verdict on read/list.
- Tests: `test/unit/probeAdapterClaude.test.ts`, probe service/taxonomy tests.
- `scripts/dogfood/probe-model-proof.ts` + npm script.

## Risks & unknowns

- **The behavior change can fail probes that currently pass.** That is the point, but a Claude probe
  that completes without `modelUsage` now fails where it previously returned a result. Bounded by
  applying it only when a model was explicitly requested — the common no-model probe is untouched.
- Matching real-world identifier shapes is the fragile part; conservative rules plus tests over the
  actual observed strings (`claude-haiku-4-5-20251001` / `claude-haiku-4-5`) rather than invented ones.
- The reason taxonomy is iterated exhaustively by tests; adding members must keep those green.

## Visual impact

The probe read/list surface gains a model-proof field. Low visual risk (textual field in an existing
payload), so evidence is the dogfood transcript rather than a screenshot.

**Visual QA Opt-Out:** the change surfaces a textual field through Bridge probe read/list payloads;
there is no rendered UI in this spec, and the payload is proven by dogfood + unit assertions.

## Sources consulted

- `.tachyon/probes/probe-0d6cc588-.../result.json` — the real `modelUsage` shape quoted above.
- `.tachyon/probes/probe-fab094ec-…`, `probe-77505e6b-…`, `probe-42744006-…` — the reported cases;
  all three predate SDD 461 and carry no `requestedModel` at all.
- `src/probe/ProbeService.ts:204-270`, `ProbeStore.ts:20-30`, `taxonomy.ts:21-52`,
  `adapters/claude.ts:25-45` — the current persistence and reason model.
- `docs/specs/461-probe-model-provenance/` — what `t-b516f4` shipped and deliberately stopped short of.
