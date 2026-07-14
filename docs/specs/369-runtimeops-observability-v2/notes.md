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
- Mission Control context: parent design task `t-ed03b3`; vendor-strategy research task `t-79dee5`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

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

## Open questions

- Maintainer ratification pending: accept the thin Swift fork plus a new narrow read-only observation-source port; the
  current provisioned-tool launcher remains the distribution/integrity primitive but is insufficient as a scheduler.
- Maintainer cost decision pending: accept quota-only v1 and defer local cost scans, or expand the first slice despite
  the measured latency/RSS/privacy boundary.
- Dedicated downstream `tachyon-usage-engine` fork is recommended; never copy engine source or binaries into the VSIX
  core without a new maintainer decision.

## Verification log

### 2026-07-14T16:34:51Z — pass (1/1) — source: tasks.md
- `npm run verify:full:quiet` — pass
