# 495 — runtime-auth-login-recovery — tasks

_Generated from `plan.md` on 2026-08-07. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

**Nothing here is started.** `t-9b5457` is investigate-and-propose only; `src/` and `test/` are
untouched by this spec's delivery. The list below is the implementation shape, sized, so the owner can
approve or cut a slice rather than a paragraph.

**Blocked on the owner:** the six questions in `spec.md` §Open questions. Q1 (slice size) and Q2
(login surface) gate Slice 1. The rest gate later slices only.

---

## Slice 1 — "Log in from the failure" (the first slice)

_The smallest change that makes the owner's live case stop happening. Everything else is after it._

- [ ] Trace the two uncovered doors from `plan.md` §7 — Tachyon crash-restart and Bridge
      `restart_agent` — and record what each does with a credential refusal today. **Do this first:**
      the slice claims to cover every door and two of them are unread.
- [ ] Add `authRequiredFromHarness()` to `src/runtime/authRequired.ts`, beside the existing
      `authRequiredFromPreflight()` (`:223`) — same construction, same `MAX_EVIDENCE_CHARS` bound,
      same "no declared profile → `undefined`" refusal.
- [ ] Give `HarnessUnavailableError` (`src/harness/HarnessManager.ts:1344`) an optional typed
      `authRequired?: AuthRequiredEvidence`, and populate it at the four credential throw sites:
      `:1433` (grok unreadable), `:2300` (opencode), `:2356` (claude/codex/grok generic),
      `:3300` (grok bridge-mcp). No wording changes — the sentences are already right.
- [ ] Carry the typed reason through the engine result so `src/extension.ts:386` stops flattening it
      into a bare `Error`.
- [ ] At `src/extension.ts:3263`, branch on `authRequired`: call `showNotificationActions`
      (`src/workspace/NotificationService.ts:88`) with `describeAuthRequired(agent, evidence)` and the
      actions `Log in` / `Open` / `Dismiss`. **This is the line that fixes the incident** — a
      non-empty `actions` array selects the persistent QuickPick branch (`src/workspace/notify.ts:33-39`)
      instead of the 8-second status bar (`:41`).
- [ ] Put the verb in the action label and the command in the `detail`, not in the tail of the title.
      The title is still width-bounded; the button is not.
- [ ] Declare `loginCommand` + `loginSurface` per runtime in `src/runtime/authRequired.ts` for
      claude / codex / grok, with `verifiedAt` and the measured binary version
      (`notes.md` §Measurement log is the source).
- [ ] Add `src/commands/LoginRunner.ts`: one governed tmux session per **runtime**
      (`tachyon-login-<wsHash>-<runtime>`), `remain-on-exit`, own namespace, refusing a second live
      session for the same runtime. Runs against the **real** config home. Writes no input to the pane.
- [ ] Add a `login:` arm to `sessionIcon` (`src/presentation/Terminals.ts:24-27`) and open the pane
      via `Terminals.open`.
- [ ] Make the autostart aggregate at `src/workspace/Workspace.ts:6968` stop swallowing the recovery
      instruction — today an autostart credential failure reports only a count and a name, which is
      **worse** than the path the owner hit.
- [ ] Fail-before proof for the presentation fix: assert that a credential refusal does **not** take
      the `setStatusBarMessage` branch. Watch it fail against today's code before trusting it green.

## Slice 2 — authoritative pre-launch detection (L0)

- [ ] Measure whether `claude auth status --json` requires the network (`notes.md` §Open questions).
      Blocks the whole slice: if it does, offline must classify `unreadable`.
- [ ] Declare `RUNTIME_AUTH_STATUS` in `src/runtime/authRequired.ts` with a **per-runtime**
      `classify(stdout, exitCode)`. Grok exits 0 in both states — no shared exit-code rule.
- [ ] Bound the probe with `PREFLIGHT_TIMEOUT_MS` and the detached-spawn/SIGKILL-the-group shape
      already proven in `probeGrokCatalog` (`src/runtime/adapters/grokLaunchPreflight.ts:101-152`).
- [ ] Probe the **real** config home, never the private one.
- [ ] `unreadable` falls through to today's behavior — it never refuses and never blesses.
- [ ] Time the added launch latency and record it. Do not enable on the hot path unmeasured.

## Slice 3 — `waiting for login` as a state

- [ ] Add the state to the agent model so the sidebar shows `waiting for login` rather than "failed
      to start", reusing the `authRequired` badge plumbing (`src/sidebar/agentModel.ts:247`).
- [ ] Hold assigned work and suppress automatic restart while the state holds — the gates SDD 477
      already installed (`src/workspace/Workspace.ts:1489`).
- [ ] Cancel and Retry, both human-explicit. **No automatic restart anywhere** unless the owner
      answers Q3 the other way.
- [ ] On login-pane exit: re-run the L0 probe (not the exit code), then call the existing
      per-runtime reconcile (`reconcileWorkspaceClaudeAuth` / `reconcileGrokAuthFromWorkspace`) so
      every private home converges — do **not** write a new projection path.
- [ ] Agents 2..N on the same runtime join the one live login session and clear together.
- [ ] Partial failure reports per home: the runtime is authenticated, *that* agent is not projected.

## Slice 4 — durability against runtime churn

- [ ] Add `node scripts/dogfood/run.mjs runtime-auth-probe` on the existing dogfood harness (no one-off package
      script): run each declared probe against a throwaway empty config home and the real one, assert
      the classifier separates them, print the binary version measured.
- [ ] Re-measure the Grok rows in `docs/runtimes/parity.md` against 1.0.0 — several still state
      0.2.112 / 0.2.118.

## Out of this spec

- [ ] `t-5dcf47` — grok 1.0.0 logged-out catalog parses as `supported`. Separate fix; do not fold in.
- [ ] `t-d29398` (`wtstuck`) — worktree recovery after a failed start. Not this spec's problem.

---

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] A credential-refused launch is readable ten seconds later and names runtime + agent + action.
- [ ] The offered action starts that runtime's own login in a Tachyon pane, with no external terminal.
- [ ] The launch refusal produces `AuthRequiredEvidence` and reads in `describeAuthRequired`'s words.
- [ ] No notification, Activity entry, Bridge result, task journal or log emitted by this flow
      contains token material or the account identity fields from `claude auth status --json`.
- [ ] Two agents on one runtime produce one login session.
- [ ] A runtime with no declared probe is never claimed authenticated or unauthenticated.

**Headless check:** `npm run verify:full:quiet`
<!-- Documentation-only in this delivery. Once Slice 1 lands, the focused suites are
     test/unit/authRequired.test.ts and the harness/notification units. -->

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** this delivery is an architecture proposal — `docs/specs/495-*` plus the
`docs/runtimes/parity.md` auth rows. It changes no product behavior, so there is nothing end-to-end
to exercise. The dogfood that *would* prove the proposal is Slice 4's
`node scripts/dogfood/run.mjs runtime-auth-probe`, declared above and deliberately not built here (the task is
investigate-and-propose only). The measurements this spec rests on were taken by driving the real
CLIs and are recorded verbatim in `notes.md` §Measurement log.

**Human dogfood:** the owner reads `spec.md` §Open questions and answers Q1–Q6. Q1 (is the first
slice the right size?) and Q2 (login surface) are the two that unblock implementation.

## Visual QA

**Visual QA Opt-Out:** this delivery renders no surface — it is four Markdown files under
`docs/specs/495-runtime-auth-login-recovery/` and two rows plus a section in
`docs/runtimes/parity.md`. The *proposal* does describe a visual change, and its anchor is written in
advance in `plan.md` §Visual impact, to be measured at 880 and 360 when Slice 1 is built. Writing
screenshots now would only prove that Markdown renders as Markdown.

## Cookbook

**Cookbook-Opt-Out:** no operator surface ships here. If Slice 1 lands a login action, the how-to
belongs with that ship, not with this proposal.
