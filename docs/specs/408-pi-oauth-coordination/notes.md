# Notes — 408 Pi OAuth coordination

## 2026-07-18 — installed Pi v0.80.10 research

Detailed read-only report: `/tmp/pioauthresearch-sdd408.md`.

Pi stores one whole credential per provider in `auth.json` and locks refresh by auth pathname. Independent private files cannot safely be reconciled after concurrent rotating-token refresh: `expires` is a threshold rather than a revision, mtime is whole-file noise, and tokens are opaque. Pi caches valid credentials in memory, further ruling out a generic live-copy protocol.

The safe choices were (A) one live OAuth writer or (B) an upstream shared auth-file/store hook. The human explicitly authorized B. The private config-home boundary remains; only credential authority becomes shared.

Upstream source was cloned read-only-first from `https://github.com/earendil-works/pi.git` at `3da591ab74ab9ab407e72ed882600b2c851fae21` (package version 0.80.10) into `/tmp/earendil-pi-sdd408` for patch preparation. No push or remote mutation is authorized yet.

## 2026-07-18 — upstream patch prepared locally

Local upstream branch `feat/shared-auth-file` now contains commit `28e128018283a944333e31ba1000e51322b57a81` (`feat(coding-agent): support shared auth file`). It adds the branded auth-file environment contract, routes all CLI credential surfaces through it, adds explicit SDK/service `authPath`, suppresses cross-home legacy migration, documents the security boundary, exposes the variable in `--help`, and proves rotating refresh serialization with two synchronized Node child processes sharing one literal path.

Review artifact: `/tmp/pi-shared-auth-file.patch` (SHA-256 `9f865793380fad182581030f195507c32af7aa32719b12d943dceb2aac3f13b4`), recoverable from the local upstream commit. The upstream branch has not been pushed.

Independent review initially found two coverage/public-surface issues; both were fixed. Final verdict: **ACCEPT**, report `/tmp/piauthreview.md`.

Upstream verification:

- `npm run check`: passed (Biome, pinned deps, import checks, shrinkwrap/install-lock checks, `tsgo --noEmit`, browser smoke).
- Focused Vitest: 19/19 passed across path/migration/help, same-process storage, and two-process refresh tests.
- Full coding-agent suite was attempted but the source checkout lacks generated `packages/ai/src/providers/data/*.json` artifacts, causing broad import failures plus environment-specific clipboard assertions; this is a checkout-generation limitation, not a patch regression. The focused affected tests and full static check are green.

## Verification baseline

Research-only run before implementation:

- Upstream/Tachyon task worktree `npm run typecheck`: passed.
- Tachyon `npm run verify:full:quiet`: failed on five previously known/baseline assertions; see the research report for the retained log pointer. No SDD 408 production code existed at that point.
