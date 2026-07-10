# 369 — RuntimeOps Observability V2

_Created 2026-07-10 from the maintainer discussion about token economics and CodexBar._

**Status:** draft

## Intent

Runtime Ops V1 observes Tachyon-managed runtimes honestly from local activity, lifecycle, attention, session, and
Bridge state. It already reports input/output/cache token totals and normalized throttles, but it cannot explain
account-level quota windows, resets, confidence, or provider-derived cost facts. That leaves an ADE unable to answer
the operational question behind a long agent run: what did this run consume, which account/runtime limit is binding,
and when is capacity available again?

Build the next observability layer behind Tachyon's existing Runtime Ops interface. Tachyon keeps its own UI and owns
the canonical, versioned usage/quota domain. A headless collection engine derived from the MIT-licensed CodexBar
engine is the leading implementation candidate because its provider collectors, fallback strategies, quota windows,
cost scanner, confidence, caching, and stale/error behavior already cover much of the acquisition problem. The first
step is a bounded vendor-strategy spike that decides whether to maintain a headless Swift fork, extract a smaller
Swift subset, or port selected collectors. No CodexBar visual surface, menu-bar behavior, or application state enters
Tachyon.

The first product slice correlates Tachyon-native per-agent token facts with provider/account quota facts for Codex
and Claude. It preserves provenance and unavailable states, never treats aggregate account usage as per-agent
attribution, and never reads or transmits credentials without an explicit installed capability and user-controlled
source configuration.

## Acceptance criteria

- [ ] **Scenario: Compare vendor strategies before choosing an implementation**
  - **Given** CodexBar's current released core/CLI and Tachyon's plugin/runtime boundaries
  - **When** the vendor-strategy spike exercises Codex and Claude collection on supported hosts
  - **Then** it records reproducible build/runtime evidence, source closure, binary footprint, cold/warm latency,
    credential surfaces, output-contract gaps, upstream-sync cost, and a decision among headless fork, extracted
    subset, or selective port
- [ ] **Scenario: Observe provider quota beside native agent usage**
  - **Given** Tachyon has native activity usage for an agent and the collection engine has a valid Codex or Claude
    account-level quota observation
  - **When** Runtime Ops builds its projection
  - **Then** it shows native input/output/cache facts separately from normalized quota windows, reset times, source,
    confidence, freshness, and account scope without implying that aggregate quota consumption belongs to that agent
- [ ] **Scenario: Explain unavailable or stale provider data**
  - **Given** a collector is unsupported, unauthenticated, timed out, stale, or returned an incompatible payload
  - **When** the observation reaches Runtime Ops
  - **Then** the UI exposes a bounded source-specific unavailable/stale reason and last-good timestamp without zero,
    fabricated percentages, raw provider responses, terminal text, or credentials
- [ ] **Scenario: Keep sensitive collection opt-in and scoped**
  - **Given** a source could read OAuth state, cookies, Keychain entries, provider config, local histories, or invoke a CLI
  - **When** the capability is installed or enabled
  - **Then** the user sees the source and required access, Tachyon invokes only allowlisted collectors, and no secret,
    account identifier, absolute path, raw response, or session token crosses the normalized Runtime Ops projection
- [ ] **Scenario: Survive engine and upstream changes**
  - **Given** a pinned engine build emits extra fields, omits a required field, changes a type, or reports non-finite or
    out-of-range values
  - **When** Tachyon decodes the engine response
  - **Then** unknown additive fields are tolerated, invalid critical facts fail closed to unavailable, the schema and
    engine version are recorded, and contract fixtures detect incompatible upgrades before release
- [ ] **Scenario: Refresh without hidden polling storms**
  - **Given** Runtime Ops is hidden or several fleet events occur in a burst
  - **When** provider observations are scheduled
  - **Then** collection follows an explicit bounded cadence, coalesces concurrent work, serves last-good data where
    policy permits, and does not introduce one background provider process per agent or per render
- [ ] **Scenario: Render only Tachyon-owned UI**
  - **Given** observability data came from a CodexBar-derived collector
  - **When** a user opens Runtime Ops
  - **Then** all visible layout, labels, interaction, theming, and navigation are Tachyon-owned Runtime Ops components
    and no CodexBar SwiftUI, menu, widget, icon, screenshot, or application preference is embedded
- [ ] The canonical host contract is versioned, allowlist-by-construction, provider-neutral, and distinguishes native
  usage, provider quota, context pressure, monetary cost, rate-limit events, and user-defined budgets as different facts
- [ ] Codex and Claude are the only required provider collectors for the first vertical slice; additional providers use
  the same adapter contract and are follow-up work
- [ ] Vendored or forked source and distributed binaries preserve required MIT copyright/license notices and record the
  exact upstream repository, tag/commit, downstream patches, build inputs, and artifact hashes
- [ ] The collection engine remains headless and replaceable: Runtime Ops consumes Tachyon's normalized domain, never
  the CodexBar `UsageSnapshot` or CLI payload directly

## Non-goals

- Reuse, embed, or visually imitate the CodexBar menu-bar application, SwiftUI, widgets, icons, or settings UI
- Make CodexBar or its current JSON payload the canonical Tachyon data model
- Support CodexBar's full provider catalog in the first slice
- Implement budgets, automatic model routing, automatic compaction, quota-based scheduling, or other control actions
- Claim per-agent attribution from account-level quota or billing data
- Enable browser-cookie, Keychain, OAuth, dashboard scraping, or remote API sources silently
- Choose Swift fork versus extraction versus TypeScript port without spike evidence
- Replace Runtime Ops, Mission Control, Activity, or the agent terminal with a new observability surface
- Ship historical charts or a general analytics database in the first slice; bounded last-good snapshots and the
  existing native activity history are sufficient until retention requirements are designed

## Ratified decisions

- **Tachyon owns the interface.** CodexBar is considered only for its headless collection engine.
- **Tachyon owns the domain.** Provider collectors map into a small, versioned Tachyon contract with explicit source,
  confidence, freshness, scope, and unavailable semantics.
- **Native and aggregate facts stay separate.** Tachyon owns per-agent/task attribution; provider collectors own
  account/plan quota and aggregate cost facts.
- **Observability precedes control.** This spec measures and explains; later specs may add recommendations, budgets,
  and governed automation.
- **Sensitive sources are capability-gated.** Local or already-authenticated sources are preferred, but are not assumed
  harmless; every source keeps provenance and an explicit access boundary.

## Open questions

- **Vendor shape — spike-owned:** headless downstream fork of `CodexBarCore`, extracted Swift subset, or selected
  TypeScript port. The spike must recommend one and state the rejected alternatives.
- **Repository shape — spike-owned:** a dedicated Tachyon usage-engine fork plus a first-party plugin that provisions
  its artifacts, or a source subtree inside the plugin repository. The Tachyon core remains free of bundled plugins.
- **Host invocation seam — design-owned:** whether the existing provisioned-tool launcher is sufficient for a
  host-initiated read-only observation source or a narrow, consented plugin data-source port is required.
- **Cost boundary — maintainer ratification after spike:** whether Codex/Claude local cost totals join the first slice
  or land immediately after quota windows; historical charts remain out of scope either way.
