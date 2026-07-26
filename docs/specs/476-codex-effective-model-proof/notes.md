# 476 — codex-effective-model-proof — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Measurement — codex-cli 0.145.0, 2026-07-26

Everything the plan rests on was observed on this machine, not assumed.

**1. `exec --json` really does carry no model identity.** Confirmed independently of `t-a10d31`, on a
private home, with the probe's own flag shape:

```
{"type":"thread.started","thread_id":"019fa07e-f2a7-7da1-a3b9-fe2cebc3884c"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":11755,…,"output_tokens":5,…}}
```

**2. The rollout is the evidence, and the filename embeds the thread id.** Dropping `--ephemeral` with
`CODEX_HOME=<private>` wrote exactly one file:

```
<private>/sessions/2026/07/26/rollout-2026-07-26T19-15-02-019fa07e-f2a7-7da1-a3b9-fe2cebc3884c.jsonl
```

`session_meta.payload.session_id = 019fa07e-f2a7-7da1-a3b9-fe2cebc3884c` — identical to the stream's
`thread_id`, so correlation is an equality check, never a heuristic. Inside,
`turn_context.payload.model = "gpt-5.6-luna"`, matching the `--model` that was requested.

**3. Only `turn_context` carries the model.** Enumerating record types across a real rollout:
`session_meta`, `turn_context`, `event_msg` (`task_started`, `user_message`, `agent_message`,
`token_count`, `task_complete`) and `response_item`. `token_count` carries
`model_context_window` and rate limits but no identifier; `session_meta` carries `model_provider`
(`openai`) but no model. This is the same field `src/activity/codexNormalizer.ts` latches for spec 378.

**4. A private `CODEX_HOME` needs the credential made reachable.** `codex exec --help` documents
`--ignore-user-config` as "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`". A
symlink to the human's `auth.json` inside the private home ran successfully end to end.

**5. An unknown model errors; it does not silently fall back.** `--model
definitely-not-a-real-model-xyz` produced `Model metadata … not found. Defaulting to fallback
metadata` followed by a provider `400` and `turn.failed`, exit 1. Useful boundary: the local
substitution class this spec catches is config/profile/alias resolution, not a silent provider swap.

**6. Footprint of a fresh private home.** Defaults: 38 MB and a round of remote catalog fetches
(27 MB `plugins/`, 8.7 MB `cache/`). With `--disable plugins --disable remote_plugin --disable apps
--disable skill_search`: 1.2 MB total and ~3 s wall clock, with the rollout still written and the
answer unchanged.

## Design decisions

**The abort window that widening `buildInvocation` opened.** Making `buildInvocation` awaitable
introduced a microtask gap between calling `runProbe` and registering the abort listener, and an abort
landing in that gap was silently dropped — the probe ran on to completion or to its timeout as if
nobody had cancelled it. The pre-existing cancel test caught it immediately (it aborts synchronously
after the call, which used to be inside the fully synchronous prologue). Fixed by registering the
listener BEFORE preparing the invocation, making `terminate()` a no-op until a child exists, and
checking `cancelled` after the await — where a cancellation now tears down the private home that WAS
created and returns `killed_signal` without ever spawning. A spawn that throws outright gets the same
teardown. Not filed as a separate bug: the window did not exist before this change and does not exist
after it.

**`interpret`'s third parameter is optional, and Codex fails closed without it.** A required parameter
would have forced an `Invocation` through every existing call site that ignores it. Optional keeps
those honest and untouched, and the safety comes from direction rather than arity: with no
`inv.env.CODEX_HOME`, Codex records `"the probe ran without a private codex home"` and the run reads
`unproven`. The degraded path refuses to prove, so forgetting the argument can never manufacture a
verdict. `StatelessCaptureAdapter` then makes "this adapter touches no disk" a checked fact for Claude
and Grok (it also forbids `cleanup`), rather than a comment.

**`evidence` is only stamped where identifiers exist.** `resolveModelProof` attaches the evidence kind
only when something was actually reported. Labelling an empty set `session-record` would dress an
absence in the vocabulary of proof — the exact failure mode SDD 473 was written against.

## Deviations

None from `plan.md`. Two additions the plan did not anticipate: the abort-window fix above, and
`StatelessCaptureAdapter` in `adapters/types.ts` (the plan said "Claude and Grok are untouched and
stay synchronous" without saying how that would be enforced).

## Tradeoffs

**Dogfood check 2 asserts on `sessions/`, not the whole human home.** The first version fingerprinted
all of `~/.codex` and reported `tmp/arg0/codex-arg0*` churn as changed. Measured cause: other codex
processes on this machine (this repository is driven by codex agents) create and remove those helper
dirs constantly. Verified separately that they are NOT ours — with `CODEX_HOME` relocated outside
`/tmp`, codex creates its arg0 helper binaries under the PRIVATE home and the human's
`~/.codex/tmp/arg0` listing is byte-identical before and after a probe. (Under a `/tmp`-based home
codex refuses to create them at all: _"Refusing to create helper binaries under temporary dir"_.) So
the check now makes the exact, race-free claim — this run's own session id appears nowhere under the
human's `sessions/` tree — plus a fingerprint of that durable subtree, and states in a comment why the
volatile paths are excluded. Given up: a whole-home diff. Worth it: a check that fails only when the
probe misbehaves is worth more than one that also fails when a sibling agent is working.

**`proven` on Codex is weaker than `proven` on Claude, and the record says so rather than the verdict
enum.** The alternative was a fifth verdict (`proven-weak`), which would have rippled through the
engine-service protocol's verdict enum, the webview states and every consumer for a distinction only
some readers need. `evidence` sits next to the verdict instead: the enum keeps its meaning, and the
strength is one field and one tooltip clause away.

## Open questions

**Upstream is still the better fix.** If `codex exec --json` ever emits the model in
`turn.started`/`turn.completed`, the private-home machinery becomes unnecessary for provenance (though
not for isolation) and the evidence kind could move to `provider-usage`. Nothing here blocks on it.

## Dogfood log

### 2026-07-26T22:42:40Z — pass (2/2) — source: tasks.md — commit: 2ec2dd66a1e1efc5c40d3c017db2c8e338d72797
- `npm run dogfood:probe-codex-model-proof` — pass
- `npm run dogfood:probe-provenance-parity` — pass
