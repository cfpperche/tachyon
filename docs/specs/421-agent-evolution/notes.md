# 421 — agent-evolution — notes

_Created 2026-07-21._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-21 — The maintainer directed all remaining SDD 421 work to stay in one isolated managed
  worktree. Tachyon created
  `/home/goat/.cache/tachyon/worktrees/b349073a/change/agent-evolution` on
  `tachyon/change/agent-evolution` from spec commit `ea6b50df`.
- 2026-07-21 — The maintainer approved the architecture in `plan.md` without changes. The spec moved
  to `in-progress`; implementation will follow the five sequential slices in `tasks.md`.
- 2026-07-21 — Mission Control decomposition: umbrella `t-6c351f`; Slice 1 `t-87cc14`; Slice 2
  `t-fc8279`; Slice 3 `t-0fa8ba`; Slice 4 `t-cec393`; Slice 5 `t-6218bf`. Dependencies enforce the
  approved delivery order.
- 2026-07-21 — Task completion reviews live under `evolution/reviews/`. The Task write commits first;
  review creation, notice delivery and Studio refresh are best-effort observers that cannot revert it.
- 2026-07-21 — A review is bound to the Bridge-resolved agent and one completion revision. Identical
  replay returns the original result; different replay, wrong-agent access and failed reviews reject.
- 2026-07-21 — The session ledger keeps the complete immutable Evolution snapshot, in addition to its
  version/digest. Resume and rebind need no reinjection; fork and re-anchor can reuse the exact old
  content even after a human approves a newer active version.
- 2026-07-21 — A fresh restart resolves the current canonical profile again. Changing only `cmd`
  therefore changes the executor while preserving the same profile identity, version and snapshot.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- 2026-07-21 — Agent Studio runtime copy was added to `l10n/bundle.l10n*.json`, not
  `package.nls*.json`: the latter localizes contribution-point titles, while the former is the existing
  `vscode.l10n.t` bundle for host-projected webview labels. The product behavior from the plan is unchanged.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Independent review correction

- 2026-07-21 — Independent review at `1271c60a` blocked merge: promotion was multi-file but not
  recoverable; a committed Task could lose its asynchronous review; active workspace bytes were not
  bound to host-verifiable human approval; runtime-switch dogfood exercised the helper from Node rather
  than through a switched runtime. Full evidence is in
  `.tachyon/reports/agent-evolution-code-review-2026-07-21.md`.
- 2026-07-21 — The spec returned from `shipped-partial` to `in-progress`. Corrective follow-ups:
  `t-24ffb7`, `t-67ece9`, `t-0b7aa6`, `t-5f212f`.
- 2026-07-21 — Promotion now writes a durable intent before active files, commits the host-custodied
  HMAC freshness head last, rolls back when the old head remains, and accepts an already-committed
  result when the new head won. Fault tests cover every boundary plus skill-update restoration.
- 2026-07-21 — Opt-in Task completion stores a reconstructible revision marker in the committed Task.
  Reload reconciles missing reviews idempotently and production wiring surfaces creation failures.
- 2026-07-21 — Direct edits to active learning now fail startup authority verification. The first live
  target attempt (Grok) could not start because the installed CLI was not authenticated; no browser was
  opened. The runtime-switch proof then used an authenticated fresh Codex session after Grok→Codex,
  which read `SKILL.md`, ran `scripts/check.sh` through its normal tools and wrote the expected marker.
- 2026-07-21 — Final post-correction verification: focused recovery/reload/authority suites passed
  122/122; `npm run verify:full:quiet` passed 462 files and 5,236 tests with 3 skipped; final
  `npm run typecheck` passed; targeted SDD close remained clean.

## Architecture validation

- 2026-07-21 — `git diff --check` passed; SDD ids are unique; no scaffold placeholders remain.
- 2026-07-21 — `npm run verify:full:quiet` passed: 457 files, 5,180 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed.

## Slice 1 validation

- 2026-07-21 — Focused config/schema/YAML/Studio/protocol/EvolutionStore coverage passed: 220 tests.
- 2026-07-21 — `npm run verify:full:quiet` passed: 458 files, 5,192 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed after the final Slice 1 changes.

## Slice 2 validation

- 2026-07-21 — Focused TaskStore, EvolutionStore, Coordinator, Bridge, auth and engine coverage passed:
  129 tests across the directly affected suites.
- 2026-07-21 — `npm run verify:full:quiet` passed: 460 files, 5,202 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed after the final Slice 2 changes.

## Slice 3 validation

- 2026-07-21 — Focused promotion, prompt, startup inventory, ledger, AgentManager, fork, re-anchor and
  Workspace coverage passed: 554 tests across the directly affected suites.
- 2026-07-21 — `npm run test:invariants` passed: PI-001's existing promise/oracle and evidence mechanics
  were unchanged, so no independent mechanics-equivalence review was triggered.
- 2026-07-21 — `npm run verify:full:quiet` passed: 461 files, 5,210 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed after the final Slice 3 changes.

## Slice 4 validation

- 2026-07-21 — The Agent Studio loads a bounded overview through the persistent engine and exact
  learning/skill file content only when a proposal is opened. Approve/Reject carry the observed profile
  version and target digest; an older window gets a visible conflict and refreshed state.
- 2026-07-21 — Focused Agent Studio, persistent-client and engine protocol coverage passed: 111 tests,
  including empty/loading, failed review, approved/rejected and stale-conflict projections.
- 2026-07-21 — `npm run verify:full:quiet` passed after the Slice 4 implementation.
- 2026-07-21 — `npm run typecheck` passed after the Slice 4 implementation.

## Slice 5 validation

- 2026-07-21 — Rename moves the complete canonical Evolution Profile, rewrites ownership metadata and
  preserves profile identity, active version and skill bytes. Destination conflicts leave both profiles
  unchanged, and the Workspace restores the prior manager/config identity.
- 2026-07-21 — Explicit forget/delete removes the Evolution Profile. Disabling retains but deactivates
  it, while runtime changes keep the same canonical profile.
- 2026-07-21 — Startup parity passed for Claude, Codex, Antigravity, Gemini, OpenCode, Grok, Hermes and
  Pi through their existing delivery channels. Focused lifecycle, engine, Agent Studio and runtime tests
  passed: 503 tests across seven suites.
- 2026-07-21 — Deterministic dogfood drove real Task completion observation for an empty review and a
  proposed review, rejected the learning, approved a standard skill with executable helper script,
  proved current-session version 0 versus next-session version 1, and preserved the profile across a
  Codex-to-Grok runtime change.
- 2026-07-21 — The real Extension Development Host used the declared `reviewer` agent with Agent
  Evolution enabled. Agent Studio displayed the pending learning and complete multi-file `repo-check`
  skill, then projected the human decisions as rejected/approved with active version 1 and no pending
  proposals. Canonical disk inspection confirmed empty active `LEARNINGS.md`, approved `SKILL.md`, and
  executable `scripts/check.sh` mode `0700`.

## Visual QA

- Evidence: `.tachyon/evidence/421-agent-evolution/empty.png`, `pending-list.png`,
  `pending-learning.png`, `pending-skill.png` and `approved.png` capture the real Agent Studio flow in
  the Extension Development Host. The narrow-width capture remains pending.
- Verdict: the wide layout keeps identity/instructions/evolution distinct, proposal summaries scan
  cleanly, learning detail is readable, and the multi-file skill exposes both `SKILL.md` and its helper
  script before approval. The approved/rejected state and next-session warning remain unambiguous.
- Fix after inspection: Persistent Instructions still named only four historical runtimes. The help is
  now host-localized and runtime-neutral: delivery occurs at startup through the selected runtime when
  supported. Component/adapter/localization tests cover the projected copy.
- 2026-07-21 — The maintainer explicitly accepted the narrow Agent Evolution card without requesting
  another screenshot. No synthetic narrow artifact was created; the recorded evidence remains the five
  real Extension Development Host captures listed above.
- 2026-07-21 — Local implementation closure uses `shipped-partial`: all product behavior and acceptance
  evidence are complete on the isolated branch, while push/merge, worktree removal and branch deletion
  remain a separate maintainer-authorized publication step.

## Dogfood log

### 2026-07-21T20:12:04Z — pass (1/1) — source: tasks.md — commit: e0856eaa52ceece045adc2826c2cfc4835261b8a
- `npm exec -- vite-node scripts/dogfood-agent-evolution.mts` — pass


### 2026-07-21T22:16:37Z — pass (1/1) — source: tasks.md — commit: 1271c60ad6849c633dc0210e4ec5775652512030
- `TACHYON_AGENT_EVOLUTION_LIVE_RUNTIME=codex npm exec -- vite-node scripts/dogfood-agent-evolution.mts` — pass

### 2026-07-21T23:19:23Z — pass (1/1) — source: tasks.md — commit: 1271c60ad6849c633dc0210e4ec5775652512030
- `TACHYON_AGENT_EVOLUTION_LIVE_RUNTIME=codex npm exec -- vite-node scripts/dogfood-agent-evolution.mts` — pass

### 2026-07-21T23:59:09Z — pass (1/1) — source: tasks.md — commit: 1271c60ad6849c633dc0210e4ec5775652512030
- `TACHYON_AGENT_EVOLUTION_LIVE_RUNTIME=codex npm exec -- vite-node scripts/dogfood-agent-evolution.mts` — pass
## Verification log

### 2026-07-21T20:12:10Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm run test:invariants` — pass
- `npm run verify:full:quiet` — pass

## Closure validation

- 2026-07-21 — `sdd-close.sh docs/specs/421-agent-evolution` passed with no closure
  inconsistencies.
- 2026-07-21 — Final `npm run typecheck` passed.
- 2026-07-21 — The first final `npm run verify:full:quiet` encountered one unrelated live tmux
  cgroup-test failure. Its focused suite immediately passed 7/7 and the full rerun passed 462 files,
  5,225 tests with 3 skipped. Backlog bug `t-5f6355` owns investigation of the nondeterministic process
  selection; the original failure remains recorded rather than being hidden by the green rerun.

### 2026-07-21T22:16:54Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm run test:invariants` — pass
- `npm run verify:full:quiet` — pass

### 2026-07-21T23:18:06Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm run test:invariants` — pass
- `npm run verify:full:quiet` — pass

## Second corrective review validation

- 2026-07-21 — Workspace now injects its authority-configured Evolution snapshot resolver into the
  real AgentManager startup path. A headless Workspace test proves first-session profile creation is
  authorized and valid-but-unapproved learning bytes block the actual spawn route.
- 2026-07-21 — EvolutionStore captures profile, learning and skill bytes together and compares the
  authority MAC calculated from those exact bytes. A deterministic test swaps in transient valid bytes,
  restores the approved file before the final head read and still observes a fail-closed rejection.
- 2026-07-21 — SecretStorage authority custody now supports compare-and-swap retire and atomic identity
  move. Lifecycle tests prove rename permits reuse of the old name, delete permits recreation of the
  deleted name, and a move committed before its acknowledgement was lost converges to the new owner.
- 2026-07-21 — Completion revisions include a persisted random nonce. Replaying the committed marker is
  idempotent, while reopening and completing at the exact same timestamp creates a second review.
- 2026-07-21 — Focused correction coverage passed 528/528 tests. The SDD verification gate passed
  typecheck, PI-001 and full verification; fresh Codex runtime dogfood also passed.
- 2026-07-21 — Publication review hardened the remaining recovery boundaries. Initial creation now
  writes an authenticated intent before profile bytes, and rename writes an authenticated journal
  before source quarantine so an ambiguous authority move is resumed idempotently. Session skill
  copies moved to host storage keyed by stable profile identity; the documented trust boundary treats
  workspace writes as untrusted and the user-selected same-UID runtime as the executor, not an OS-level
  adversary.
- 2026-07-21 — Final independent re-review reported no blockers after fault tests covered initial
  creation before profile publication, rename publication before quarantine, ambiguous authority move,
  retirement during pending rename, and old-name reuse.

### 2026-07-21T23:55:23Z — fail (2/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm run test:invariants` — pass
- `npm run verify:full:quiet` — fail

### 2026-07-21T23:57:57Z — pass (3/3) — source: tasks.md
- `npm run typecheck` — pass
- `npm run test:invariants` — pass
- `npm run verify:full:quiet` — pass
