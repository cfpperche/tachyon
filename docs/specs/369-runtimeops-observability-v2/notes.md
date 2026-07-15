# 369 — runtimeops-observability-v2 — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-10 maintainer clarification: "vendor CodexBar" means reuse/evolve its collection engine, never its visual
  interface. Runtime Ops remains the sole product surface.
- 2026-07-10 initial boundary: treat CodexBar as a mature acquisition implementation and reference architecture, not
  as Tachyon's canonical domain. Preserve upstream provenance while mapping into a versioned Tachyon envelope.
- 2026-07-14 T0 spike candidate: recommend a thin downstream headless Swift fork pinned to CodexBar `v0.43.0`
  (`5a0cbc07119ac04d998e2fd5267442ed9358fff0`) with a Tachyon-only envelope/entrypoint and first-party plugin
  distribution. Extracted Swift subset and selective TypeScript port are rejected for v1; maintainer ratification is
  still required. Full evidence: `docs/research/codexbar-headless-vendor-spike.md`.
- 2026-07-14 cost boundary recommendation: quota windows join the first slice; local cost scans remain a separately
  consented follow-up because the measured cold scan took 17.42 s / 159,352 KiB RSS and raw Codex cost output includes
  project paths.
- 2026-07-14 maintainer ratification supersedes the initial Swift-fork candidate: implement small native TypeScript
  adapters for Codex and Claude quota acquisition. CodexBar remains a non-shipping behavioral reference, fixture oracle
  and upstream-change radar. Quota-only v1 is ratified; local cost scans remain deferred.
- 2026-07-14 integration review hardened the experimental envelope timestamp boundary: JavaScript `Date.parse`
  normalizes impossible calendar dates, so accepted RFC 3339 input must round-trip to the identical canonical instant
  or fail closed.
- 2026-07-14 T1 established `CollectorEnvelopeV1` as a fresh allowlisted projection rather than a trusted cast. One
  malformed required fact rejects the whole envelope to a bounded typed unavailable result; unknown additive fields
  are ignored, hostile getters are read once, arrays are dense and bounded, and no input value enters diagnostics.
- 2026-07-14 T1 made attribution structurally disjoint: native usage requires an agent/workspace scope, while quota
  requires a provider-account scope with a Tachyon-owned opaque `ps_` digest key. Neither scope can validate as the
  other, so aggregate account quota cannot silently acquire an agent identity.
- 2026-07-14 quota-only is enforced in the schema: `ProviderCostFactV1` reserves a unit-safe future shape, but it is not
  a member of `RuntimeObservationFactV1` and `CollectorEnvelopeV1` rejects `provider-cost` in V1. No cost source,
  scanner, scheduler, persistence, projection or UI was added.
- 2026-07-14 CodexBar provenance stays outside the runtime contract. The development-only reference manifest pins
  `v0.43.0`, its annotated tag/commit, MIT license and synthetic fixture hashes; normalized envelopes contain only a
  Tachyon collector id/version. `npm run check:runtime-observability-reference` validates those pins and can compare a
  candidate checkout only across allowlisted Codex/Claude paths. No CodexBar source, binary, Swift input or package
  dependency enters the product graph, and no upstream code was copied, so there is no derived-code NOTICE obligation.
- Mission Control context: parent design task `t-ed03b3`; vendor-strategy research task `t-79dee5`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The measured spike initially favored retaining upstream authentication behavior in a thin Swift fork. Before any
  product implementation, the maintainer chose native stack ownership for this strategic ADE capability and accepted
  the narrower Codex/Claude quota scope needed to make that port maintainable. The ADR and execution plan were updated;
  no production implementation was discarded.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- The optional Swift artifact is large (41.98 MiB archive; 131.95 MiB unstripped / 74.02 MiB stripped executable),
  but preserves mature OAuth/CLI/cache/cancellation behavior. Keeping it in an opt-in plugin is preferable to
  reimplementing credential-sensitive provider protocols inside Tachyon core.
- Upstream `serve` proved one-process coalescing and approximately 1 ms warm reads, but its raw identity-rich,
  unauthenticated loopback contract is not a suitable Tachyon boundary. Reuse the behavior, not the endpoint.
- The existing provisioned-tool launcher is adequate for checksum-pinned distribution and execution integrity, not
  periodic host reads: it is synchronous and lacks bounded capture, timeout, cancellation and cadence. SDD 369 needs
  a narrow observation-source port, never a generic plugin execution API.
- The ratified TypeScript port gives up upstream's ready-made OAuth/protocol implementation and assumes provider-drift
  maintenance. In return, Tachyon avoids a 74.02 MiB stripped helper, Swift release matrix and external process seam,
  while keeping scheduling, validation and lifecycle in one stack. Provider adapters must therefore remain small,
  source-explicit, independently degradable and fixture-driven.

## Open questions

_Historical pre-ratification questions are retained below; their resolutions follow in the next section._

- Maintainer ratification pending: accept the thin Swift fork plus a new narrow read-only observation-source port; the
  current provisioned-tool launcher remains the distribution/integrity primitive but is insufficient as a scheduler.
- Maintainer cost decision pending: accept quota-only v1 and defer local cost scans, or expand the first slice despite
  the measured latency/RSS/privacy boundary.
- Dedicated downstream `tachyon-usage-engine` fork is recommended; never copy engine source or binaries into the VSIX
  core without a new maintainer decision.

## Resolutions

- Resolved 2026-07-14: no downstream engine fork or production CodexBar binary. Build native TypeScript provider
  adapters behind an internal read-only observation-source interface.
- Resolved 2026-07-14: ship Codex and Claude quota windows first; defer cost.
- Resolved 2026-07-14 in T1: the lightweight upstream radar is a read-only development command over a pinned manifest,
  fixture hashes and an explicit watched-path allowlist; it is not a release/runtime dependency.
- Resolved 2026-07-14 in T2a: the first Codex source is the installed Codex CLI's stable app-server method
  `account/rateLimits/read`, exposed by Codex `0.144.4` / tag `rust-v0.144.4` / commit
  `8c68d4c87dc54d38861f5114e920c3de2efa5876`. It is classified as source `cli`, not `oauth`: Codex owns token storage,
  refresh and the upstream request while Tachyon owns the bounded JSON-RPC client and quota projection.
- T2a consent is fail-closed and source-specific. Only an explicit user-controlled `provider-quota-read` grant for
  `cli` may launch `codex -s read-only -a untrusted app-server --stdio`; disabled or mismatched selection launches
  nothing. Browser cookies, Keychain, direct `auth.json`, direct ChatGPT HTTP, broad `auto` fallback, account usage,
  reset-credit consumption and cost remain unavailable.
- The Codex protocol sequence is fixed: `initialize`, `initialized`, `account/read` with `refreshToken: false`, then
  `account/rateLimits/read`. The account read exists only to distinguish unauthenticated/unsupported states; email,
  plan, credentials, raw replies, JSON-RPC error text and stderr are never copied into diagnostics or envelopes.
  Official Codex documentation warns that file-backed `auth.json` contains access tokens and must be treated as a
  password, which is why direct credential-file access was rejected even though CodexBar's OAuth path proved viable.
- A live adapter dogfood on 2026-07-14 returned a sole 10,080-minute window in app-server's `primary` slot. That proved
  the slot name is not a safe `session` label. T2a now classifies bounded lanes by `windowDurationMins` (short/session,
  medium/weekly, long/tertiary), uses slot order only when duration is absent, and fails duplicate semantic lanes closed.
  The dogfood emitted one validated quota fact, no diagnostics, and left no app-server child behind; no raw response,
  identity, percentage or reset timestamp was recorded in the repository.
- Resolved 2026-07-14 in T2b: Claude Code `2.1.209` exposes quota through its documented token-free status-line JSON as
  optional `rate_limits.five_hour` and `rate_limits.seven_day` windows. The first Claude source is therefore `cli`: a
  narrow passive-capture reader feeds bounded JSON into the adapter, which retains only percentage/reset facts. The
  installed CLI has documented `claude auth status --json` but no documented headless quota subcommand; auth status is
  only a fallback classifier and all email/organization fields remain confined and discarded.
- T2b treats missing telemetry from an authenticated runtime as typed `not-observed`. It does not run an inference turn,
  scrape interactive `/usage`, silently install/replace a status line, or invent zero. Host-side status-line transport,
  non-destructive composition and freshness are T3 work; T2b supplies the parser/reader boundary only.
- Direct Claude subscription OAuth/credential-file HTTP is rejected as a fallback despite the CodexBar spike proving it
  technically viable. It expands the privacy boundary and Anthropic's current legal guidance reserves plan OAuth for
  native Anthropic applications rather than third-party products. Future SDK rate-limit events may join the ordered
  strategy only when an already-running, explicitly authorized runtime emits them; Tachyon never spawns `claude -p`
  just to measure quota.
- Resolved 2026-07-14 in T3 planning: provider observation preferences are machine-local, extension-global and disabled
  by default. A workspace file, installed CLI or ambient credential cannot grant access. Each explicit provider enable
  persists an ordered source list plus a random opaque account-scope key; disabling/changing the grant aborts collection,
  clears last-good state and rotates the key on a later enable. T4 will own the visible controls for this T3 boundary.
- T3 fallback is host-ordered but never ambient: the cheapest passive/native granted strategy runs first, then only
  other separately granted sources. Caller order cannot promote OAuth ahead of `cli`; source presence is still an
  explicit independent grant. Cancellation ends the cascade. All returned envelopes are validated again before a
  bounded normalized last-good value or change event is retained; provider work is global per opaque scope rather than
  per agent or render.
- Anthropic's documented precedence makes command-line `--settings` override local/project/user scalar settings, while
  managed settings remain higher. Therefore the Claude transport must resolve and wrap an existing lower-layer
  `statusLine` command, relay its output, and write only a reduced `rate_limits` capture to extension global storage.
  It skips capture for an existing command-line `--settings`, malformed/unsafe settings or effective managed override;
  it never silently replaces a user's status line and adds no Tachyon status-line text of its own.
- Resolved 2026-07-14 in T3 implementation: the observation host is extension-global and independent of workspace,
  agent and view count. It serializes consent lifecycle changes, coalesces provider/account refreshes, revalidates exact
  opaque scope/source/freshness, clones cached envelopes across every consumer boundary and isolates synchronous or
  asynchronous fan-out listener failures. The pre-existing native `RuntimeOpsSnapshotService` remains collector-free;
  disabled or degraded provider observation can only request its normal cached refresh and cannot remove native facts.
- Claude capture is limited to the default Claude home or a Tachyon-owned `.tachyon/harness/<agent>` home, whose
  credentials are seeded from the same default account. An arbitrary external `CLAUDE_CONFIG_DIR` fails closed so two
  unknown accounts cannot be collapsed into one opaque provider/account scope. Each running session remains bound to
  the prior status-line command resolved at its spawn, while capture files contain only bounded numeric projections of
  `rate_limits.five_hour` and `rate_limits.seven_day`.
- Pre-merge T3 review: capture relays are bounded and scope-neutral so revocation can atomically remove the active
  marker and reduced captures without deleting the command needed by a live Claude session to preserve its prior user
  status line. A revoked wrapper no longer buffers or parses status-line input. Claude forks now cross the same settings
  composition path, while explicit `--setting-sources` keeps ownership hooks but fails capture closed. The host's
  effective default `CLAUDE_CONFIG_DIR` now follows every lifecycle path and the same HarnessManager credential source;
  an ambient or inherited external account therefore reaches the transport boundary and is rejected rather than being
  silently treated as `~/.claude`.
- T3 visual QA opt-out: this slice deliberately adds no visible controls, fields, copy or layout. T4 owns the first
  Runtime Ops projection and its wide/narrow visual evidence.

## Verification log

### 2026-07-14T16:34:51Z — pass (1/1) — source: tasks.md
- `npm run verify:full:quiet` — pass

### 2026-07-14T17:34:58Z — pass (1/1) — source: tasks.md
- `npm run verify:full:quiet` — pass

### 2026-07-14T19:01:40Z — pass (5/5) — source: task t-71f42a
- `npx vitest run test/unit/codexAppServerSource.test.ts test/unit/runtimeObservabilityValidate.test.ts` — 44 passed
- `npm run check:runtime-observability-reference` — pinned fixtures pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — 334 files passed; 4,055 tests passed; 3 skipped
- Live explicit-grant Codex app-server dogfood — one validated weekly quota fact, no diagnostic, no surviving child;
  raw response and account identity were neither printed nor persisted.

### 2026-07-14T20:45:41Z — pass (5/5) — source: task t-32cd68
- `npx vitest run` over the Claude adapter, Codex adapter and neutral validator suites — 67 passed
- `npm run check:runtime-observability-reference` — pinned Codex and Claude fixture hashes pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — 335 files passed; 4,079 tests passed; 3 skipped
- Live explicit-grant Claude fallback dogfood — the bounded adapter returned one validated `not-observed` fact for an
  authenticated installation with no passive capture, projected no identity fields, and left no auth-status child.
  Passive quota success remains fixture-proven until T3 supplies the non-destructive host capture transport.

### 2026-07-14T18:13:54Z — T1 neutral contract

- `npm exec vitest run test/unit/runtimeObservabilityValidate.test.ts test/unit/runtimeObservabilityReference.test.ts`
  — pass, 28/28 focused tests.
- `npm run check:runtime-observability-reference` — pass; manifest and pinned fixture hashes valid.
- `npm run check:runtime-observability-reference -- --repo .tachyon/reference/codexbar-v0.43.0 --candidate HEAD`
  — pass; official-origin annotated `v0.43.0` baseline clean across watched Codex/Claude paths.
- `npm run typecheck` — pass.
- `npm run verify:full:quiet` — pass; 331 files, 3,996 passed, 3 skipped.

### 2026-07-14T22:14:19Z — pass (1/1) — source: tasks.md
- `npm run verify:full:quiet` — pass

### 2026-07-14T22:21:36Z — T3 final consolidation

- `npm run typecheck` — pass.
- Focused provider preference/service, Claude capture/source, Codex source, session ownership, harness, agent manager and
  headless workspace suites — pass, 513/513 tests.
- `npm run dogfood:runtime-observability` — pass with real installed Codex app-server acquisition, synthetic Claude
  process capture, same-scope request coalescing and no raw status-line persistence.
- `npm run verify:full:quiet` — pass; 339 files, 4,121 passed, 3 skipped.
- Security regressions: a redirected `.tachyon/harness` root or child whose real path escapes through a symlink fails
  closed before Claude settings or capture materialization.

### 2026-07-14T23:18:38Z — pass (1/1) — source: tasks.md

- `npm run verify:full:quiet` — pass

### 2026-07-14T23:20:00Z — T3 pre-merge review hardening

- Review found and fixed three lifecycle blockers: revocation no longer breaks an already-running user status line,
  Claude forks now receive the same capture/settings composition, and a preference change cannot publish a late result.
- Explicit `--setting-sources` keeps ownership hooks but omits capture; capture never adds a fork permission mode.
- The host's effective default Claude config home now follows spawn, restart, resume, fork and transcript resolution;
  inherited external homes reach the transport boundary and fail closed instead of being treated as `~/.claude`.
- `npm run typecheck` — pass.
- Nine focused provider/capture/lifecycle suites — pass, 520/520 tests.
- `npm run dogfood:runtime-observability` — pass through the SDD dogfood runner.
- `npm run verify:full:quiet` — pass; 339 files, 4,128 passed, 3 skipped.

## Dogfood log

### 2026-07-14T22:14:58Z — pass (1/1) — source: tasks.md — commit: 46f181c6d7b3ade91e8570fa180494391e8539df
- `npm run dogfood:runtime-observability` — pass

### 2026-07-14T23:18:32Z — pass (1/1) — source: tasks.md — commit: dfa9137417c40e0e22cec26076ff86051d9606dd
- `npm run dogfood:runtime-observability` — pass

## T4 implementation log

### 2026-07-14 — Runtime Ops provider-capacity projection and UI

- Runtime Ops now emits schema V2 with a bounded top-level `providerCapacity` lane while retaining schema V1 as a
  mounted-webview compatibility input. Provider capacity is structurally account-wide: neither the opaque host scope
  key nor any workspace/agent identity crosses the webview boundary.
- `RuntimeOpsSnapshotService` receives a narrow synchronous cached-state reader. Snapshot construction and rendering
  never launch a collector; a broken cached reader degrades only provider capacity and leaves native inventory intact.
- Codex and Claude have explicit disabled-by-default CLI controls in the Tachyon-owned Runtime Ops UI. Enabling commits
  the source-specific consent before the observation service refreshes in the background; disabling revokes that
  provider source. Webview actions are a closed provider/boolean allowlist and cannot select or inject a source.
- Native token usage and provider quota are separate labeled lanes with independent observation timestamps. The
  provider lane discloses source, confidence, freshness, resets and honest unavailable reasons; the actual T3 stale
  shape of one bounded last-good quota fact plus an unavailable companion is projected without exposing diagnostics.
- Deterministic preview fixtures cover healthy, exhausted, partial, unauthenticated, stale, timeout, invalid-schema and
  disabled states. Browser coverage exercises every state at 1100x760 and 340x900, including horizontal-overflow,
  attribution, redaction and keyboard-focus checks.
- Advisory visual QA passed for the Tachyon-owned dense operational layout after changing the ambiguous `Disable CLI`
  copy to `Disable source`. Captures are staged under `.tachyon/vqa/visual-qa/` for post-commit evidence attachment.
  Installed VSIX/live Codex and Claude dogfood remains deliberately open in T5; this T4 commit is not closure evidence.

### 2026-07-15T00:26:58Z — T4 verification

- Focused Runtime Ops projection, snapshot, view and preview suites — pass, 80/80 tests.
- `npm run typecheck` — pass.
- `npx vitest run --config vitest.browser.config.ts test/browser/runtimeOpsView.test.ts --reporter=verbose` — pass,
  4/4 browser tests across all provider states at wide and narrow widths.
- `npm run verify:full:quiet` — pass; 342 files, 4,148 tests passed, 3 skipped.
