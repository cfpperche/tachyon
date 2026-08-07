# 495 — runtime-auth-login-recovery

_Created 2026-08-07._

**Status:** draft

<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

This is the **proposal** for `t-9b5457`, which is explicitly an investigate-and-propose task
("SOMENTE investigar e propor uma arquitetura pragmática … antes de implementar"). Nothing under
`src/` or `test/` was changed to write it. Status stays `draft` until the human answers §Open
questions.

## Intent

On 2026-08-07 the owner created a Grok agent, pressed ▶, and got back:

> `isolated harness for 'grok': no credentials at /home/goat/.grok/auth.json`

The rest of that sentence — `— run grok login first (a redirected GROK_HOME starts logged out)` —
never reached him. He read the truncated line as "Grok is not supported yet" and asked when the
product would enable it. **Tachyon had detected the right cause, knew the exact command, and the
human still did not know what to do.**

The diagnosis was never the problem. It is written in full at `src/harness/HarnessManager.ts:3300`.
What destroyed it is presentation, and it is one measured hop:

| # | Where | What happens |
|---|-------|--------------|
| 1 | `src/harness/HarnessManager.ts:3300` | throws `HarnessUnavailableError` with the complete, correct sentence |
| 2 | `src/workspace/Workspace.ts:974` → `src/agents/AgentManager.ts:2243` | nothing catches it — `HarnessUnavailableError` has **zero handlers outside `HarnessManager.ts`** (measured: `grep -rn HarnessUnavailableError src/` returns only its own file) |
| 3 | `src/extension.ts:386` | engine result becomes a bare `new Error(result.message)` — the class, the runtime and the agent name are gone |
| 4 | `src/extension.ts:3263` | `notify(err.message, "error")` — **no actions** |
| 5 | `src/workspace/NotificationService.ts:40` | `show(message, level, [], options)` — actions array is empty |
| 6 | `src/workspace/notify.ts:33-41` | with no actions the provider skips `showErrorMessage` entirely and calls **`vscode.window.setStatusBarMessage(…, 8_000)`** |

So the instruction was not "truncated by the notification width". It was routed to the **status
bar**, which clips to the width of one status-bar cell and then erases itself after eight seconds.
There is no notification, no history, no hover, no button. The most actionable sentence Tachyon
produces all day is the one it prints where sentences cannot be read.

Two structural facts make this worth a spec rather than a patch:

1. **The launch boundary is not covered by SDD 477.** SDD 477 (`src/runtime/authRequired.ts`) built
   a real auth-required lifecycle — measured per-runtime matchers, an `AgentAttention.authRequired`
   latch, a sidebar badge, restart-policy suppression, a parent poke. But it is reached from a
   **turn** or from launch *readiness*, i.e. after a pane exists. The harness credential refusal
   happens *before* any of that, and never becomes `AuthRequiredEvidence` at all. The mid-run path
   already gets an actioned toast (`src/workspace/Workspace.ts:1538-1541`); the launch path gets the
   status bar. Same condition, two presentations, and the human hit the worse one.
2. **There is still no login ACTION anywhere.** Every path ends at "a human must go run this in
   another terminal". The owner had to open a second terminal, and then needed help unwedging the
   worktree the failed start left behind. (That second half is `t-d29398` / `wtstuck` and is
   deliberately out of scope here.)

Since this was written, all three priority runtimes have shipped something Tachyon has not measured:
**an authoritative, local, non-interactive auth-status probe** (§ in `plan.md`). Claude 2.1.224 now
has `claude auth status --json`; Codex 0.146.1 has `codex login status`; Grok 1.0.0 reports its state
in the banner of `grok models`. Detection no longer has to wait for a failure at all.

**Done looks like:** a human who presses ▶ on an unauthenticated agent gets a persistent, readable
statement of *which runtime*, *which agent* and *what to do*, plus a button that runs that runtime's
own login inside Tachyon; the agent sits in an explicit `waiting for login` state that no coordinator
will hand work to; when the login succeeds the credential is projected into the agent's private home
and the agent becomes `ready`; and no token content ever appears in the UI, the Bridge, a log or a
profile.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

### First slice — "the refusal becomes readable and actionable"

- [ ] **Scenario: a launch refused for credentials is never printed to the status bar**
  - **Given** an agent whose runtime home has no usable credential
  - **When** a human starts it from any door (sidebar ▶, command palette, Agent Studio)
  - **Then** the failure is presented through a **persistent, dismissible** surface that shows the
    whole sentence — runtime, agent and the safe action — and is still readable ten seconds later.
- [ ] **Scenario: the refusal carries a login action**
  - **Given** that presentation
  - **When** the human chooses the offered login action
  - **Then** that runtime's own login command runs in a Tachyon-governed pane the human can type
    into, without opening an external terminal.
- [ ] **Scenario: the launch refusal is the same condition as the mid-run one**
  - **Given** a credential-missing launch refusal
  - **When** it is classified
  - **Then** it produces `AuthRequiredEvidence` for that runtime and surfaces with the same wording
    contract as `describeAuthRequired` — no second vocabulary for the same state.

### Full architecture

- [ ] **Scenario: authoritative pre-launch detection, per runtime**
  - **Given** a runtime with a declared auth-status probe
  - **When** an agent is about to launch
  - **Then** Tachyon asks the runtime itself, and a negative answer refuses the launch with a named
    recovery **before** a pane, a worktree or a private home is created.
- [ ] **Scenario: `waiting for login` is a state, not a failure**
  - **Given** an agent refused for authentication
  - **When** the human starts the login action
  - **Then** the agent shows `waiting for login`, is not assigned work, is not auto-restarted, and
    the state is cancellable and retryable by the human.
- [ ] **Scenario: a successful login reaches the private home without a manual step**
  - **Given** a completed login against the real runtime home
  - **When** the agent is started (or retried)
  - **Then** the credential is reconciled into the agent's private home by the existing per-runtime
    policy — private **copy** for Grok/Hermes/OpenCode/Pi, symlink for Claude/Codex — with no symlink
    to the human's credential for a runtime that writes what it is handed (`t-de73e0`).
- [ ] **Scenario: restart, when required, is explicit and lossless**
  - **Given** an agent that must restart to pick up a new credential
  - **When** the restart happens
  - **Then** it is a named, human-visible action, and the agent's task assignment, lineage, worktree
    and surface intent survive it.
- [ ] **Scenario: no credential material ever leaves the runtime's own store**
  - **Given** any notification, attention record, Bridge payload, Activity entry, profile or log
    produced by this flow
  - **When** it is read by a human or an agent
  - **Then** it contains no token, no token fragment, no credential file contents, and no
    account-identifying secret. Provider account labels (e.g. an email shown by `claude auth status`)
    are treated as credential-adjacent and are **not** transported either.
- [ ] **Scenario: concurrent logins for one provider do not race**
  - **Given** two agents on the same runtime both refused for authentication
  - **When** a login is started for one
  - **Then** at most one login session per runtime exists, the second agent joins the same wait
    rather than starting a competing flow, and both converge when it completes.
- [ ] A runtime with no measured auth-status probe never has one guessed for it: the gap is declared
  in `docs/runtimes/parity.md`, the same way `RUNTIME_AUTH_PROFILES` declares an absent matcher.
- [ ] `docs/runtimes/parity.md` carries the per-runtime **auth status probe** and **native login
  surface** rows, each with a stated binary version and a dated measurement.

## Non-goals

- **No generic identity system.** No Tachyon account model, no credential vault, no token broker, no
  provider abstraction layer. Tachyon asks each runtime about itself and runs each runtime's own
  login. It never becomes a party to the credential.
- **No automated login.** Tachyon never types a password, never completes a device flow on the
  human's behalf, and never scrapes a code out of a pane to submit somewhere. It creates the pane and
  gets out of the way.
- **No credential validity oracle.** Tachyon reports what the runtime's probe reports. "Readable" and
  "valid" stay separate axes, exactly as `t-0338fc` already states for OpenCode.
- **No worktree recovery.** The owner's failed start also left a wedged worktree. That is `t-d29398`
  (`wtstuck`) and is deliberately untouched here.
- **Not the non-priority runtimes.** Pi, Hermes and OpenCode get their gaps **recorded**, not closed.
  OpenCode already has a measured probe (`t-0338fc`, re-measured here on 1.18.9) and is carried
  forward as-is.
- **No new UI primitive.** `showNotificationActions` (`src/workspace/NotificationService.ts:88`) and
  the governed one-shot command session (`src/commands/CommandRunner.ts`) already exist. This spec
  wires what is there.

## Open questions

_These are the owner's decisions. Each is answerable in one sentence; none blocks writing the plan._

1. **Q1 — Is the first slice small enough, or too small?** The proposed first slice is *"the launch
   refusal stops going to the status bar, and carries a `Log in` button that runs the runtime's own
   login in a governed pane."* It does not add a lifecycle state, does not add a pre-launch probe,
   and does not touch projection. It makes the owner's exact case stop happening. Defence of the
   size is in `plan.md` §First slice. **Owner: accept / shrink / extend.**
2. **Q2 — Where does the login pane live?** Three candidates, all existing surfaces: an editor-tab
   terminal attached to a governed tmux session (`Terminals.open`, what agents already use); a
   dedicated Agent Studio panel; or the Human Inbox as an attention row that opens the pane. The plan
   recommends the **editor-tab terminal**, because Claude's login *requires typed input* (measured:
   it blocks on `Paste code here if prompted >`) and the other two would have to proxy keystrokes.
   **Owner: confirm the surface.**
3. **Q3 — Does a successful login auto-restart the waiting agent?** Tachyon can (a) leave the agent
   in `waiting for login` with a `Retry` button, or (b) start it automatically once the probe turns
   positive. The plan recommends **(a) explicit**, consistent with SDD 477's "Tachyon will not retry
   or restart it automatically", but (b) is what the owner's live case actually wanted. **Owner:
   explicit retry, or auto-start on first success?**
4. **Q4 — Is `claude auth login` allowed to replace `/login` as the recommended Claude action?** It
   is a real subcommand on 2.1.224 and runs outside the agent TUI, which is what makes a short-lived
   login pane possible. `src/runtime/authRequired.ts:83` currently tells humans to run `/login`
   inside the runtime. **Owner: switch the recommended action, keep both, or leave as-is?**
5. **Q5 — Who may start a login: only the Interface, or also an Agent through the Bridge?** A login
   pane is an interactive human surface; an agent starting one produces a pane nobody is sitting at.
   The plan recommends **Interface-only**, with agents restricted to *reporting* the auth-required
   state they already report. **Owner: confirm, or allow an agent to request one via
   `request_human_attention`?**
6. **Q6 — Does an account switch (logout → login as someone else) need an approval gate?** It
   invalidates every agent on that runtime at once, including running ones. The plan recommends
   treating `logout` / account change as an explicit human action with a named blast-radius warning
   and **no** Tachyon-initiated path at all. **Owner: confirm.**
