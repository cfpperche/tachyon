# 474 — probe-provenance-parity — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Findings

- **The audit's first three answers were "already fine".** All three adapters pass `--model`
  (`claude.ts:167`, `codex.ts:49`, `grok.ts:178`), and `requestedModel` is persisted centrally in
  `ProbeService`, so it is runtime-neutral by construction. Only obligation 3 — extracting the
  effective model — had a gap, and only in one direction. Saying so plainly matters: the task asked
  for an audit, and three of four obligations needed no code.
- **Grok was unprovable purely because nobody read its output.** Measured on `grok 0.2.112`:
  `{"modelUsage":{"grok-4.5-build":{"inputTokens":2240,…}}}` — the same key-is-the-identity shape as
  Claude. The adapter parsed `text`/`stopReason`/`sessionId` and dropped the rest. This is the
  concrete reduction of SDD 473's exemption the task asked for.
- **Grok has no `canonicalModel` sub-field.** Claude's entries carry both the dated key and a family;
  Grok's carry only the key. Deriving `grok-4.5` from `grok-4.5-build` by trimming would be
  inference, so only the key is reported and `reportedModels` stays undefined for Grok.
- **Codex genuinely cannot prove it today, and the lead that looked promising did not hold.**
  `src/activity/codexNormalizer.ts` reads `turn_context.payload.model`, which suggested the probe
  could too. It cannot: that record lives in the session rollout, not in `exec --json` stdout.
  Measured on codex-cli 0.145.0, the probe's own invocation shape emits exactly four records —
  `thread.started`, `turn.started`, `item.completed`, `turn.completed` — with no model anywhere. A
  real rollout confirmed the model IS there (`gpt-5.6-luna`), but `--ephemeral` prevents one being
  written. Filed as `t-a10d31` with both unblock routes and their costs.

## Design decisions

- **Two small adapter-local readers instead of one shared `modelUsage` parser.** The shapes rhyme
  today but the CLIs version independently and already differ (`canonicalModel`). A shared parser
  would imply a cross-vendor contract neither has promised.
- **The fleet guard is a test, not a runtime check.** A missing capability declaration is an
  authoring mistake; failing the build is the right moment. Throwing at registration would turn a
  provenance-metadata omission into a spawn outage.
- **The exemption map requires a reason string and is asserted to match reality exactly** — the test
  compares the set of non-declaring adapters against the map's keys, so an adapter cannot be added
  to one without the other, in either direction.

## Deviations

None material. The plan's file list held; the only addition was a fleet-level test file rather than
extending an existing per-adapter one, because the assertion is about the registry as a whole.

## Tradeoffs

- **Grok probes with an explicit model can now fail where they previously passed** — a mismatch or a
  missing `modelUsage` becomes `model_mismatch`/`model_unproven`. That is SDD 473 applied honestly
  to a runtime that was silently exempt, and it is bounded to probes that explicitly named a model.
- The Grok payload was measured on one prompt on 0.2.112. Rather than assume every result carries
  `modelUsage`, the absent/empty/malformed shapes are covered by tests and degrade to `unproven`.

## Open questions

None. The remaining gap is Codex's, measured and filed as `t-a10d31`; the probe-table UI is
`t-3a3de1`'s and was deliberately not touched.

## Verification log

<!-- appended by `/sdd verify --run` -->

## Dogfood log

<!-- appended by `/sdd dogfood --run` -->

### 2026-07-26T20:06:28Z — pass (1/1) — source: tasks.md — commit: 990cf0fcf232846f6c1e0df5f85c33ddb8fee3b1
- `npm run dogfood -- probe-provenance-parity` — pass
