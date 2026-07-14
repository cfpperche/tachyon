# 369 — RuntimeOps Observability V2 — plan

_Drafted from `spec.md` on 2026-07-10. T0 strategy and cost boundaries ratified 2026-07-14._

## Approach

Deliver one Tachyon-owned observability pipeline with two deliberately separate source classes:

1. **Native execution facts** continue to come from normalized Tachyon activity (`usage.updated`) and retain each
   runtime's cumulative-versus-delta semantics and agent/workspace attribution.
2. **Provider/account facts** come from small Tachyon-owned TypeScript adapters for Codex and Claude, then cross a
   versioned, bounded observation-source boundary into a neutral model. CodexBar remains a development reference and
   conformance oracle, not a runtime dependency. Provider facts are never assigned to an agent merely because that
   agent uses the same runtime.

The implementation starts with a feasibility gate rather than assuming a source layout:

### T0 — vendor-strategy spike

Use the latest stable CodexBar release available when the spike starts (`v0.43.0`, commit
`5a0cbc07119ac04d998e2fd5267442ed9358fff0`, superseded the 2026-07-10 `v0.41.0` baseline) and record its exact
commit. Build or consume the released CLI on Linux x86_64 first, then prove the supported macOS/Linux
matrix needed by Tachyon. Exercise only Codex and Claude, with fixture or already-authorized local sources; do not add
new secrets merely to complete the spike.

Measure and document:

- the transitive Swift source/dependency closure for provider descriptor, strategy, fetch, cache, and cost paths;
- which paths require macOS-only Keychain/WebKit/browser APIs and which compile in `CodexBarCore`/CLI on Linux;
- one-shot versus persistent-process cold/warm latency, memory, binary size, timeout, and cancellation behavior;
- actual JSON shapes for success, unavailable, auth failure, timeout, stale/last-good, and partial provider data;
- absence of a stable schema version in the current general usage payload and the adapter required to contain it;
- license/NOTICE obligations and a repeatable upstream-sync/patch workflow;
- the least-privileged Tachyon invocation seam and whether a new plugin data-source port is necessary.

The spike ends in an ADR-style section in `notes.md` choosing one of:

- **Headless Swift fork:** preserve upstream collectors and compile a Tachyon-owned helper with a new versioned IPC.
- **Extracted Swift subset:** retain only the provider engine closure required by supported Tachyon runtimes.
- **Selective TypeScript port:** port provider collectors only if Swift extraction/build/upstream maintenance is worse
  than owning the implementations.

The maintainer ratified the selective TypeScript port and quota-only first slice on 2026-07-14. Product work begins
only after the spike branch is reviewed and merged.

### T1 — neutral observability domain

Add a domain below Runtime Ops, not inside its webview snapshot service. Its first contract should model:

- `NativeUsageFact`: workspace/agent/runtime attribution plus input, output, cache-read, cache-write, semantics, source,
  and observed time;
- `ProviderQuotaFact`: provider, redacted account scope, named window, used percent or remaining amount, reset, window
  duration, confidence, source strategy, observed time, freshness, and unavailable reason;
- future `ProviderCostFact`: currency/unit-safe aggregate and time range, explicitly deferred from the first slice;
- `CollectorEnvelopeV1`: schema version, collector implementation/reference version, provider, generated time, facts,
  and bounded typed diagnostics.

Validation is allowlist-by-construction. It rejects non-finite numbers, out-of-range percentages, invalid timestamps,
unknown required enums, oversized arrays/strings, raw error bodies, and any prohibited credential/path/account fields.
Unknown additive fields remain forward-compatible.

### T2 — native provider acquisition

Implement one small TypeScript adapter each for Codex and Claude behind a `ProviderObservationSource` interface. Each
adapter owns a fixed source allowlist, source-specific consent/configuration, bounded network/file/CLI reads and raw
response confinement. It emits only `CollectorEnvelopeV1`; browser cookies, Keychain, broad dashboard scraping,
automatic cross-source fallback and cost scans stay out of the first slice.

The Codex adapter's only first-slice source is the installed Codex CLI's documented stable app-server protocol. After
an explicit `cli` quota-read grant, Tachyon launches `codex -s read-only -a untrusted app-server --stdio`, completes the
documented initialize handshake, checks `account/read` without requesting a proactive token refresh, and reads
`account/rateLimits/read`. Codex remains the credential owner: Tachyon never opens `auth.json`, never accepts a token,
and never calls the private ChatGPT usage endpoint directly. Account identity, raw JSON-RPC replies and stderr remain
inside the adapter and are discarded after allowlisted quota projection. Disabled consent must not launch a process;
there is no OAuth, cookie, Keychain, HTTP or automatic fallback path in this adapter.

Codex app-server's `primary` and `secondary` fields are positional rather than semantic. The adapter classifies a
documented duration up to one day as `session`, over one day through fourteen days as `weekly`, and longer durations as
`tertiary`; only a missing duration falls back to the historical primary/session and secondary/weekly slots. If two
windows collapse into the same bounded semantic lane, the response fails closed instead of inventing a label.

Keep a reference manifest containing the CodexBar repository/tag/commit used for behavioral comparison, fixture
provenance and any MIT attribution required by actually derived code. CodexBar source, binaries and Swift build inputs
must not enter the Tachyon product or release graph.

### T3 — host observation service

Create a headless service that schedules provider observations independently of view rendering. It uses one in-flight
request per provider/account scope, explicit timeouts and cancellation, bounded cadence, coalescing, and a last-good
snapshot with freshness. Hidden Runtime Ops views receive no render polling, but the observation service may refresh
at a user-configured operational cadence because provider quota is a runtime resource, not merely UI state.

This layer invokes adapters and validates `CollectorEnvelopeV1`; `RuntimeOpsSnapshotService` only projects validated
facts. It emits changes through the existing event fan-out rather than collecting per agent or per render.

### T4 — Runtime Ops projection

Extend the versioned Runtime Ops projection with provider quota cells/detail that preserve source, confidence,
freshness, reset, and unavailable reasons. Keep native token totals and account quota in separate labeled lanes.
Codex/Claude rows may share provider facts by redacted account scope, but agent rows never claim ownership of aggregate
consumption.

The existing dense-table and narrow-layout contracts remain. Add deterministic fixtures for healthy, partial,
unauthenticated, stale, incompatible-schema, and exhausted-window states, then inspect the installed panel and sidebar
placement.

### T5 — security, compatibility, and dogfood

Use hostile contract fixtures to prove no secrets, absolute paths, raw responses, emails/account ids, session tokens,
terminal lines, or unbounded vendor strings cross into the webview. Pin a fixture corpus to the chosen reference
baseline and add an upstream-radar check that identifies relevant provider changes for intentional review.

Dogfood Codex and Claude separately: compare native adapter facts with their source of truth and, optionally during
development, the pinned CodexBar reference; verify reset/freshness behavior,
stop the collector mid-request, remove credentials, hide/reveal Runtime Ops, and confirm native usage remains available
when provider collection fails.

## Key decisions

- **One Tachyon UI, one neutral domain** — CodexBar UI reuse is explicitly rejected; Runtime Ops remains the visual
  cockpit and consumes only Tachyon contracts.
- **Spike before source commitment** — CodexBar is mature, but its Swift/platform/source-closure and upstream-sync
  costs are material; the measurements justified choosing a native selective port instead of a foreign runtime.
- **Native TypeScript acquisition** — two narrow provider adapters fit Tachyon's build, security tests and lifecycle;
  shipping a large Swift helper and second release matrix for quota-only acquisition is rejected.
- **Tachyon contract at the adapter boundary** — adopting CodexBar's provider-rich `UsageSnapshot` is rejected because
  it couples Runtime Ops to upstream fields and currently lacks a general schema-version envelope.
- **Account quota is not agent attribution** — correlation is visible, but only native events may claim agent/task
  ownership.
- **Observation scheduling is host-owned** — running collectors during render is rejected because it couples network,
  auth, and subprocess latency to UI visibility and risks process storms.
- **Read-only first slice** — budgets, optimization advice, and automated response to quota remain separate follow-up
  specs so acquisition truth can be validated first.

## Candidate files and repositories

- `docs/specs/369-runtimeops-observability-v2/*` — contract, plan, execution tasks, spike evidence, and ADR.
- `src/runtimeObservability/{types,validate,service}.ts` and `src/runtimeObservability/providers/{codex,claude}.ts` —
  neutral domain, validation, scheduling, and native source adapters.
- `src/runtimeOps/{types,model,snapshotService}.ts` — project validated quota facts into the existing Runtime Ops
  snapshot without acquiring data itself.
- `src/webview/runtime-ops/{App.tsx,runtime-ops.css}` — Tachyon-owned quota/freshness rendering.
- `test/unit/runtimeObservability*.test.ts`, `test/unit/runtimeOps*.test.ts` — contract, hostile input, scheduling,
  provenance, separation, and projection tests.
- `test/browser/runtimeOpsView.test.ts`, `scripts/webview-preview/fixtures/runtime-ops.ts` — visual fixtures and layout.
- `docs/research/codexbar-headless-vendor-spike.md` plus a small reference manifest/fixture corpus — upstream radar and
  conformance evidence without a shipping CodexBar dependency.

## Risks & unknowns

- CodexBar changes quickly; the native adapters need a reproducible upstream behavior audit rather than occasional
  manual copying. The reference is a radar, not an authority over Tachyon's contract.
- Native adapters own fast-moving provider protocol and authentication behavior. Keep them small, source-explicit,
  fixture-driven and independently degradable so drift cannot corrupt the neutral domain.
- Provider endpoints and CLI RPCs are not stable public contracts. Every source needs timeout, typed degradation,
  fixtures, and provenance; upstream success does not remove Tachyon's responsibility.
- Host-initiated provider reads remain a new capability seam even without an external tool. Consent must be
  source-specific and must not expand into generic filesystem/network authority.
- Browser cookies, OAuth, Keychain, config files, and account identifiers create a larger privacy boundary than current
  local activity logs. V1 should prefer local/CLI sources and keep richer sources separately enabled.
- Provider quota and native usage can be temporally misaligned. The UI must show independent timestamps and must not
  calculate a false causal delta.
- Account switching and multiple accounts can make a runtime label ambiguous. The normalized model needs opaque scope
  keys and safe labels before multi-account UI is enabled.

## Visual impact

Runtime Ops gains a provider-capacity lane and detail for window usage, reset, confidence, source, freshness, and
unavailable state. No CodexBar visuals are reused. Risk is concentrated in distinguishing account quota from agent
tokens, narrow layouts, multiple windows, stale/error density, and avoiding a dashboard-card aesthetic that breaks
the current dense operational table. Preview fixtures plus real installed VSIX evidence are required before shipping.

## Sources consulted

- `docs/specs/367-runtime-ops-panel/{spec,plan,notes}.md` — current Runtime Ops intent, honesty rules, projection, refresh,
  and explicit V1 deferral of cost accounting, budgets, alerts, and charts.
- `src/runtimeOps/{types,model,snapshotService}.ts` and `src/runtimeUsage/model.ts` — current versioned projection and
  cumulative/delta usage semantics.
- `src/plugins/{toolPlan,toolTransaction,consentViewModel,dataLauncher}.ts` and specs 265/276/285/287 — consented,
  checksum-pinned tool distribution and external-capability boundaries.
- CodexBar `v0.43.0` repository at `5a0cbc07119ac04d998e2fd5267442ed9358fff0`, `Package.swift`,
  `Sources/CodexBarCore`, `Sources/CodexBarCLI`, and its architecture, provider, CLI, refresh, license, CI, and release
  documentation inspected 2026-07-14.
- CodexBar MIT license — modification/distribution permitted with copyright and license notice preservation.
