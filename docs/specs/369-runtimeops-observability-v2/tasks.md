# 369 — RuntimeOps Observability V2 — tasks

_Drafted from `plan.md` on 2026-07-10. Work top-to-bottom. T0 is a ratification gate: do not start product
implementation until its ADR is accepted._

## T0 — vendor-strategy spike

- [ ] Record the exact CodexBar release/tag/commit, license, dependency lock, release artifact hashes, toolchain, and
  supported platform matrix used by the spike.
- [ ] Build or execute the headless core/CLI on Linux x86_64 and prove the required macOS/Linux architecture path from
  release artifacts or CI, without importing any UI target.
- [ ] Capture redacted Codex and Claude fixtures for success, unavailable, auth failure, timeout, partial data, stale or
  last-good behavior, and local cost output where available.
- [ ] Measure one-shot and any viable persistent mode: cold/warm latency, RSS, artifact size, process count, timeout,
  cancellation, and behavior when the provider CLI is already active.
- [ ] Map the minimal transitive source/dependency closure for descriptors, strategies, fetchers, cache, confidence,
  quota windows, and cost; identify macOS-only and sensitive host APIs.
- [ ] Prototype a Tachyon-owned `CollectorEnvelopeV1` wrapper around upstream output and prove additive-field tolerance,
  critical-field fail-closed behavior, numeric/timestamp bounds, and engine/schema version reporting.
- [ ] Audit the existing provisioned-tool launcher against host-initiated periodic reads; document whether it is
  sufficient or a new narrow plugin data-source port is required.
- [ ] Append an ADR to `notes.md` recommending headless Swift fork, extracted Swift subset, or selective TypeScript
  port, including repository layout, upstream-sync workflow, rejected alternatives, and estimated maintenance cost.
- [ ] Obtain maintainer ratification of the ADR and whether local Codex/Claude cost totals join the first vertical slice.

## T1 — neutral observability contract

- [ ] Define versioned native-usage, provider-quota, optional provider-cost, unavailable, confidence, freshness, and
  collector-envelope types outside the webview layer.
- [ ] Implement bounded validation/redaction and hostile fixtures covering secrets, account identifiers, paths, raw
  errors, oversized values, unknown enums, non-finite numbers, invalid percentages, and invalid timestamps.
- [ ] Add compatibility fixtures for the chosen engine baseline and an upgrade-gate command for candidate pins.
- [ ] Prove native per-agent facts and aggregate provider/account facts cannot collapse into one attribution record.

## T2 — vendored headless engine and plugin distribution

- [ ] Create the T0-selected downstream engine layout with upstream provenance, MIT LICENSE/NOTICE, patch inventory,
  reproducible build inputs, and a versioned JSON IPC that emits only the neutral envelope.
- [ ] Retain only headless collection behavior; exclude SwiftUI, menu bar, widgets, updater, visual assets, and CodexBar
  application preferences from distributed artifacts.
- [ ] Implement Codex and Claude collectors with explicit source selection, timeout, cancellation, typed errors, and
  redacted diagnostics.
- [ ] Create a first-party plugin manifest/config that provisions checksum-pinned supported-platform artifacts,
  surfaces unsupported platforms, and discloses each source's CLI/file/credential access.
- [ ] Add source and binary build/test/release gates; publishing/tagging remains separately maintainer-gated.

## T3 — host observation service

- [ ] Add an explicit configuration/consent boundary for enabling provider observations and source strategies.
- [ ] Implement one in-flight collection per provider/account scope with bounded cadence, timeout, cancellation,
  coalescing, and last-good freshness semantics.
- [ ] Validate every engine response before persistence/projection and keep raw output out of activity, logs, snapshots,
  errors, and webview messages.
- [ ] Emit normalized observation changes through the existing event fan-out without one process per agent or render.
- [ ] Prove native Runtime Ops data remains available when the plugin is absent, unsupported, disabled, or failing.

## T4 — Runtime Ops projection and Tachyon-owned UI

- [ ] Extend the Runtime Ops host snapshot with bounded provider quota/source/confidence/freshness/unavailable fields
  while preserving the current allowlist and schema-version discipline.
- [ ] Render native token usage and provider/account quota as separate labeled lanes with independent timestamps.
- [ ] Add deterministic fixtures for healthy, exhausted, partial, unauthenticated, stale, timeout, invalid-schema, and
  plugin-absent states at wide and narrow widths.
- [ ] Keep all layout, copy, theming, controls, navigation, and assets in the Tachyon Runtime Ops implementation; add a
  source guard proving no CodexBar UI module or asset is imported.

## T5 — verification and dogfood

- [ ] Run focused unit tests for contracts, hostile validation, scheduling, stale/last-good behavior, attribution
  separation, plugin absence, and projection.
- [ ] Run browser tests and capture wide/narrow Runtime Ops evidence for mixed native/quota and degraded states.
- [ ] Dogfood Codex and Claude independently against the selected source, compare resets/percentages/freshness, cancel
  an in-flight collector, remove/expire access, and confirm graceful native-only degradation.
- [ ] Run the full Tachyon verification gate and the downstream engine/plugin gates.
- [ ] Record artifact hashes, engine/upstream versions, screenshots, commands, and verdict in `notes.md` before closure.

## Verification

- [ ] Every acceptance criterion in `spec.md` has focused evidence.
- [ ] The T0 ADR and cost-boundary decision are ratified before T1–T4 implementation begins.
- [ ] Security fixtures prove the webview projection contains no credential, account identity, absolute path, raw
  provider response, terminal line, or unbounded vendor text.
- [ ] Installed-host dogfood proves Runtime Ops remains Tachyon-owned and usable when provider collection fails.

**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `npm run dogfood:runtime-observability`

**Human dogfood:** Open the installed Runtime Ops panel with Codex and Claude observations enabled; compare each quota
window and reset with its provider source, inspect native token separation, then disable/remove the collector and
confirm the panel degrades to honest native-only data.

## Visual QA

- [ ] Evidence: wide bottom-panel and narrow sidebar screenshots for mixed, stale, exhausted, and unavailable states.
- [ ] Verdict: no clipping, horizontal page scroll, source ambiguity, false attribution, or CodexBar visual reuse.
