# 369 — RuntimeOps Observability V2 — tasks

_Drafted from `plan.md` on 2026-07-10. Work top-to-bottom. T0 is a ratification gate: do not start product
implementation until its ADR is accepted._

## T0 — vendor-strategy spike

- [x] Record the exact CodexBar release/tag/commit, license, dependency lock, release artifact hashes, toolchain, and
  supported platform matrix used by the spike.
- [x] Build or execute the headless core/CLI on Linux x86_64 and prove the required macOS/Linux architecture path from
  release artifacts or CI, without importing any UI target.
- [x] Capture redacted Codex and Claude fixtures for success, unavailable, auth failure, timeout, partial data, stale or
  last-good behavior, and local cost output where available.
- [x] Measure one-shot and any viable persistent mode: cold/warm latency, RSS, artifact size, process count, timeout,
  cancellation, and behavior when the provider CLI is already active.
- [x] Map the minimal transitive source/dependency closure for descriptors, strategies, fetchers, cache, confidence,
  quota windows, and cost; identify macOS-only and sensitive host APIs.
- [x] Prototype a Tachyon-owned `CollectorEnvelopeV1` wrapper around upstream output and prove additive-field tolerance,
  critical-field fail-closed behavior, numeric/timestamp bounds, and engine/schema version reporting.
- [x] Audit the existing provisioned-tool launcher against host-initiated periodic reads; document whether it is
  sufficient or a new narrow plugin data-source port is required.
- [x] Append an ADR to `notes.md` recommending headless Swift fork, extracted Swift subset, or selective TypeScript
  port, including repository layout, upstream-sync workflow, rejected alternatives, and estimated maintenance cost.
- [x] Obtain maintainer ratification of the ADR and whether local Codex/Claude cost totals join the first vertical slice.

## T1 — neutral observability contract

- [x] Define versioned native-usage, provider-quota, optional provider-cost, unavailable, confidence, freshness, and
  collector-envelope types outside the webview layer.
- [x] Implement bounded validation/redaction and hostile fixtures covering secrets, account identifiers, paths, raw
  errors, oversized values, unknown enums, non-finite numbers, invalid percentages, and invalid timestamps.
- [x] Add compatibility fixtures for the pinned CodexBar reference baseline and an upstream-radar command for relevant
  provider changes.
- [x] Prove native per-agent facts and aggregate provider/account facts cannot collapse into one attribution record.

## T2 — native TypeScript provider acquisition

- [x] Define a narrow `ProviderObservationSource` interface and implement separate Codex and Claude quota adapters in
  Tachyon's TypeScript stack.
- [x] Add explicit source-specific consent/configuration for every OAuth, file, network or provider-CLI read; browser
  cookies, Keychain, broad fallback and cost scans remain unavailable in the first slice.
- [x] Confine raw provider responses and credentials inside each adapter; emit only the versioned neutral envelope with
  typed unavailable diagnostics.
- [x] Record the CodexBar reference tag/commit and fixture provenance, plus MIT attribution for any actually derived
  implementation, without adding CodexBar source, binaries or Swift tooling to the product/release graph.
- [x] Add focused provider fixtures, protocol-drift degradation tests and an upstream-radar review command.

## T3 — host observation service

- [x] Add a machine-local persisted preference store that is disabled by default, creates opaque account-scope keys and
  grants only explicitly selected provider/source pairs in host-owned order; workspace configuration and ambient auth
  cannot opt a user in.
- [x] Implement an ordered source registry whose passive/native strategy runs first and whose fallbacks run only when
  separately granted; cancellation stops the chain and no OAuth/file/cookie source is inferred.
- [x] Implement one in-flight collection per provider/account scope with bounded cadence, timeout, cancellation and
  coalescing independent of agent count, Runtime Ops visibility or render frequency.
- [x] Revalidate every adapter response before retaining it; persist only bounded normalized last-good envelopes and
  project stale/expired states without raw output in activity, logs, errors, snapshots or webview messages.
- [x] Add a Claude status-line wrapper/store that projects only `rate_limits`, preserves an existing user status-line
  command and output, and fails closed when safe composition or effective precedence cannot be established.
- [x] Emit normalized observation changes through the existing host event fan-out and expose cached validated state for
  T4 without collecting from `RuntimeOpsSnapshotService` or the webview.
- [x] Prove native Runtime Ops data remains available when observation is unsupported, disabled, cancelled or failing.

## T4 — Runtime Ops projection and Tachyon-owned UI

- [x] Extend the Runtime Ops host snapshot with bounded provider quota/source/confidence/freshness/unavailable fields
  while preserving the current allowlist and schema-version discipline.
- [x] Render native token usage and provider/account quota as separate labeled lanes with independent timestamps.
- [x] Add deterministic fixtures for healthy, exhausted, partial, unauthenticated, stale, timeout, invalid-schema, and
  collector-disabled states at wide and narrow widths.
- [x] Keep all layout, copy, theming, controls, navigation, and assets in the Tachyon Runtime Ops implementation; add a
  source guard proving no CodexBar UI module or asset is imported.

## T5 — verification and dogfood

- [x] Run focused unit tests for contracts, hostile validation, scheduling, stale/last-good behavior, attribution
  separation, collector disablement, and projection.
- [x] Run browser tests and inspect wide/narrow Runtime Ops rendering for mixed native/quota and degraded states.
- [x] Obtain maintainer acceptance of live Codex and Claude dev-host dogfood, including quota/reset/freshness projection
  and graceful native-only degradation; on 2026-07-15 the maintainer accepted the live EDH evidence as sufficient and
  waived additional manual interaction captures.
- [x] Run the full Tachyon verification gate and native provider-adapter gates.
- [x] Record reference/collector versions, screenshots, commands, and verdict in `notes.md` before closure.

## Verification

- [x] Every acceptance criterion in `spec.md` has focused evidence.
- [x] The T0 ADR and cost-boundary decision are ratified before T1–T4 implementation begins.
- [x] Security fixtures prove the webview projection contains no credential, account identity, absolute path, raw
  provider response, terminal line, or unbounded vendor text.
- [x] Dev-host dogfood proves Runtime Ops remains Tachyon-owned and usable when provider collection fails.

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood -- runtime-observability`

**Human dogfood:** From the monorepo window select **Tachyon: Dev Host** and press **F5**. The prepared pointer opens
`test/fixtures/runtimeops-observability-dogfood`; do not package or install a VSIX. In the EDH window only:

1. Run **Tachyon: Open Runtime Ops**. F5 may retain prior Extension Host `globalState`; if either source is enabled,
   disable it first. Establish the baseline with both rows at `Observation disabled` and native runtimes separate.
2. Enable the Codex CLI source, refresh once, and record every visible window, used percentage, reset, source,
   confidence, observed time and freshness. If unavailable, record the typed reason without attempting credential reads.
3. Refresh and immediately disable Codex once to exercise cancellation/revocation; confirm no late result restores the
   provider lane and native runtime inventory remains present. Re-enable only if another observation is needed.
4. Enable the Claude CLI source before manually starting the fixture's `claude-observer`. Do not send an inference
   prompt merely to obtain quota; wait for passive status-line telemetry, refresh, and record the same bounded fields.
5. Stop `claude-observer`, disable both sources, and confirm account quota degrades honestly while native rows remain.
6. Resize Runtime Ops to a wide bottom panel and a narrow panel/sidebar width. Capture healthy plus one degraded state;
   verify no clipping, horizontal page scroll, identity/path/raw-response text, false agent attribution or CodexBar UI.
7. Close the EDH window and report pass/fail plus screenshots to the coordinator. Leave T5 checkboxes open until that
   live verdict is recorded.

## Visual QA

- [x] Evidence: maintainer-provided wide live EDH capture plus deterministic wide/narrow browser coverage for mixed,
  stale, exhausted and unavailable states; additional manual captures were explicitly waived on 2026-07-15.
- [x] Verdict: no clipping, horizontal page scroll, source ambiguity, false attribution, or CodexBar visual reuse.
