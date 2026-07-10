# 369 — RuntimeOps Observability V2 — plan

_Drafted from `spec.md` on 2026-07-10. Implementation after the T0 vendor-strategy gate is ratified._

## Approach

Deliver one Tachyon-owned observability pipeline with two deliberately separate source classes:

1. **Native execution facts** continue to come from normalized Tachyon activity (`usage.updated`) and retain each
   runtime's cumulative-versus-delta semantics and agent/workspace attribution.
2. **Provider/account facts** come from a headless collection engine derived from CodexBar collectors, then cross a
   versioned, bounded process boundary into a Tachyon-owned neutral model. They are never assigned to an agent merely
   because that agent uses the same runtime.

The implementation starts with a feasibility gate rather than assuming a source layout:

### T0 — vendor-strategy spike

Use the latest stable CodexBar release available when the spike starts (`v0.41.0` is the 2026-07-10 baseline) and
record its exact commit. Build or consume the released CLI on Linux x86_64 first, then prove the supported macOS/Linux
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

No product collector or UI work starts until this gate is ratified.

### T1 — neutral observability domain

Add a domain below Runtime Ops, not inside its webview snapshot service. Its first contract should model:

- `NativeUsageFact`: workspace/agent/runtime attribution plus input, output, cache-read, cache-write, semantics, source,
  and observed time;
- `ProviderQuotaFact`: provider, redacted account scope, named window, used percent or remaining amount, reset, window
  duration, confidence, source strategy, observed time, freshness, and unavailable reason;
- optional `ProviderCostFact`: currency/unit-safe aggregate and time range, only if the post-spike ratification includes
  it;
- `CollectorEnvelopeV1`: schema version, engine version/build, collector/provider, generated time, facts, and bounded
  typed diagnostics.

Validation is allowlist-by-construction. It rejects non-finite numbers, out-of-range percentages, invalid timestamps,
unknown required enums, oversized arrays/strings, raw error bodies, and any prohibited credential/path/account fields.
Unknown additive fields remain forward-compatible.

### T2 — headless engine and distribution

Implement the T0 decision outside Tachyon's UI. The expected shape is a downstream headless engine repository or
source subtree that emits `CollectorEnvelopeV1`, plus a first-party `tachyon-plugins` plugin that provisions signed or
checksum-pinned artifacts for supported platforms. The plugin manifest and consent surface disclose that the binary
may invoke provider CLIs/read configured local sources and makes unsupported platforms explicit.

Keep an upstream provenance manifest containing repository URL, tag/commit, license files, downstream patch list,
toolchain/dependency pins, and artifact SHA-256 values. Do not silently execute an unpinned system `codexbar` binary.

### T3 — host observation service

Create a headless service that schedules provider observations independently of view rendering. It uses one in-flight
request per provider/account scope, explicit timeouts and cancellation, bounded cadence, coalescing, and a last-good
snapshot with freshness. Hidden Runtime Ops views receive no render polling, but the observation service may refresh
at a user-configured operational cadence because provider quota is a runtime resource, not merely UI state.

This layer owns process execution and validates `CollectorEnvelopeV1`; `RuntimeOpsSnapshotService` only projects
validated facts. It emits changes through the existing event fan-out rather than spawning collectors per agent.

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
terminal lines, or unbounded vendor strings cross into the webview. Pin a fixture corpus for the chosen engine build
and add an upgrade check that runs the new candidate engine against the adapter before changing the pin.

Dogfood Codex and Claude separately: compare engine facts with their source of truth, verify reset/freshness behavior,
stop the collector mid-request, remove credentials, hide/reveal Runtime Ops, and confirm native usage remains available
when provider collection fails.

## Key decisions

- **One Tachyon UI, one neutral domain** — CodexBar UI reuse is explicitly rejected; Runtime Ops remains the visual
  cockpit and consumes only Tachyon contracts.
- **Spike before source commitment** — the engine is mature but Swift/platform/source-closure and upstream-sync costs
  are material; choosing a fork or port without evidence would turn a dependency decision into permanent architecture.
- **First-party plugin distribution** — Tachyon's existing policy keeps headless capabilities out of core and already
  provides consented, checksum-pinned binary provisioning; bundling a large Swift engine in the VSIX is rejected.
- **Tachyon contract at the process boundary** — adopting CodexBar's provider-rich `UsageSnapshot` is rejected because
  it couples Runtime Ops to upstream fields and currently lacks a general schema-version envelope.
- **Account quota is not agent attribution** — correlation is visible, but only native events may claim agent/task
  ownership.
- **Observation scheduling is host-owned** — running collectors during render is rejected because it couples network,
  auth, and subprocess latency to UI visibility and risks process storms.
- **Read-only first slice** — budgets, optimization advice, and automated response to quota remain separate follow-up
  specs so acquisition truth can be validated first.

## Candidate files and repositories

- `docs/specs/369-runtimeops-observability-v2/*` — contract, plan, execution tasks, spike evidence, and ADR.
- `src/runtimeObservability/{types,validate,service,sources}.ts` — proposed neutral domain, validation, scheduling, and
  source adapters; exact layout is ratified after T0.
- `src/runtimeOps/{types,model,snapshotService}.ts` — project validated quota facts into the existing Runtime Ops
  snapshot without acquiring data itself.
- `src/webview/runtime-ops/{App.tsx,runtime-ops.css}` — Tachyon-owned quota/freshness rendering.
- `test/unit/runtimeObservability*.test.ts`, `test/unit/runtimeOps*.test.ts` — contract, hostile input, scheduling,
  provenance, separation, and projection tests.
- `test/browser/runtimeOpsView.test.ts`, `scripts/webview-preview/fixtures/runtime-ops.ts` — visual fixtures and layout.
- `cfpperche/tachyon-plugins/<runtime-observability-plugin>/` — first-party manifest/config and pinned engine artifacts.
- Dedicated downstream engine fork/repository or plugin source subtree — chosen by T0; never copied into the VSIX core
  without a new maintainer decision.

## Risks & unknowns

- CodexBar changes quickly; a raw source copy would accumulate security and provider drift. The chosen method needs a
  reproducible upstream merge/audit routine, not occasional manual copying.
- `CodexBarCore` is large and its common `UsageSnapshot` contains provider-specific fields. The actual minimal source
  closure may make selective extraction less maintainable than a fork.
- Swift runtime/toolchain and binary size may be unacceptable on some Tachyon platforms. Released static Linux assets
  are large enough that size must be measured rather than dismissed.
- Provider endpoints and CLI RPCs are not stable public contracts. Every source needs timeout, typed degradation,
  fixtures, and provenance; upstream success does not remove Tachyon's responsibility.
- Host-initiated plugin tool execution on a cadence may be a new authority seam. It must not become a generic
  execute-any-plugin command or bypass install consent.
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
- CodexBar `v0.41.0` repository, `Package.swift`, `Sources/CodexBarCore`, `Sources/CodexBarCLI`, and its architecture,
  provider, CLI, refresh, license, CI, and release documentation inspected 2026-07-10.
- CodexBar MIT license — modification/distribution permitted with copyright and license notice preservation.
