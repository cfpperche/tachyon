# 476 — codex-effective-model-proof — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

Codex already writes the evidence; the probe just refuses to keep it. So: give the probe its own
Codex home, let Codex persist a rollout *there*, correlate that rollout to this run by the `thread_id`
the JSON stream already prints, read `turn_context.payload.model` out of it, and delete the home.

The chain, end to end:

```
buildInvocation → CODEX_HOME=<scratch>/codex-home (auth.json symlinked in), --ephemeral dropped
        run → stdout {"type":"thread.started","thread_id":"…"}   + rollout under the private home
  interpret → thread_id (exact, single) → sessions/**/rollout-*-<thread_id>.jsonl (exact, single)
            → session_meta.session_id must equal thread_id → turn_context.payload.model[]
            → native.reportedNativeModels → resolveModelProof → proven | mismatch | unproven
    cleanup → remove <scratch>/codex-home, always
```

Every step is exact-match or nothing. There is no "closest rollout", no "newest file", no timestamp
window: absence, ambiguity and disagreement all collapse to the same outcome — no evidence, verdict
`unproven`, result preserved.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **D1 — a private per-run `CODEX_HOME`, and `--ephemeral` dropped.** `--ephemeral` is precisely what
  suppresses the rollout, so it goes; isolation is preserved by relocating the entire Codex home to
  `<scratchDir>/codex-home`, so the human's `~/.codex` is neither read for config nor written for
  sessions, history, caches or state. `--ignore-user-config` and `--ignore-rules` stay for defence in
  depth. Rejected: keeping the human's home and deleting our own rollout afterwards — it writes to a
  directory we do not own, races the human's own Codex processes, and leaves state behind whenever the
  probe dies before its cleanup runs.
- **D2 — auth reaches the private home by symlink.** `codex exec --help` states that
  `--ignore-user-config` still resolves auth from `CODEX_HOME`, and the measurement confirms a private
  home with no credential cannot run. A symlink to the human's `auth.json` copies no secret bytes and
  lets a token refresh write through. If Codex ever replaces the symlink with a regular file, that
  file lives inside the per-run home and is destroyed with it. A missing `auth.json` is not an error:
  an API-key setup inherits through the environment. Rejected: copying the credential — it leaves a
  real copy on disk for the run's lifetime and defeats refresh write-through.
- **D3 — plugins, remote plugins and apps are disabled on the probe invocation.** Measured: a fresh
  private home costs 38 MB plus remote catalog fetches with defaults, versus 1.2 MB and ~3 s with
  `--disable plugins --disable remote_plugin --disable apps --disable skill_search`. The probe lane
  wants the narrow surface independently of cost — a bounded read-only question has no business
  loading an app catalog — so this is a scope decision that happens to also be the cheap one.
- **D4 — correlation is by `thread_id`, verified twice.** The rollout filename ends in the session
  UUID and `session_meta.payload.session_id` repeats it. The adapter matches the filename *and*
  re-checks `session_meta` inside the file, so a renamed, copied or truncated file cannot pass as this
  run's evidence. Zero matches, more than one match, a missing `thread.started`, more than one
  distinct `thread_id`, or a `session_meta` disagreement each yield no evidence. Rejected: newest
  rollout in the private tree — with one home per run it would usually be right, which is exactly what
  makes it dangerous under concurrency, retries or a leftover home.
- **D5 — every `turn_context` model is reported, not just the first.** `resolveModelProof` already
  requires *every* reported identifier to satisfy the request, and says why: a run that used the
  requested model and also another one is not clean proof. Reporting the whole set preserves that, so
  a session whose second turn switched models reads `mismatch`. Rejected: last-observed-wins (what
  `codexNormalizer` does for the activity view) — a display latch is not an evidence rule.
- **D6 — Codex declares `reportsEffectiveModel: true`, and the evidence names its own source.**
  Flipping the flag is what SDD 473 designed for ("turning enforcement on later is a declaration"),
  and it is what makes an unprovable Codex run fail instead of passing quietly. But Codex's evidence
  is a runtime session record, not provider usage accounting, so `ProbeModelProof` gains
  `evidence?: "provider-usage" | "session-record"`, declared per adapter and carried into stored
  metadata and the read surface's tooltip. `proven` on Codex therefore reads as "Codex recorded that
  it ran this model", never as "the provider attested this model". Rejected: leaving the distinction
  in source comments — the spec's whole subject is results that read stronger than they are.
- **D7 — the adapter contract grows three seams, all optional and backwards compatible.**
  `buildInvocation` and `interpret` may now return a promise (Codex needs `mkdir`/`symlink` before the
  spawn and a file read after it); `interpret` receives the `Invocation` the runner actually used
  (that is where the private home path lives); and an optional `cleanup(inv)` is awaited by the runner
  in a `finally`, so teardown happens on success, timeout, cancel, crash and interpretation failure
  alike. Claude and Grok are untouched and stay synchronous. Rejected: having the runner glob a
  `sessionDir` declared on `Invocation` — that pushes Codex's rollout format into the runtime-neutral
  runner.
- **D8 — the rollout is read, never kept.** A rollout embeds the full prompt and the system preamble.
  Only the correlated identifiers (`sessionId`, the model set) are persisted, in the fields SDD
  473/474 already defined. Rejected: storing the rollout as a probe artifact for auditability — the
  store is not redacted and the prompt is the bulk of the file.

## Files touched

_The modules/files this will create or change, with a one-line note on each._

| File | Change |
|------|--------|
| `src/probe/adapters/codexSessionEvidence.ts` | **new** — private-home lifecycle + `thread_id` → rollout → model correlation; pure parsers exported for tests |
| `src/probe/adapters/codex.ts` | private `CODEX_HOME`, `--ephemeral` dropped, disable flags, async `interpret`, `cleanup`, `reportsEffectiveModel: true`, `modelEvidence: "session-record"` |
| `src/probe/adapters/types.ts` | promise-tolerant `buildInvocation`/`interpret`, `interpret` gets `inv`, optional `cleanup`, `modelEvidence` declaration |
| `src/probe/ProbeRunner.ts` | await `buildInvocation`/`interpret`; always await `adapter.cleanup` |
| `src/probe/taxonomy.ts` | `ProbeModelProof.evidence` |
| `src/probe/modelProof.ts` | carry `evidence` through `resolveModelProof` |
| `src/probe/ProbeService.ts` | pass the adapter's evidence kind in; persist it |
| `src/probe/ProbeStore.ts` | `modelEvidence` on `ProbeRunMeta` / `ProbeRunRecord` |
| `src/probe/probeView.ts` | name the evidence source in the model tooltip |
| `src/probe/adapters/claude.ts`, `grok.ts` | declare `modelEvidence: "provider-usage"` |
| `test/unit/probeAdapterCodex.test.ts` | **new** — correlation, ambiguity, mismatch, tampered rollout, home teardown |
| `test/unit/probeRunner.test.ts`, `test/unit/probeProvenanceParity.test.ts` | async seams; Codex now capable |
| `scripts/dogfood/probe-codex-model-proof.ts` | **new** — real `codex exec` end to end, proving correlation, isolation and teardown |
| `scripts/dogfood/probe-provenance-parity.ts` | Codex row moves from "honestly exempt" to "proves from its own session record" |
| `docs/runtimes/parity.md` | provenance seam reflects the fleet |

## Risks & unknowns

- **A Codex probe that previously "passed" now fails.** That is what `reportsEffectiveModel` means,
  but it converts a silent weakness into visible breakage. Mitigated by making correlation exact and
  robust rather than lenient, and by dogfooding against the real CLI — not by softening the verdict.
- **Codex changes its rollout layout or record names.** Then correlation finds nothing and probes read
  `unproven` — loud and honest, never a wrong model. `binaryVersion` is recorded with every run, so
  the break is attributable to a CLI upgrade.
- **A crash between spawn and cleanup leaves a private home behind.** It is inside the run's own
  artifact dir, never the human's home, and is removed by the store's existing retention prune.
- **Per-run home costs ~1.2 MB and a models-cache fetch.** Accepted; measured.
- **`turn_context` is Codex's resolved model, not a provider attestation.** Handled by D6 rather than
  hidden: the limitation is stated in the spec, in the adapter, and in the stored evidence.

## Visual impact

The probe table's model cell (SDD 475) gains no new state — `proven` / `mismatch` / `unproven` are
unchanged. Only the hover title gains a clause naming where the evidence came from, and Codex rows
that read `unproven` today start reading `proven` with an identifier. No layout change.

## Sources consulted

`src/probe/adapters/{codex,claude,grok,types}.ts`, `src/probe/{ProbeRunner,ProbeService,ProbeStore,
modelProof,taxonomy,probeView}.ts`, `src/engine-service/protocol.ts` (probe row validation),
`src/activity/codexNormalizer.ts` (`turn_context.payload.model`, spec 378),
`src/resume/resolvers.ts` (`resolveCodexSession` — the existing rollout walk and its
`session_meta` check), `docs/specs/473-probe-effective-model-proof/spec.md`,
`docs/specs/474-probe-provenance-parity/spec.md`, `docs/runtimes/parity.md`, task `t-a10d31`, and
direct measurement of codex-cli 0.145.0 recorded in `notes.md`.
