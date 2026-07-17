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

## Closure audit — 2026-07-17

Verdict: **SDD 370 remains in progress.** The current implementation fixes the original ad-hoc Codex incident and its
catalog-growth regression, but it does not yet satisfy the ratified cross-runtime/effective-environment contract.

What is already sound on current `main` (`2443aa6e`):

- token-aware command parsing rejects ambiguous shell composition and preserves exact requested-model semantics;
- the Codex adapter probes the prospective wrapper/binary path, incrementally validates a bounded catalog, retains
  only bounded selectable slugs, and returns redacted allowlisted failures;
- ordinary declared/ad-hoc spawn and autostart share `spawnCore`; restart and resume call preflight before tmux
  replacement; Codex launches use a bounded five-second readiness observation;
- Codex readiness blocks `write_input`, `notify_agent`, and Task assignment until a measured composer appears, and
  recognized bootstrap answers remain closed and explicit;
- known-invalid static preflight runs before worktree creation, tmux creation, ledger/lineage/delegator persistence,
  Bridge binding, and `onSpawned`;
- focused current-HEAD verification passed: 505 tests across runtime preflight, streaming catalog, readiness recovery,
  AgentManager, and Bridge.

Blocking gaps found by source audit:

1. **The probe does not use the effective private Codex environment.** `assertLaunchPreflight` runs before
   `applyHarness`; default Codex launches subsequently materialize a private `CODEX_HOME`, copy the real
   `config.toml`, symlink `auth.json`, and overwrite any earlier `CODEX_HOME` in the launch environment. The probe
   therefore observes the pre-materialization environment while the runtime uses the private home. Spawn, restart,
   and resume all have this ordering. Resume additionally ignores the persisted `resume.configHome` during preflight.
2. **There is no runtime adapter registry or honest `unverifiable` policy at the lifecycle boundary.**
   `AgentManager.assertLaunchPreflight` is hard-coded to basename `codex`; explicit-model Claude/Grok/other commands
   bypass it as if supported. That conflicts with the ratified delegated-spawn fail-closed policy and leaves no
   product-visible distinction between verified and unverifiable.
3. **Readiness is Codex-only and does not observe process exit.** `observeLaunchReadiness` returns immediately for
   every non-Codex runtime, while `LaunchReadiness.wait` only captures pane text and never checks tmux liveness or an
   exit code. A runtime with no stable classifier is therefore treated as ready, and an unclassified immediate exit
   can time out as `pending` instead of `rejected`.
4. **Lifecycle coverage is present but unproven and incomplete.** Declared start/autostart reach `spawnCore`, and
   restart/resume call the Codex preflight; however there is no catalog-drift regression matrix for those paths.
   Native fork is currently Claude-only, performs no launch preflight, and its readiness call is a non-Codex no-op.
   Resume also clears readiness/stopping state before its model preflight, so a rejection is not strictly
   side-effect-free.
5. **Bridge outcomes are not structured.** `RuntimeLaunchPreflightError` contains a code/model/suggestions internally,
   but the generic Bridge `fail` projection emits only text for it. `AgentManager.observeLaunchReadiness` returns
   `void`, so `spawn_agent` reports ordinary success for both `ready` and `pending`; callers cannot consume a typed
   `ready | starting | rejected` result.
6. **Post-tmux compensation is intentionally conservative but not closed against the SDD contract.** Readiness
   rejection kills and verifies the session and revokes its token, but preserves a prepared worktree lock and leaves
   the materialized private home. This may be the correct recovery policy once a runtime could have written data, but
   the artifact invariant is not explicitly specified or covered by the required no-residue/recovery tests.

Required implementation slices before closure:

- introduce a shared prospective-launch preparation object that resolves the exact command, effective safe env, and
  private-home/config identity once; use it for both probe and launch, with explicit rollback/recovery ownership;
- replace the Codex basename branch with an adapter registry and explicit policy application for the `supported`,
  `unsupported`, `unverifiable`, and `failed` results at every lifecycle entry point;
- make readiness return a typed state, include tmux death/exit observation, and preserve `pending` without promoting
  unverifiable runtimes to ready;
- project preflight/readiness errors through Bridge structured content and add the lifecycle drift/no-side-effect
  matrix for declared spawn, autostart, restart, resume, and the currently supported fork path;
- ratify and test the post-tmux artifact policy (automatic rollback only before runtime ownership can write; otherwise
  durable quarantine/recovery with bounded cleanup of credentials and private homes when safe).

## Closure implementation — 2026-07-17

- The lifecycle now materializes the prospective runtime home once and passes its exact environment plus resolved cwd
  to both the runtime-native probe and the eventual launch. A rejected first-time private home is removed; a home that
  predated the attempt is never treated as cleanup authority.
- `RuntimeLaunchPreflightRegistry` makes missing capabilities explicit. Delegated/ad-hoc explicit-model launches fail
  closed on `unverifiable`; declared launches may remain honest and proceed into bounded provisional startup rather
  than being mislabeled as catalog-verified.
- Ordinary spawn/autostart, restart, resume, and fork all revalidate. Fork performs an early source-environment probe
  before worktree creation and repeats it in a distinct prospective worktree cwd before transcript seeding or tmux.
- Pre-tmux failures persist no agent identity. Fresh ordinary preparation is handed to the existing receipt-aware
  rollback/quarantine path; known model drift is caught before fork checkout creation. Once tmux may have executed
  runtime code, cleanup kills and proves the session absent and revokes its token, while any checkout stays locked as
  recovery state because ignored/runtime writes cannot be excluded safely.
- Readiness now observes fatal auth/model/config output and process death for the ratified first provider set: Codex,
  Claude, and Grok. Codex retains its measured classifier; Claude/Grok require a profile-backed composer affordance for
  `ready`. A live target runtime with no positive affordance remains `starting`, and Task/notification/input gates
  continue to reject it. Other runtime families retain their prior lifecycle until separately measured.
- Bridge failures expose closed structured codes for preflight and readiness, including nested recovery aggregates;
  ordinary spawn success exposes `{ agent, session, state: ready | starting }`. Raw catalogs, environment values, auth
  files, config paths, and provider bodies never enter those results.
- Focused closure gate: typecheck plus 515 tests across preflight, streaming catalog, readiness, AgentManager, and
  Bridge passed. `npm run verify:full:quiet` then passed 413 files / 4,766 tests with 3 skipped. Maintainer Dev Host/F5
  visual review remains the final gate before closure/merge.

### 2026-07-17 — pass — review candidate

- `npm run verify:full:quiet` — pass (413 files; 4,766 passed; 3 skipped)
