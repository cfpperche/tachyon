# CodexBar headless vendor spike — RuntimeOps Observability V2

_Task: `t-79dee5` · measured 2026-07-14 · proposal pending maintainer ratification_

## Executive result

Recommend a **thin downstream headless Swift fork** pinned to CodexBar `v0.43.0`, with a new Tachyon-specific
entrypoint that accepts only Codex/Claude source choices and emits `CollectorEnvelopeV1`. Distribute it only through a
first-party, checksum-pinned plugin. Do not vendor the CodexBar UI, ship its raw JSON contract, or expose its
unauthenticated localhost server as Tachyon's product boundary.

The upstream CLI is operationally credible on Linux today: both already-authorized OAuth collectors succeeded, the
long-lived process coalesces work and serves warm results in roughly 1 ms, cancellation is clean, and official assets
cover Linux glibc/musl plus macOS on x86-64/arm64. The optional plugin boundary makes its size tolerable. Rewriting the
collectors in TypeScript now would trade a measurable binary cost for a much larger authentication/protocol correctness
and security burden. Extracting a Swift subset is the worst option because the provider code shares one large,
cross-provider `CodexBarCore` module and `UsageSnapshot`.

For the first vertical slice, ship **quota windows only**. Defer local cost scans: the measured cold scan took 17.42 s,
peaked at 159,352 KiB RSS, and its raw Codex payload contains project paths. Warm cache improved to 1.50 s / 96,880 KiB,
but this remains a separate capability and privacy boundary.

## Pinned upstream baseline

| Fact | Measured value |
|---|---|
| Repository | `https://github.com/steipete/CodexBar` |
| Latest stable at spike start | `v0.43.0`, published 2026-07-14 12:48:37Z |
| Annotated tag object | `0f491b285c51b908ee8e9b3c018ac7699bccdaee` |
| Commit | `5a0cbc07119ac04d998e2fd5267442ed9358fff0` |
| License | MIT, copyright 2026 Peter Steinberger; retain copyright and permission notice |
| Package contract | Swift tools 6.2; release workflow installs Swift 6.2.1 |
| Locked non-UI dependencies | Commander 0.2.2, SweetCookieKit 0.4.1, swift-crypto 3.15.1, swift-log 1.13.2, swift-asn1 1.7.1 |
| Host used | WSL2/Linux x86-64; no local Swift toolchain |

Official CLI release assets and GitHub-provided digests:

| Target | Archive bytes | SHA-256 |
|---|---:|---|
| Linux glibc x86-64 | 41,981,743 | `7932cb52d29cdc2499e20618455d970c5098906141fa18f2d949f98327c68f21` |
| Linux glibc arm64 | 41,352,076 | `8d12bb3816084f29a7bef471b500c6cbde15df265875925364da9d392f6b5bc7` |
| Linux musl x86-64 | 77,980,287 | `cfec17559bca49fe656caf10558858dbead09fb1f24f402e2fde552936c930f0` |
| Linux musl arm64 | 76,284,817 | `330beb7034702e0b591f8eac7560c53bf12f7060ed1987b60d110aeb68b65006` |
| macOS x86-64 | 8,191,478 | `5f117250a577f0eb17a388a6bbf15a49a9db16128c47607f6778af01793eb803` |
| macOS arm64 | 7,876,804 | `22a544f163a7c84e670c91835eb3db5e659ba301194d1ad88fa7626f8478011b` |

The downloaded Linux glibc archive matched its published digest. Its executable is a dynamically linked, unstripped
ELF of 131,954,968 bytes. `strip --strip-unneeded` reduced an experimental copy to 74,018,472 bytes and it still reported
`CodexBar 0.43.0`. Runtime dependencies include libc, sqlite3, curl, TLS/crypto and their transitive system libraries.

Upstream CI builds and smoke-tests Linux x86-64/arm64, builds musl variants with the pinned Swift static SDK, and
publishes macOS x86-64/arm64 assets. This host executed the official artifact instead of installing a new Swift
toolchain; source-build reproducibility remains a downstream-fork CI responsibility.

## Live collection measurements

Commands used the official Linux x86-64 artifact, an isolated secret-free CodexBar config, existing provider OAuth
state, a 30-second external timeout, and mode-0600 raw captures under ignored spike storage. Raw payloads were inspected
only through allowlisted projections and were not committed.

### One-shot `usage --json-only`

| Provider/source | Cold wall | Warm wall | Peak RSS | Result |
|---|---:|---:|---:|---|
| Codex OAuth | 1.30 s | 1.20 s | 50,112 / 49,728 KiB | success; exact confidence; partial live shape (weekly present, primary absent) |
| Claude OAuth | 0.40 s | 0.40 s | 49,152 / 48,768 KiB | success; session + weekly + extra windows |

Both success payloads contained identity/account fields. Codex additionally emitted credits and pace. Neither response
had a top-level schema version or engine build envelope. These fields must never cross directly into RuntimeOps.

A coexistence rerun completed successfully while two `codex` and three `claude` processes were already active on the
Tachyon development host. The counts were unchanged after both OAuth reads and no collector child remained. This
proves the OAuth path coexists with active provider CLIs; it does not claim that the upstream CLI-source path is
reentrant.

### Persistent `serve`

| Observation | Result |
|---|---:|
| Idle RSS | 32,640 KiB |
| RSS after provider reads | 53,256 KiB |
| Codex first request | 1.087 s |
| Codex cached request | 0.0010 s |
| Claude OAuth first request after explicit config | 0.315 s |
| Claude cached request | 0.0011 s |
| Process model | one server process; no provider child remained after requests |
| Cancellation | SIGINT exited 0 immediately; listener and process disappeared |

With the default `auto` source on this Linux host, Claude returned a typed provider error after 8.001 s and repeated the
same 8-second attempt on the next request because there was no last-good value. Explicit `source: oauth` fixed the path.
Tachyon must choose a consented source explicitly rather than inherit broad upstream fallback behavior.

The source implements one in-flight operation per key, request deadlines, a 60-second default fresh cache and a
last-good policy of ten refresh intervals (minimum five minutes, maximum one hour). For usage responses, stale fallback
replaces an error row with its cached last-good row without adding a stale marker. Tachyon must therefore derive
freshness from the preserved observation timestamp and its own scheduling policy; it cannot trust an upstream boolean.

Synthetic redacted fixtures cover success, partial, unavailable, auth failure, timeout, unmarked last-good, stale and
hostile payloads in
`test/fixtures/codexbar-vendor-v0.43.0.json`. A forced 50 ms external timeout exited 124 with no output and no surviving
`codexbar` process. No credential was removed or corrupted for this spike: the auth-failure and unmarked-last-good
cases are explicit synthetic contract fixtures, while success, provider-unavailable and external-timeout behavior were
measured live.

The upstream server is a useful behavior reference, not the ship boundary: it binds loopback without auth and returns
the raw identity-rich payload. The fork should expose bounded one-shot JSON or a parent-owned stdio daemon instead.

## Source closure and sensitive surfaces

| Scope | Swift files | Lines |
|---|---:|---:|
| `CodexBarCore` | 437 | 117,832 |
| `CodexBarCLI` | 26 | 9,577 |
| Codex-named Core/CLI files | 38 | 7,411 |
| Claude-named Core/CLI files | 39 | 14,307 |

The named-provider counts understate the closure. Both providers depend on shared `UsageFetcher`, provider registry and
descriptors, config/token-account routing, HTTP/OAuth, process/PTY execution, logging, caching, cost models and CLI
serialization. `UsageSnapshot` itself carries fields for many unrelated providers, so an extracted two-provider target
would require repeated surgery across exhaustive provider switches and shared models rather than a clean file copy.

The package keeps UI targets behind `#if os(macOS)`, so CLI/Core build on Linux without SwiftUI. Core still contains
conditional Keychain, Security, WebKit/browser-cookie and session-focus code. Sensitive source categories include:

- OAuth credential files/history and delegated refresh;
- Codex/Claude CLI subprocess and PTY sessions;
- browser cookies, manual cookie headers, Keychain and WebKit paths;
- provider config API keys/token accounts;
- local Codex/Claude histories and project paths for cost scans.

The Tachyon wrapper must compile and invoke only an explicit source allowlist. Browser, cookie, Keychain and cost
capabilities remain disabled unless separately consented.

## Tachyon plugin seam audit

The existing plugin tool pipeline is sufficient for **distribution trust**: per-platform/archive pins, consent and
lockfile provenance, content-addressed installation, `O_NOFOLLOW`/ownership/mode/hash validation before execution, and
Linux procfd execution of the validated inode.

It is not sufficient for **host-scheduled observation**. `_tachyon-tool` is an agent/skill/hook CLI, uses synchronous
`spawnSync`, has no host cadence/coalescing/timeout/cancellation contract, and its captured stdout is not bounded or
schema-validated. Calling it from every RuntimeOps render would create the polling/process storm the spec forbids.

Add a narrow, read-only observation-source port that reuses the provisioned-tool resolver but owns async process
lifecycle, fixed argv/env, output byte limits, timeout/cancellation, one in-flight request per provider scope, cadence,
last-good freshness and `CollectorEnvelopeV1` validation. It must not become a generic execute-plugin-tool API.

The experimental wrapper in `scripts/spikes/codexbar-vendor/collectorEnvelope.ts` proves the boundary can tolerate
unknown additive fields; record schema/engine/upstream versions; allowlist quota/source/confidence/time facts; reject
invalid numbers/durations/timestamps and duplicate providers; admit only explicit OAuth/CLI quota sources; and map
failures without copying messages, paths, identity, credentials or credits.

## ADR: vendor strategy

**Status:** proposed — maintainer ratification required before SDD 369 T1–T4.

**Decision:** maintain a dedicated downstream headless Swift fork based on upstream release tags. Add a small
`TachyonUsageCLI` product/entrypoint with a versioned envelope and only Codex/Claude quota commands. Distribute pinned
artifacts through a first-party plugin; keep all Tachyon UI and the canonical domain in this repository.

Repository workflow:

1. Dedicated `tachyon-usage-engine` fork retains upstream history and MIT license.
2. Pin a released upstream tag/commit; record dependency lock, patch inventory and artifact hashes.
3. Keep downstream commits small: new target/envelope, source allowlist, redaction, fixtures and release workflow.
4. For upgrades, merge the next stable tag, run upstream Linux/macOS gates, wrapper contract fixtures and hostile
   redaction tests, then update plugin hashes in a separate reviewed change.
5. Do not vendor source or binaries into the Tachyon VSIX/core.

### Rejected alternatives

- **Extracted Swift subset — reject.** It appears smaller but would fork shared models/provider switches across a
  127k-line Core/CLI closure. Upstream merges become manual source archaeology, losing the main advantage of reuse.
- **Selective TypeScript port — reject for v1.** It would reduce artifact/toolchain footprint and fit Tachyon's stack,
  but reimplements fast-moving OAuth, CLI RPC/PTY, reset and fallback behavior. Reconsider only if a dedicated stripped
  Swift target cannot meet an explicit optional-plugin budget (proposed: archive <= 50 MiB, executable <= 80 MiB,
  quota RSS <= 64 MiB).
- **Ship upstream CLI unchanged — reject.** Its raw contract exposes identities and unrelated provider fields, lacks a
  schema envelope, enables broad source fallback, and its HTTP mode is unauthenticated loopback.

## Ratification requested

1. Accept the thin downstream headless Swift fork and the new narrow host observation-source port.
2. Keep the first vertical slice quota-only; defer local cost totals to a separately consented follow-up.

No product implementation starts until both decisions are confirmed.
