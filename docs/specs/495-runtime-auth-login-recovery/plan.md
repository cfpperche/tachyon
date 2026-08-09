# 495 — runtime-auth-login-recovery — plan

_Drafted from `spec.md` on 2026-08-07. The approach, not the steps (those go in `tasks.md`)._

Everything below labelled **measured** was run on this host on **2026-08-07** against the binaries
named. Raw captures are in `notes.md` §Measurement log. Everything labelled **declared** is read from
source with a line citation and was not re-executed.

---

## 1. What already exists (so the plan does not rebuild it)

| Capability | Where | State |
|---|---|---|
| Per-runtime **measured** auth-required matchers (turn-attached) | `src/runtime/authRequired.ts:76-158` | ships — claude, codex, grok, pi, hermes |
| Pre-launch credential-store probe declaration | `src/runtime/authRequired.ts:188-202` (`RUNTIME_AUTH_PREFLIGHT`) | ships — **opencode only** |
| `authRequired` attention latch + badge + restart suppression + parent poke | `src/attention/AttentionMonitor.ts:71,294-305`; `src/workspace/Workspace.ts:1489,1538-1542`; `src/sidebar/agentModel.ts:247` | ships (SDD 477 / `t-5bfb72`) |
| Per-runtime credential **projection policy** (copy vs symlink) | `src/harness/HarnessManager.ts:2352-2360` | ships and is correct — `t-de73e0` |
| Cross-home credential **reconciliation** (harvest → promote → converge) | `HarnessManager.reconcileGrokAuthFromWorkspace`, `reconcileWorkspaceClaudeAuth` (`:3251`), `maybeReconcileClaudeAuthFromWorkspace` (`:3290`) | ships — `t-6c8437`, `t-9598cc` |
| Actioned notification primitive | `src/workspace/NotificationService.ts:88` `showNotificationActions` | ships, unused by the launch path |
| Governed one-shot pane with exit-code detection | `src/commands/CommandRunner.ts:49-124`; `src/presentation/Terminals.ts:100` | ships |
| Orphan credential retirement | Bridge `reconcile_runtime_credentials`, `src/bridge/tools/runtime-security.ts:8` | ships (`t-14cf7c`) — retirement, **not** login |

**Correction to the prior scan.** The `premissas` journal note on `t-9b5457` (2026-08-02) names
`src/runtime/adapters/*LaunchPreflight.ts` as "the right seam for authoritative detection, and it
already covers the three priority runtimes." Re-measured at the point of use, that is only half true
and the half that is false matters: those adapters are a **model-catalog** preflight, and every one
of them returns early before probing anything when the agent pins no model —
`claudeLaunchPreflight.ts:26`, `codexLaunchPreflight.ts:71`, `grokLaunchPreflight.ts:166`, all
`if (!command.model) return { state: "supported", … }`. The owner's `grok-builder` had no model pin,
so no probe ran and no auth signal was available from that seam at all. `OpencodeLaunchPreflight` is
the exception — it consults `RUNTIME_AUTH_PREFLIGHT` (`opencodeLaunchPreflight.ts:3`) and is a real
auth seam. The correct seam for the other three is a **new declaration next to
`RUNTIME_AUTH_PREFLIGHT`**, not the catalog adapters.

---

## 2. The measured per-runtime truth

### 2.1 Authoritative auth-status probe

All three priority runtimes now expose a **local, non-interactive, network-free-enough, sub-second**
way to ask "is this config home authenticated?". None of these are declared anywhere in Tachyon
today; `RUNTIME_AUTH_PREFLIGHT` knows only OpenCode.

| Runtime (version) | Probe | Authenticated | Unauthenticated | Exit codes | Machine-readable |
|---|---|---|---|---|---|
| **Claude Code 2.1.224** | `claude auth status --json` | `{"loggedIn":true,…}` | `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}` | `0` / `1` | **✓ JSON** |
| **codex-cli 0.146.1** | `codex login status` | `Logged in using ChatGPT` | `Not logged in` | `0` / `1` | ✗ one line |
| **grok 1.0.0** | `grok models` (banner line) | `You are logged in with grok.com.` | `You are not authenticated.` | **`0` / `0`** | ✗ banner line |
| OpenCode 1.18.9 | `opencode providers list` | lists providers + counts | `0 credentials` | `0` / `0` | ✗ box-drawing text |

Three asymmetries fall straight out and none of them may be smoothed over:

- **Grok's exit code carries no information.** `grok models` exits 0 signed out. A design that reads
  exit codes uniformly would report Grok as authenticated forever. Grok's signal is a **line**.
- **Claude's probe is the only structured one — and the only one that leaks account identity.**
  The logged-in payload carries `email`, `orgId`, `orgName`, `subscriptionType`. Tachyon must read
  `loggedIn` and drop the rest at the parse boundary, never at the presentation boundary.
- **Claude and Codex agree on exit code; Grok does not.** So the declaration must carry a per-runtime
  `classify(stdout, exitCode)`, not a shared rule. This is the same shape `RUNTIME_AUTH_PROFILES`
  already uses for its per-runtime regexes, and for the same reason.

**Measured regression, Grok 1.0.0 — this one is a live defect, not a design note.**
`src/runtime/adapters/grokLaunchPreflight.ts:179-188` states, in a comment that is load-bearing for
its `unverifiable` return: *"A logged-out CLI prints a sign-in notice instead of a listing."* That was
true on 0.2.112. On **1.0.0 it is false**: a logged-out `grok models` prints the full
`Available models:` block, so `parseGrokModelCatalog` succeeds and the preflight returns `supported`
for a signed-out CLI. Only the banner line changed (`You are logged in with grok.com.` →
`You are not authenticated.`). Filed as `t-5dcf47`.

This is exactly the owner's standing point — *"os runtimes mudam constantemente, precisamos
acompanhar sem isso o produto é inútil"* — arriving as a concrete cost: `docs/runtimes/parity.md`
still documents Grok at 0.2.112/0.2.118, the host runs 1.0.0, and a behavior the code declares in
prose stopped holding somewhere in between. **The architecture must therefore make the probe
declaration re-measurable, not merely correct today** (§6).

### 2.2 What the native login actually requires

Measured by running each login in an isolated config home under a Tachyon-style tmux pane, capturing
the pane, and killing it before completion. No real credential was created or touched.

| Runtime | Command | Surface | Blocks on typed input? | Works on a piped stdout? |
|---|---|---|---|---|
| **Claude 2.1.224** | `claude auth login` (`--claudeai` default, `--console`, `--sso`, `--email`) | browser OAuth **+ paste-back** | **YES** — ends at `Paste code here if prompted >` | needs a PTY |
| **Codex 0.146.1** | `codex login` (loopback browser) / `codex login --device-auth` | device code, display-only | no — CLI polls | ✓ prints to a pipe |
| **Grok 1.0.0** | `grok login` (`--oauth`) / `grok login --device-auth` (alias `--device-code`) | device code, display-only | no — CLI polls | **NO — silent on a pipe, PTY only** |

The two that matter for the design:

1. **Claude's login is interactive.** It stops and waits for the human to paste a code back into the
   terminal. A "show the device code in a webview" design works for Codex and Grok and *cannot work
   for Claude*. Therefore the login surface must be a **real terminal the human can type into**.
   This single measurement decides Q2.
2. **Grok's login renders nothing on a pipe.** Two captures (plain pipe; `script` with the typescript
   discarded) produced zero bytes; the tmux capture produced the URL and code. So Tachyon cannot
   "run the login headlessly and show the code in its own UI" for Grok either. It must allocate a
   PTY — which is what a tmux session is.

Together: **one governed tmux pane, attached as an editor terminal, is the only surface that works
for all three.** That is not a preference; it is what the three CLIs jointly permit.

3. **Every runtime also has a non-interactive key path** — `claude setup-token`,
   `codex login --with-api-key` / `--with-access-token` (both read **stdin**), `XAI_API_KEY` for Grok.
   These are recorded for the operator and are precisely the paths Tachyon must **never** drive: each
   one requires a process to hold raw key bytes, which §5 forbids.

### 2.3 Non-priority runtimes — gaps recorded, not closed

| Runtime | Auth status probe | Native login | Recorded as |
|---|---|---|---|
| OpenCode 1.18.9 | ✓ `opencode providers list` → `0 credentials` (**re-measured 2026-08-07 on 1.18.9**; `t-0338fc` measured 1.18.5 and it still holds) | `opencode auth login` — **unmeasured** here | carry forward; login surface is a gap |
| Pi 0.80.10 | **unmeasured** | `/login` inside Pi (declared, `authRequired.ts:136`) | gap |
| Hermes 0.18.2 | **unmeasured** | `hermes model` / provider key in `~/.hermes/.env` (declared, `authRequired.ts:146`) | gap |

Per the task's scope rule these are **registered, not solved**. They get parity rows marked `?` with
a named reason, never a guess.

---

## 3. Recommended end-to-end flow

Five layers. Each one is a small addition to something that already exists; none is a new subsystem.

```
                       ┌─ L0 PROBE ─────────────────────────────────┐
  start / restart ───► │ RUNTIME_AUTH_STATUS[runtime].classify(...)  │
                       │ run against the REAL home (the auth source) │
                       └────────────┬───────────────────────────────┘
                     authenticated  │  unauthenticated / unreadable
                            │       │
                            ▼       ▼
                  ┌── materialize ──┐   ┌─ L1 REFUSE ──────────────────────────┐
                  │ existing copy/  │   │ HarnessUnavailableError + typed       │
                  │ symlink policy  │   │ AuthRequiredEvidence (runtime,agent,  │
                  └────────┬────────┘   │ humanAction) — before pane/worktree   │
                           ▼            └───────────────┬──────────────────────┘
                        ready                           ▼
                                        ┌─ L3 PRESENT ─────────────────────────┐
                                        │ showNotificationActions(              │
                                        │   describeAuthRequired(...),          │
                                        │   [Log in] [Open] [Dismiss] )         │
                                        │ + agent state: waiting for login      │
                                        └───────────────┬──────────────────────┘
                                                  [Log in]
                                                        ▼
                                        ┌─ L4 LOGIN SESSION ───────────────────┐
                                        │ governed tmux pane, one per RUNTIME   │
                                        │ runs that runtime's own login cmd     │
                                        │ human types / confirms in browser     │
                                        └───────────────┬──────────────────────┘
                                                  pane exits
                                                        ▼
                                        ┌─ L5 CONVERGE ────────────────────────┐
                                        │ re-run L0 → reconcile private homes   │
                                        │ (existing harvest/promote/converge)   │
                                        │ clear latch → offer explicit Retry    │
                                        └──────────────────────────────────────┘
```

### L0 — Probe (the authority)

A new `RUNTIME_AUTH_STATUS` record declared **next to** `RUNTIME_AUTH_PREFLIGHT` in
`src/runtime/authRequired.ts`, so "which runtimes can report auth state, and by what measured signal"
stays one list to read — the reason `t-0338fc` gave for putting the OpenCode preflight there.

```ts
interface RuntimeAuthStatusProfile {
  probe: readonly string[];                  // argv appended to the runtime binary
  classify(stdout: string, exitCode: number | null): "authenticated" | "unauthenticated" | "unreadable";
  loginCommand: readonly string[];           // what the [Log in] action runs
  loginSurface: "interactive-pty" | "device-code-pty";  // measured; decides whether input is expected
  humanAction: string;                       // never contains credential material
  source: "measured"; verified: true; verifiedAt: string; notes: string;
}
```

Rules, each with a reason from a measurement above:

- **Absence is a declaration.** A runtime with no entry is never claimed authenticated *or*
  unauthenticated — the same refusal `classifyAuthRequired` already makes (`authRequired.ts:269-270`).
- **`classify` is per runtime, never shared.** Grok exits 0 in both states (§2.1); a shared exit-code
  rule would report it authenticated forever.
- **Probe the REAL home, not the private one.** The private home is a projection of the authority
  (`HarnessManager.materializeHome`); asking the projection whether the authority is logged in
  inverts the dependency. `defaultRealGrokHome` already refuses a Tachyon-managed path as an auth
  source (`HarnessManager.ts:1418-1422`) for exactly this reason.
- **`unreadable` is its own answer.** A probe that times out, or prints a layout nobody measured, is
  not evidence in either direction. It must not refuse the launch and must not bless it — it falls
  through to today's behavior. This is the `parseGrokModelCatalog` discipline
  (`grokLaunchPreflight.ts:60-80`) applied one level up.
- **Bounded like every other probe.** Reuse `PREFLIGHT_TIMEOUT_MS` and the
  spawn/detached/SIGKILL-the-group shape already proven in `probeGrokCatalog`
  (`grokLaunchPreflight.ts:101-152`) — don't invent a second process-bounding style.

### L1 — Refuse, with a typed reason

`HarnessUnavailableError` (`HarnessManager.ts:1344`) gains an optional
`authRequired?: AuthRequiredEvidence`, populated at the four credential throw sites —
`:1433` (grok unreadable), `:2300` (opencode), `:2356` (claude/codex/grok generic), `:3300` (grok
bridge-mcp) — through a new `authRequiredFromHarness()` sibling of the existing
`authRequiredFromPreflight()` (`authRequired.ts:223`). Same construction, same
`MAX_EVIDENCE_CHARS` bound, same "no profile → undefined" refusal.

The point is that the *launch* refusal becomes the **same value** the mid-run path already produces,
so it can travel the same channel and read in the same words. One condition, one vocabulary.

### L2 — Transport without flattening

`src/extension.ts:386` currently does `throw new Error(result.message)`, discarding everything but a
string. The engine result needs to carry a typed `authRequired` payload so the command handler at
`:3263` can branch on it. This is the hop that turned a rich diagnosis into a status-bar string.

### L3 — Present it where a human can read it

Replace the bare `notify(err.message, "error")` at `extension.ts:3263` with
`showNotificationActions` (`NotificationService.ts:88`) when the error carries `authRequired`:

- **Message:** `describeAuthRequired(agent, evidence)` — already written, already token-free
  (`authRequired.ts:291`).
- **Actions:** `Log in` (L4), `Open` (the pane, matching the mid-run toast at `Workspace.ts:1540`),
  `Dismiss`.
- **Why this fixes it:** with a non-empty `actions` array the provider takes the QuickPick branch
  (`notify.ts:33-39`), which renders `title` + `placeHolder` and **persists until dismissed**.
  The empty-actions branch — `setStatusBarMessage(…, 8_000)` at `notify.ts:41` — is what ate the
  owner's instruction. Adding an action changes the branch. *That is the whole first slice.*
- **The mid-run path already proves this works.** `Workspace.ts:1538-1541` calls
  `this.host.notify(describeAuthRequired(…), "warn", [{label: "Open", …}])`, and `VsCodeHost.notify`
  (`src/workspace/VsCodeHost.ts:23-25`) forwards straight to `showNotificationActions`. Same
  condition, same wording, one non-empty array — and it lands as a persistent QuickPick instead of a
  status-bar flash. The launch path calls the **two-argument** module-level `notify`
  (`src/workspace/notify.ts:52`), which cannot pass actions at all. That is the entire difference
  between the presentation the owner got and the one he needed.

A residue to state rather than hide: the QuickPick's `title` is itself width-bounded. So the
**action label carries the verb** (`Log in`) and the `detail` carries the command, instead of relying
on the human reading to the end of a sentence. A truncated title next to a button labelled `Log in`
still transmits the fix; a truncated sentence with no button does not. That asymmetry is the design.

### L4 — The login session

A governed pane, modelled on `CommandRunner` (`src/commands/CommandRunner.ts:49`) but keyed by
**runtime** rather than by a declared command name:

- session name `tachyon-login-<wsHash>-<runtime>` — its **own namespace**, so it inherits
  `CommandRunner`'s stated properties: invisible to `AgentManager`/`LifecycleMonitor`, no crash toast,
  no restart policy, no `maxAgents` slot (`CommandRunner.ts:5-15`).
- `remain-on-exit`, so the finished pane and its exit code stay inspectable (`CommandRunner.ts:12-14`).
- **one live session per runtime** — `CommandRunner.run` already refuses a second live run of the same
  key (`CommandRunner.ts:83`). Keying on runtime makes that refusal *the concurrency policy of §4*,
  at no cost.
- attached as an editor terminal via `Terminals.open("login:<runtime>", session)`. Add a `login`
  arm to `sessionIcon` (`Terminals.ts:24-27`) — a `key` glyph next to the existing `cmd:`/`rb:` arms.
- runs with `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME` pointing at the **real** home, because
  the login must write the authority that private homes are projected from.

One deliberate difference from `CommandRunner`: it resolves its command from
`tachyon.yml` `commands:` (`CommandRunner.ts:69-80`), and a login command is **not** user-declared —
it comes from `RUNTIME_AUTH_STATUS[runtime].loginCommand`, a measured constant. Either generalize
`CommandRunner` to accept an inline `CommandDef`, or add a sibling `LoginRunner` that shares the tmux
mechanics. Prefer the sibling: the login session has different completion semantics (a probe result,
not an exit code alone) and a different lifetime, and `CommandRunner`'s comment block is a contract
about *declared* commands.

### L5 — Converge, then let the human retry

`CommandRunner.tick()` already detects a dead session and its exit code (`CommandRunner.ts:103-121`);
the login runner does the same, then:

1. **Re-run L0** against the real home. The exit code is not the answer — Codex's `login` can exit
   non-zero on a cancelled flow while a *previous* credential is still valid. The probe is the answer.
2. **Reconcile.** Positive → call the existing per-runtime converge:
   `reconcileWorkspaceClaudeAuth` / `reconcileGrokAuthFromWorkspace`
   (`HarnessManager.ts:3251`, `:3271`). This is the whole of requirement 5 ("project/refresh the
   credential to the agent's private home"): it is **already built and already correct**, including
   the copy-never-symlink rule for runtimes that rewrite what they are handed (`t-de73e0`) and the
   "reach *every* private home, not just this one" rule (`t-9598cc`).
3. **Clear the hold and offer `Retry`.** Do not auto-start (see Q3 / §7).

**Requirement 5's "without restarting unnecessarily" is already satisfied for the case it was written
for, and it is worth being precise about which case that is.** A *running* agent whose token refreshes
mid-session needs no restart: `maybeHarvestGrokAuthFromWorkspace` and
`maybeReconcileClaudeAuthFromWorkspace` (`HarnessManager.ts:3290`) already converge private homes on a
throttled tick while the agent runs (`t-6c8437`, `t-9598cc`). An agent that never launched — the
owner's case — has no process to preserve, so "restart" there is just "start", which is already an
explicit human action. The only genuinely open case is an agent that latched `authRequired` *mid-run*,
and SDD 477 already decided it: held until an explicit human restart, latch released by the first
genuine new-turn edge. **This spec should add no automatic restart anywhere.**

---

## 4. Concurrency, revocation, account switch, partial failure

| Situation | Rule | Why / mechanism |
|---|---|---|
| **N agents, same runtime, all unauthenticated** | One login session per runtime. Agents 2..N join the same wait; all clear together on convergence. | `CommandRunner.run` already refuses a concurrent live run of the same key (`CommandRunner.ts:83`); keying by runtime makes that the policy. One provider login serves every agent — the credential is per *home*, not per agent. |
| **N agents, same runtime, one refreshes mid-run** | No login. Existing throttled reconcile converges the siblings. | `t-6c8437` / `t-9598cc`, `HarnessManager.ts:3283-3296`. Already shipped; do not duplicate. |
| **Login succeeds while another agent is mid-turn** | Do nothing to the running agent. | Its process already holds a working credential; touching its home mid-turn is the `t-de73e0` class of harm. |
| **Logout / account switch** | **Never Tachyon-initiated.** Surface it as a human action with an explicit blast-radius statement ("this signs out every `<runtime>` agent in this workspace"). Offer no button. | Logout invalidates the authority every private home was projected from. `reconcileWorkspaceClaudeAuth` already refuses to harvest across a different `oauthAccount` (parity.md §Claude auth, `t-9598cc`), so an account switch is not merely a re-login — it changes which credentials are eligible. Owner decision Q6. |
| **Partial failure — login succeeds, reconcile fails for one home** | Report per-home. The runtime is authenticated; *that agent* is not projected. Keep its hold, clear the others'. | Reporting one aggregate would either falsely bless the broken home or falsely hold the healthy ones. |
| **Login cancelled / times out** | Pane stays (remain-on-exit), agent stays `waiting for login`, `Retry` and `Cancel` both offered. State is never silently abandoned. | `CommandRunner`'s remain-on-exit is what makes a cancelled flow inspectable. |
| **Probe says authenticated, launch still fails** | Not an auth condition. Fall through to today's error. | The probe proves *readable*, not *valid* — the bound `t-0338fc` already states for OpenCode, generalized. Never let a stale positive suppress a real failure. |

---

## 5. Threat model (enxuto)

**Asset:** the human's provider credential in `~/.claude/.credentials.json`, `~/.codex/auth.json`,
`~/.grok/auth.json`, `~/.local/share/opencode/auth.json`.

**Adversaries, in order of how likely they are here:** (a) an agent Tachyon itself spawned, running
with tool access in the same user account; (b) anything that reads Tachyon's own outputs — logs,
Activity, Bridge payloads, notifications, task journals, screenshots in a bug report; (c) a
same-user process reading files by path.

| Rule | Enforced by | Note |
|---|---|---|
| **No credential bytes ever enter a Tachyon data structure.** Probes return a *classification*, never their raw stdout past the parse boundary. | L0 `classify` returns a 3-value enum, not a payload. | Claude's probe emits `email`/`orgId`/`orgName` — dropped at parse, not at render. Account identity is credential-adjacent and does not travel. |
| **No credential bytes in a notification, Activity entry, Bridge tool result, task journal or profile.** | `describeAuthRequired` (`authRequired.ts:291`) names runtime + agent + action only; `MAX_EVIDENCE_CHARS` bounds any echoed line (`:213`). | Already the SDD 477 contract; this spec inherits it unchanged. |
| **Tachyon never handles a raw key.** The stdin key paths (`codex login --with-api-key`, `--with-access-token`, `claude setup-token`, `XAI_API_KEY`) are **documented for the operator and never driven.** | No code path writes to a login session's stdin. | Driving them would make Tachyon a credential-handling process, which is the whole thing this design avoids. |
| **Tachyon never types into a login pane.** The human types; Tachyon allocates the PTY. | The login runner writes no input. Reinforces the repo rule *"never send a bare Enter to a runtime CLI"* — a login pane is the worst possible place for a blind keystroke. | Claude's paste-back prompt is exactly where a stray Enter would land. |
| **A login pane is not scraped.** Its content is shown to the human at the terminal and read by nothing else. | No pane-capture consumer for `tachyon-login-*`. | The device code **is** a bearer secret for the duration of the flow — Grok's own screen says *"Don't share it with anyone."* Capturing it into a log or an attention record would publish it. |
| **The private home never becomes an auth source.** | `isTachyonManagedGrokHome` / `defaultRealGrokHome` already refuse it (`HarnessManager.ts:1400-1422`). | L0 probes the real home for the same reason. |
| **No symlink to the human's credential for a runtime that writes what it is handed.** | `ensureAuthCopy` for grok/hermes/opencode/pi (`HarnessManager.ts:2352-2360`). | `t-de73e0`: a redirected re-auth through a symlink **deleted the human's `~/.grok/auth.json`** and took out every Grok agent. This requirement is born satisfied; the plan must not regress it. |
| **A login session is Interface-initiated only** (recommended, Q5). | No Bridge tool creates one. | An agent-started login opens a pane nobody is sitting at, and a device code with nobody to confirm it is a code sitting on screen until it expires. |

**Accepted residues, stated rather than hidden:**

- The login pane runs as the same OS user and writes the real credential home. Anything that can
  already read `~/.grok/auth.json` is unaffected by this design in either direction.
- A device code is visible in a pane that the human may screen-share. That is inherent to every
  device flow and is why the CLIs print their own warnings; Tachyon adds no exposure.
- `~/.ssh` remains deliberately out of reach of canonical private homes (parity.md §Grok isolation);
  nothing here changes that.

---

## 6. Keeping this from expiring — the owner's standing requirement

> *"os runtimes mudam constantemente, precisamos acompanhar sem isso o produto é inútil."*

The Grok 1.0.0 finding (§2.1) is what that costs when the answer is only a comment. Three cheap
properties, all of which this repository already uses somewhere:

1. **Every entry states its measured version and date** (`verifiedAt`, `notes`) — the shape
   `RUNTIME_AUTH_PROFILES` already uses (`authRequired.ts:47-50`). A stale entry is then *readable*
   as stale.
2. **A dogfood scenario re-measures the probes**, rather than a unit test asserting a fixture. Run
   each declared probe against a temporary empty config home and against the real one, and assert the
   classifier separates them. This is what would have caught the Grok change on the day it landed;
   nothing in a fixture-based test can. It costs three subprocess spawns and no network. Add as
   `node scripts/dogfood/run.mjs runtime-auth-probe` using the existing harness (per repo rule: dogfood uses
   existing harnesses, never one-off package scripts).
3. **`unreadable` is a first-class outcome.** When a runtime's output shape changes, the honest
   result is "I no longer recognize this", which degrades to today's behavior — not a confident wrong
   answer in either direction. The Grok regression is the counter-example: the parser still *matched*,
   so it produced a confident wrong answer.

---

## 7. Who else can reach this?

Per the repository's ACTOR × TRIGGER rule, the list below is also the test-case list. Marked exactly
as measured, because two of these rows I traced and two I did not.

| Actor | Trigger | Reaches the credential refusal? | Today's presentation | Traced |
|---|---|---|---|---|
| Interface (human) | sidebar ▶ | yes | `extension.ts:3263` → **status bar, 8 s** | ✓ measured at line |
| Interface (human) | restart / resume | yes (same `applyHarness` path, `AgentManager.ts:4477`, `:4887`) | same handler family | ✓ line-cited, not exercised |
| Tachyon | autostart on activation | yes | folded into an aggregate count — `"{0} failed to start ({1})"`, `Workspace.ts:6968` — so the *instruction is not even present* | ✓ line-cited |
| Tachyon | crash restart / pipeline node | yes (`applyHarness` again) | **not traced** | ✗ |
| Agent (Bridge) | `spawn_agent` | yes | `fail(error)` → tool result text, `src/bridge/tools/fleet.ts` | ✓ shape only |
| Agent (Bridge) | `restart_agent` | yes | **not traced** | ✗ |

Two things this table says that "who is this for?" would have missed: the **autostart** path is
*worse* than the one the owner hit — the recovery instruction is dropped entirely, not merely
truncated — and the **Bridge** path already delivers the full sentence to an agent, which is why
`claude` (the spawning agent) could diagnose it and the human could not. The fix belongs at L2/L3,
where every one of these doors converges, and the two untraced rows must be traced before the slice
is called done rather than assumed to be covered.

---

## 8. First slice — **"Log in from the failure"**

> **The launch-boundary credential refusal stops going to the status bar. It becomes a persistent
> notification carrying the whole sentence and a `Log in` button that runs that runtime's own login
> in a governed Tachyon pane.**

That is L1 + L2 + L3 + a minimal L4. It does **not** include: the L0 pre-launch probe, the
`waiting for login → authenticated → ready` state machine, the sidebar state, cross-agent join,
convergence automation, or any parity work beyond documenting it.

**Why this is the right size — the defence the task asked for.**

The owner's brief anticipates the answer *"a mensagem de falha vira um botão que roda o login do
runtime"* and asks it to be defended rather than assumed. It is defensible on four measured grounds:

1. **It is the actual root cause, not a proxy for it.** The diagnosis was already correct at
   `HarnessManager.ts:3300`. Nothing upstream needed fixing for the owner to know what to do — the
   sentence existed and was thrown away by one branch at `notify.ts:41`. Adding a probe, a state
   machine and a lifecycle first would fix things that were not broken while leaving that branch
   intact, and the owner's case would happen again.
2. **It is one branch, not a feature.** `showNotificationActions` exists (`NotificationService.ts:88`).
   A non-empty `actions` array is what selects the persistent QuickPick over the status bar
   (`notify.ts:33-41`). The governed pane exists (`CommandRunner` + `Terminals.open`). The login
   commands are measured constants. Nothing here is invented.
3. **It closes the loop the owner had to close by hand.** He needed a second terminal. After this
   slice he needs a button. That is the entire distance between "the product told me it is broken"
   and "the product fixed it with me".
4. **It is honest about the rest.** The `waiting for login` state, cross-agent convergence and the
   pre-launch probe are all real requirements from `t-9b5457`, and they are all *better* once a login
   action exists to hang them on. Shipping them first would be building the state machine for a
   transition no human can trigger.

**What it deliberately leaves broken, so nobody mistakes it for the whole thing:** an agent refused
this way is still just "failed to start" in the sidebar rather than `waiting for login`; a coordinator
can still retry it; an autostart failure still folds into an aggregate count; and detection still only
happens at the moment of failure, never before it.

**Smallest honest version, if even this is too large:** stop the credential refusal from taking the
status-bar branch — pass a single `Open`/`Dismiss` action so the sentence becomes readable. One
argument. It fixes the *information* loss without adding the login action, and the owner would still
have needed his second terminal. Recommended only if Q2 stalls.

---

## Key decisions

- **Probe the runtime's own auth-status command, not a credential file** — chosen because all three
  priority runtimes now ship one (§2.1) and a file check proves only that bytes exist; rejected
  "stat the credential file" because `assertReadableGrokAuth` already does that
  (`HarnessManager.ts:1425-1437`) and it is exactly the check that cannot tell *expired* from *valid*.
- **Declare the probe next to `RUNTIME_AUTH_PREFLIGHT`, with a per-runtime `classify`** — chosen
  because Grok exits 0 in both states while Claude and Codex do not (§2.1), so a shared rule is
  provably wrong; rejected a shared exit-code/regex helper for that reason and for the reason
  `authRequired.ts:7-12` already gives about shared fallbacks.
- **One governed tmux pane as the login surface** — chosen because Claude's login **blocks on typed
  input** and Grok's produces **nothing on a pipe** (§2.2), so no non-terminal surface can serve all
  three; rejected a webview showing the device code (breaks Claude), rejected "tell the human to open
  a terminal" (that is today's behavior and is what failed).
- **Key the login session by runtime, not by agent** — chosen because the credential is per config
  home, and because `CommandRunner.run`'s existing same-key refusal then *is* the concurrency policy
  (§4) with no new locking; rejected per-agent sessions, which would race N device flows for one
  account.
- **No automatic restart, anywhere** — chosen because SDD 477 already decided it for the mid-run case
  and the launch case has no process to preserve (§L5); rejected auto-start-on-login as Q3, flagged
  for the owner because it is what his live case actually wanted and it contradicts a shipped
  decision. Not a call to make silently.
- **Interface-only login initiation** — chosen because a device code with nobody watching expires
  unseen (§5); rejected a Bridge `start_runtime_login` tool. Agents keep the reporting they already
  have.
- **Re-measure by dogfood, not by fixture** — chosen because the Grok 1.0.0 regression (§2.1) would
  have passed every fixture-based test in the repository; rejected adding another unit fixture.
- **Reuse the shipped reconcile machinery for post-login projection** — chosen because it is built,
  measured and carries two incident's worth of hard-won rules (`t-de73e0`, `t-9598cc`); rejected
  writing a new projection path, which would be a third place for the symlink lesson to be forgotten.

## Files touched

_None yet — this is a proposal. This is the projected surface, for sizing only._

| File | Change |
|---|---|
| `src/runtime/authRequired.ts` | add `RUNTIME_AUTH_STATUS` + `authRequiredFromHarness()`; refresh the Claude `humanAction` if Q4 says so |
| `src/harness/HarnessManager.ts` | attach typed `AuthRequiredEvidence` to the four credential throw sites (`:1433`, `:2300`, `:2356`, `:3300`) |
| `src/engine-service/protocol.ts`, `src/extension.ts` | carry the typed reason through the engine result instead of flattening at `:386`; branch at `:3263` |
| `src/commands/LoginRunner.ts` *(new)* | governed per-runtime login session, tmux mechanics shared with `CommandRunner` |
| `src/presentation/Terminals.ts` | a `login:` arm in `sessionIcon` (`:24-27`) |
| `src/workspace/Workspace.ts` | wire the login runner + post-exit reconcile; autostart aggregate at `:6968` must not swallow the instruction |
| `src/runtime/adapters/grokLaunchPreflight.ts` | **separate fix, `t-5dcf47`** — the 1.0.0 logged-out catalog regression; do not fold it into this slice |
| `docs/runtimes/parity.md` | new rows 20/21 + §3.9 (done in this spec's delivery) |

## Risks & unknowns

- **A probe on every launch adds latency.** Bound it with `PREFLIGHT_TIMEOUT_MS` and treat a timeout
  as `unreadable` (fall through), never as a refusal. Measure the real cost before enabling it on the
  hot path — `codex login status` and `claude auth status` were sub-second here but were not timed.
- **`claude auth status --json` may consult the network.** Not measured. If it does, an offline host
  must classify as `unreadable`, not `unauthenticated` — otherwise a flight-mode laptop parks every
  Claude agent. **Verify before shipping L0.**
- **Two ACTOR × TRIGGER rows are untraced** (§7: crash-restart, `restart_agent`). Trace them before
  claiming the slice covers every door — this repository has paid for exactly that gap
  (`0.56.159`, five bypassing call sites with green tests).
- **`grok logout` / `claude auth logout` blast radius is unmeasured.** Do not offer either until it is.
- **The QuickPick title is still width-bounded.** The mitigation (verb in the button, command in the
  detail) is a design choice, not a measurement. Worth one visual check at 880 and 360 per the repo's
  visual rule.

## Visual impact

The first slice changes a human-visible surface: a status-bar flash becomes a persistent QuickPick
with actions, and a new editor terminal tab appears with its own icon. Per the repository's visual
rule the anchor is written **before** building, from the problem statement:

> **Anchor:** a human who pressed ▶ on an unauthenticated agent can read, without hovering, scrolling
> or waiting: which runtime is unauthenticated, which agent it blocked, and what to press next — and
> the thing to press is visible as a control, not as the tail of a sentence.

Measure at 880 and 360 (this repo's pair), because the QuickPick title is exactly the element whose
truncation caused the incident. Neighbour to not regress: the mid-run auth toast
(`Workspace.ts:1538`), which shares the presentation path.

## Sources consulted

- `src/runtime/authRequired.ts` (SDD 477 / `t-0338fc` / `t-5bfb72`) — matchers, preflight, latch contract
- `src/harness/HarnessManager.ts` — credential materialization, projection policy, reconcile, throw sites
- `src/runtime/adapters/{claude,codex,grok,opencode}LaunchPreflight.ts` — the catalog-vs-auth seam
- `src/workspace/{notify.ts,NotificationService.ts}`; `src/extension.ts:368-388,3257-3265` — the presentation hop
- `src/commands/CommandRunner.ts`; `src/presentation/Terminals.ts` — the governed pane primitive
- `src/workspace/Workspace.ts:930-1050,1489-1543,6960-6972` — materialize call site, mid-run toast, autostart aggregate
- `docs/specs/477-multiruntime-auth-required/spec.md`; `docs/runtimes/parity.md` (rows 6/16, §Grok auth, §Claude auth)
- `t-9b5457` journal (`premissas`, 2026-08-02) — corrected in §1
- Live CLI measurement on 2026-08-07: Claude Code 2.1.224, codex-cli 0.146.1, grok 1.0.0,
  opencode 1.18.9 (captures in `notes.md`)
