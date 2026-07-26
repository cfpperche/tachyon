# 474 — probe-provenance-parity — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## The audit, measured

| obligation | claude | codex | grok |
|---|---|---|---|
| requested model reaches the invocation | ✓ `--model` (`claude.ts:167`) | ✓ `--model` (`codex.ts:49`) | ✓ `--model` (`grok.ts:178`) |
| `requestedModel` persisted | ✓ central in `ProbeService` (SDD 461) | ✓ same | ✓ same |
| structured effective-model evidence | ✓ `modelUsage` | ✗ **measured absent** | ✓ **available, unread** |
| absence never inferred | ✓ | ✓ | ✓ |

Obligations 1, 2 and 4 already hold everywhere — the audit's honest answer is that they were not the
gap. Obligation 3 is, in exactly one direction.

**Grok (`grok 0.2.112`), `-p … --output-format json` — measured:**

```json
{ "text": "ok", "stopReason": "EndTurn", "sessionId": "019fa002-…", "total_cost_usd": 0.0080068,
  "modelUsage": { "grok-4.5-build": { "inputTokens": 2240, "outputTokens": 31, "modelCalls": 1 } } }
```

Same shape as Claude: the **key** is the model identifier. Unlike Claude there is no
`canonicalModel` sub-field, so the key is the only identity available — which is precisely why
SDD 473 started preserving native keys.

**Codex (`codex-cli 0.145.0`), `exec --json --ephemeral` — measured:** four records only —
`thread.started` (thread_id), `turn.started`, `item.completed` (the message), `turn.completed`
(token usage). No model identity in any of them. The `turn_context.payload.model` that
`codexNormalizer` reads lives in the session rollout, which `--ephemeral` exists to prevent.

## Approach

Give Grok the same treatment Claude has: extract the `modelUsage` keys into
`native.reportedNativeModels`, declare `reportsEffectiveModel: true`, and let the SDD 473 service
logic do the rest unchanged. No new policy, no second mechanism — the verdict, enforcement,
persistence and read surface all already exist and are runtime-neutral.

Codex declares nothing, so it keeps SDD 473's exemption. What changes is that the exemption is now
justified by a recorded measurement instead of an absence nobody checked.

The durable piece is a **registry guard**: a test over the real adapter registry asserting each
adapter either declares `reportsEffectiveModel` or is named in an explicit exemption map with a
reason. A future adapter that reports nothing must state so deliberately; it cannot drift in.

## Key decisions

- **Reuse the Claude extraction shape rather than generalising it prematurely** — both runtimes key
  `modelUsage` by identifier, but Claude also has `canonicalModel` and Grok does not, and the two
  CLIs version independently. Two small adapter-local readers are honest about that; a shared
  "modelUsage parser" would imply a contract neither vendor has promised. Rejected extracting to a
  common helper for that reason.
- **The guard lives in a test over the registry, not a runtime assertion** — a missing capability
  declaration is an authoring mistake, and failing a build is the right moment to catch it. Rejected
  throwing at registration, which would turn a provenance-metadata omission into a spawn outage.
- **The exemption list carries a reason string** — an exempt adapter must say why, so the list reads
  as a decision log rather than a mute allowlist that grows by default.
- **Grok gets no `canonicalModel` fallback invented** — its entries have no such field, and
  synthesising a family from the key (e.g. trimming `-build`) would be inference. Only the key is
  reported.

## Files touched

- `src/probe/adapters/grok.ts` — read `modelUsage` keys; declare the capability.
- `src/probe/adapters/codex.ts` — comment recording the measured absence and pointing at `t-a10d31`.
- Tests: `test/unit/probeAdapterGrok.test.ts` (extraction + capability + `--model`),
  `probeAdapterClaude.test.ts` / a codex adapter test for the `--model` obligation, and a new
  registry-guard test.
- `docs/runtimes/parity.md` — the measured provenance row per runtime.
- `scripts/dogfood/probe-provenance-parity.ts` + npm script.

## Risks & unknowns

- **Grok probes with an explicit model can now fail where they used to pass** — a mismatch or a
  missing `modelUsage` becomes `model_mismatch` / `model_unproven`. That is the point of SDD 473
  applied honestly, but it is a behavior change for a runtime that previously could not fail this
  way. Bounded to probes that explicitly requested a model.
- The Grok payload was measured once, on one prompt, on 0.2.112. A result without `modelUsage` (an
  error path, say) must degrade to `unproven`, never to a crash — covered by a test rather than
  assumed.
- The registry guard must not become a rubber stamp; the exemption entry requires a non-empty reason.

## Visual impact

**Visual QA Opt-Out:** no rendered surface changes here. The verdict fields already flow through the
read/list payload from SDD 473, and the Probes table UI is `t-3a3de1`'s work, deliberately untouched.

## Sources consulted

- Live measurement: `grok 0.2.112 -p … --output-format json`; `codex exec --json --ephemeral`
  (codex-cli 0.145.0); a real codex session rollout showing `turn_context.payload.model`.
- `src/probe/adapters/{claude,codex,grok}.ts` — invocation and interpretation paths.
- `src/probe/modelProof.ts`, `ProbeService.ts` — the runtime-neutral verdict/enforcement from SDD 473.
- `src/activity/codexNormalizer.ts:88`, `grokNormalizer.ts:90` — where the repo already reads native
  model identity, and the lead that made this audit worth doing.
- `docs/specs/473-probe-effective-model-proof/` — the exemption this spec narrows.
