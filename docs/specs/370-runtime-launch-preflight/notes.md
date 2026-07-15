# 370 — runtime-launch-preflight — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-10 incident: coordinator requested `codex --model gpt-5.6`; Bridge returned spawn success and task
  `t-79dee5` was assigned, but Codex immediately emitted `invalid_request_error` because that model is not supported
  with the effective ChatGPT account. The agent was killed and the task returned to triaged.
- Live `codex-cli 0.144.1` evidence: `codex debug models` lists `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`; generic `gpt-5.6` is absent. The catalog is dynamic runtime evidence, not product data.
- Root cause: `spawn_agent` validates contract/isolation/limits, while `AgentManager.spawnCore` treats successful tmux
  creation as successful launch. `RuntimeProfile.model` explicitly contains labels/aliases only.
- Prior decision preserved: spec 328 correctly rejected Tachyon-owned dated model catalogs. This design adds a
  runtime-native dynamic preflight instead.
- 2026-07-10 maintainer ratification: delegated explicit-model launches fail closed when authoritative verification is
  unavailable; `spawn_agent` waits for bounded readiness; five seconds without ready/rejected yields
  `starting/pending`; Tasks cannot be assigned to non-ready agents.

## Deviations

- 2026-07-13 lane pilot: `npm run dogfood:runtime-launch-preflight` is now executable and deterministic. It exercises
  bounded supported/absent/malformed/timeout/non-zero/oversized fixtures plus lease cleanup; it deliberately does not
  claim T1/T2 product integration or perform a live catalog/inference request (preserving SDD 369's T0 boundary).
- Live follow-up remains coordinator-owned: explicit-model spawn currently fails when the Codex catalog exceeds the
  preflight raw-output limit. The lane exposes the oversized failure safely and never persists the raw catalog.
- 2026-07-13 catalog-growth fix: the raw 256 KiB buffer was replaced by a strict streaming JSON validator/projector.
  The probe processes at most 8 MiB, 64 JSON levels, 512 selectable entries, and 128 code units per retained slug;
  irrelevant strings are validated without being retained, and control/bidirectional formatting characters are not
  admitted into retained slugs. Malformed UTF-8/JSON, excessive depth/count/bytes, timeout, and non-zero exit remain
  fail-closed and terminate the probe process tree. No raw catalog field exists in the probe result type.
- Live bounded evidence after the fix: the authenticated `codex-cli 0.144.1` catalog was 271,154 bytes and projected
  seven selectable slugs; `gpt-5.6-terra` was present and exact generic `gpt-5.6` was absent. Only byte/count/boolean
  outcomes and selectable slugs were printed; raw metadata/base instructions were neither logged nor persisted.
- 2026-07-13 live EDH follow-up on `7c5a3ced`: invalid `gpt-5.6` failed closed before tmux/ledger/worktree; valid
  `gpt-5.6-terra` remained provisional and Task assignment was refused until the composer appeared. A clean Codex home
  required terminal-warning, directory-trust, and hook-review input first, while `write_input(answering=true)` was
  blocked by the not-ready gate. Direct fixture-private tmux answers proved the runtime could then promote normally.
- That pilot also showed the worktree launcher selecting VS Code's WSL `remote-cli/code`, which ignored the EDH
  isolation flags, and native EDH activation blocking on OS keyring without `--use-inmemory-secretstorage`. The launch
  worked only after selecting the primary checkout's cached Linux test binary and removing inherited live
  Tachyon/Codex/tmux identity from the child environment.
- Follow-up design: preserve t-f87651 by allowing no generic pre-ready input. A Codex adapter recognizes only measured
  bootstrap screens and admits their closed answer/delivery pairs when the caller explicitly sets answering intent.
  The exception does not promote readiness; notification and Task assignment gates are unchanged.
- Follow-up measurement against Codex 0.144.1 added the optional update screen and captured exact directory/hook text.
  Update option 1 is deliberately excluded because it mutates the global CLI install. Hook overview/review screens
  accept only their measured one-byte `t` or Escape gestures; Escape provides a no-trust path to readiness. A narrow
  80-column composer can omit `Context %`, so the stable model/effort/cwd footer prefix is also a readiness affordance.
- 2026-07-14 native EDH dogfood exposed a desktop-only persistent Bridge failure: the Extension Host's
  `process.execPath` was the Electron `code` binary, so `systemd-run` launched it without Node mode and it exited cleanly
  without creating a control socket. Linux transient units now set `ELECTRON_RUN_AS_NODE=1`; detached non-Linux daemon
  children receive the same explicit environment. The live fixture then published protocol 1 on its derived port.
- The same shutdown audit found that raw fixture deletion would orphan that intentionally persistent proxy after the EDH
  closed. `clean` now validates real, canonical fixture/descriptor/socket identity, requests `stop`, waits for socket
  removal, and fails closed on symlinks before deleting any fixture files.
- Live bounded pilot on baseline `7c5a3ced` plus the working-tree fixes: exact `gpt-5.6` returned
  `runtime_model_unavailable` and created no agent row; exact `gpt-5.6-terra` spawned provisionally, admitted only the
  measured terminal-warning and directory-trust answers, then reached the narrow ready footer. Readiness was proven by
  an empty `submit:false` receipt (`typed-unsubmitted`); no Task, contract, notification, or inference prompt was sent.
  The valid agent was killed/dismissed, the persistent service stopped, fixture/port/unit disappeared, and the lane
  lease returned free. Bounded evidence: `.tachyon/evidence/sdd370-edh/live-bridge-dogfood.json`.
- 2026-07-14 pre-commit review tightened three boundaries before integration: cache-resolved VS Code binaries now apply
  the same WSL `remote-cli/code` rejection as explicit/PATH candidates; narrow-footer readiness requires a model-shaped
  token plus a path-shaped cwd; and fixture cleanup records/refuses a live EDH, bounds ownership files, stops the
  identity-matched persistent Bridge, and kills only the fixture-private tmux server before deletion.

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

- None before T1 implementation; empirical adapter details may still refine the plan without weakening the ratified
  fail-closed/readiness invariants.

## Dogfood log

### 2026-07-13T21:08:15Z — pass (1/1) — source: tasks.md — commit: 23130cea1c1cf8046c1b09ac306de80d92c1bb0e
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-13T21:12:09Z — pass (1/1) — source: tasks.md — commit: 9ac4907217d689d8e2c14f058bcdf1b9dc8af30a
- `npm run dogfood:runtime-launch-preflight` — pass


### 2026-07-13T21:46:30Z — pass (1/1) — source: tasks.md — commit: adfc030fa32827deb8cb74c7b7edf8eaf2c5f174
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T00:20:38Z — pass (1/1) — source: tasks.md — commit: 7c5a3ced58ccaf2def95bad30da44d7ad4209998
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T00:38:47Z — pass (1/1) — source: tasks.md — commit: 7c5a3ced58ccaf2def95bad30da44d7ad4209998
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T00:40:55Z — pass (1/1) — source: tasks.md — commit: 7c5a3ced58ccaf2def95bad30da44d7ad4209998
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T15:51:14Z — pass (1/1) — source: tasks.md — commit: 7c5a3ced58ccaf2def95bad30da44d7ad4209998
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T15:55:08Z — pass (1/1) — source: tasks.md — commit: 95cc7d56269160548fa810c6b7432459c808dff6
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T15:58:02Z — pass (1/1) — source: tasks.md — commit: 62baa22f38d71bb0f4f57ad9f2db263ba3640cd3
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T16:03:43Z — pass (1/1) — source: tasks.md — commit: 002f7066c09d371e775a8efbc273bf8a76b0341a
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-14T16:04:20Z — main EDH product-path pass — commit: 002f7066c09d371e775a8efbc273bf8a76b0341a
- `node scripts/dev-host/lane.mjs run --owner codex-budget --target main -- npm run dogfood:dev-host -- headless` — pass
- Native Extension Development Host S1 passed all eight checks: fail-visible frame, config failure, degraded and
  disk-backed roster, LKG visibility and spawn refusal, Doctor execution, and config recovery.
- Screenshot: `.tachyon/evidence/dev-host/fail-visible.png`.
- Governed cleanup removed `/tmp/tachyon-dev-host/default`; persistent Bridge was absent and the lane lease is free.

## Verification log

### 2026-07-13T21:46:09Z — pass (1/1) — source: tasks.md
- `npm run verify:full` — pass

### 2026-07-14T00:38:03Z — pass (1/1) — source: tasks.md
- `npm run verify:full` — pass

### 2026-07-14T00:40:25Z — pass (1/1) — source: tasks.md
- `npm run verify:full` — pass
