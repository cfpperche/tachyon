# 495 — runtime-auth-login-recovery — notes

_Created 2026-08-07._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Measurement log

All captures below: host `goat`, 2026-08-07, `t-9b5457` / agent `authflow`. Isolated config homes
under a throwaway directory; **no real credential was created, read, copied or modified**, and every
login flow was killed before completion. The throwaway directory was removed after measurement.

### Binary versions on this host (2026-08-07)

```
claude    2.1.224 (Claude Code)
codex     codex-cli 0.146.1
grok      grok 1.0.0 (3cd0d0cbce) [stable]
opencode  1.18.9
pi        0.80.10
hermes    Hermes Agent v0.18.2 (2026.7.7.2) · upstream 2a25d53e
```

`docs/runtimes/parity.md` documented Grok at 0.2.112 / 0.2.118 and Claude at 2.1.222 before this
spec. The Grok major moved under the docs — see §Grok below for what that cost.

### Claude Code 2.1.224 — auth status

`claude auth status` is a real subcommand (`claude auth --help`: `login`, `logout`, `status`).
`claude auth status --help` documents `--json (default)` and `--text`.

Logged in (real `~/.claude`) — **keys only, values withheld deliberately**:

```
{"loggedIn": true, "authMethod": <str>, "apiProvider": <str>,
 "email": <str>, "orgId": <str>, "orgName": <str>, "subscriptionType": <str>}
exit=0
```

Logged out (`CLAUDE_CONFIG_DIR=<empty dir>`) — verbatim:

```
{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}
exit=1
```

Both the `loggedIn` field and the exit code separate the two states. **Read the field**; the exit
code merely agrees, and a future version could change it without changing the payload.

The logged-in payload carries `email` / `orgId` / `orgName`. That is account-identifying material and
must be dropped at the parse boundary — this is why `plan.md` §L0 has `classify()` return a 3-value
enum rather than a payload.

### Claude Code 2.1.224 — login surface

`claude auth login --help`: `--claudeai` (default), `--console`, `--email <email>`, `--sso`.
Run under tmux in an isolated `CLAUDE_CONFIG_DIR` with `BROWSER=/bin/true DISPLAY=` so no browser
opened; pane captured, then killed:

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…
  &response_type=code&redirect_uri=…&scope=…&code_challenge=…&code_challenge_method=S256&state=…
Paste code here if prompted >
```

**Decisive: it blocks on typed input.** Browser OAuth **plus paste-back**, not a device flow. Any
login surface that cannot accept keystrokes cannot serve Claude.

Also present: `claude setup-token` (long-lived token, requires subscription) — a non-interactive key
path, recorded and deliberately not driven.

### codex-cli 0.146.1 — auth status

`codex login status`:

```
real CODEX_HOME  : "Logged in using ChatGPT"        exit=0
empty CODEX_HOME : "Not logged in"                  exit=1
```

No `--json`. Signal is one line plus the exit code, and here the two agree.

(The empty-home run also emits `WARNING: proceeding, even though we could not create PATH aliases:
Refusing to create helper binaries under temporary dir "/tmp"` — an artifact of probing under `/tmp`,
not of being logged out. A classifier must anchor on the status line, not on "any output".)

### codex-cli 0.146.1 — login surface

`codex login --help`: bare `codex login` (loopback browser), `--device-auth`, `--with-api-key`
(reads stdin), `--with-access-token` (reads stdin).

`codex login --device-auth` under tmux, isolated `CODEX_HOME`, killed before completion:

```
Welcome to Codex [v0.146.1]
OpenAI's command-line coding agent
Follow these steps to sign in with ChatGPT using device code authorization:
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
   F4Y4-TP5IY
Continue only if you started this login in Codex. If a website or another person gave you this code,
cancel.
```

Pure device flow: display-only, the CLI polls, no typed input required. It **does** print on a pipe.

### grok 1.0.0 — auth status, and a regression

`grok models`, same binary, only `GROK_HOME` differs:

```
$ GROK_HOME=<empty> grok models          $ grok models          (real home)
You are not authenticated.               You are logged in with grok.com.

Default model: grok-4.5                  Default model: grok-4.5

Available models:                        Available models:
  * grok-4.5 (default)                     * grok-4.5 (default)
exit=0                                   exit=0
```

Two findings:

1. **The banner line is an authoritative auth signal** — local, pre-launch, sub-second, no network
   needed for the negative case. Same class as `opencode providers list`.
2. **The exit code carries nothing** (0 in both states), and **the catalog block prints while logged
   out**. That second half is a regression against what the code declares:
   `src/runtime/adapters/grokLaunchPreflight.ts:179-188` returns `unverifiable` on an unparseable
   catalog and justifies it with *"A logged-out CLI prints a sign-in notice instead of a listing."*
   On 1.0.0 it prints **both**, so `parseGrokModelCatalog` succeeds and `GrokLaunchPreflight.check`
   returns `supported` for a CLI with no credential at all. Filed as **`t-5dcf47`**.

`grok models --json` → `error: unexpected argument '--json' found`. `grok doctor` reports terminal,
clipboard, colour and voice, and says nothing about authentication — checked so the banner-line
dependency is a measured last resort rather than a first guess.

### grok 1.0.0 — login surface

`grok login --help`: `--oauth` (via `auth.x.ai`), `--device-auth` (alias `--device-code`).

`grok login --device-auth` in an isolated `GROK_HOME`, **piped stdout** → **zero bytes**, twice
(plain pipe, and `script` with the typescript discarded). Same command under tmux:

```
To sign in, open this URL in your browser:
  https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX
Confirm this code in your browser:
  XXXX-XXXX
Only continue with a code you requested. Don't share it with anyone.
Waiting for authorization...
```

(codes redacted here; the live capture was killed before authorization and the code expired unused.)

Device flow, display-only, **PTY-only**. Tachyon cannot capture this into its own UI without
allocating a terminal — which is what settles the login-surface decision alongside Claude's
paste-back.

Grok's own screen says *"Don't share it with anyone."* That is the reason `plan.md` §5 forbids
scraping or logging a login pane: the device code is a bearer secret for the duration of the flow.

### opencode 1.18.9 — re-measurement of the shipped probe

`t-0338fc` measured `opencode providers list` on 1.18.5. Re-run here on **1.18.9**, empty
`XDG_DATA_HOME`:

```
┌  Credentials /…/oc-empty/opencode/auth.json
│
└  0 credentials
exit=0
```

The declared signal still holds two minor versions later. Recorded so the parity row can state a
current date rather than inheriting one.

### Pi / Hermes — not measured

Out of scope by the task's own rule (priority runtimes are Claude, Codex, Grok; others are
*registered*, not solved). Their auth-status probe is unknown; their login actions are the ones
already declared in `src/runtime/authRequired.ts:136,146` and were not re-measured here.

---

## Design decisions

- **The prior scan's seam is corrected rather than reused.** The `t-9b5457` journal (author
  `premissas`, 2026-08-02) named `src/runtime/adapters/*LaunchPreflight.ts` as the right seam for
  authoritative auth detection. Verified at the point of use per the repository's "a written Task is
  not an accepted Task" rule: those adapters are a *model catalog* preflight, and all three priority
  ones return `supported` without probing when the agent pins no model
  (`claudeLaunchPreflight.ts:26`, `codexLaunchPreflight.ts:71`, `grokLaunchPreflight.ts:166`). The
  owner's failing agent pinned no model. The note is not wrong about `OpencodeLaunchPreflight`, which
  really is an auth seam — it is wrong about the other three, and that is the half the design needed.
- **The root cause is a presentation branch, not a detection gap.** Traced end to end at line level
  (`plan.md` §Intent table). This is why the first slice is presentation + action, and why adding a
  probe first would have left the owner's case intact.
- **Requirement "respeitar a política por runtime já medida" is born satisfied and stays untouched.**
  `ensureAuthCopy` vs `ensureAuthSymlink` at `HarnessManager.ts:2352-2360` is already correct and
  already carries the `t-de73e0` incident. The plan reuses it rather than routing around it.

## Tradeoffs

- **A webview showing the device code would be prettier and is impossible.** It works for Codex
  and Grok and cannot work for Claude, which blocks on a typed paste-back. Choosing one surface for
  three runtimes costs the prettier option; not choosing one would mean three login UIs and an
  asymmetry this repository has already paid for more than once.
- **Keying the login session by runtime, not by agent,** gives concurrency control for free (the
  existing same-key refusal in `CommandRunner.run`) at the cost of a slightly odd mental model: the
  pane belongs to `grok`, not to `grok-builder`. That matches reality — the credential is per config
  home — but it means the pane's title must name the runtime, not the agent that triggered it.
- **Not proposing auto-start after a successful login** contradicts what the owner's live case
  actually wanted, and agrees with a decision SDD 477 already shipped. Raised as Q3 rather than
  resolved unilaterally.

## Open questions

The six owner decisions are in `spec.md` §Open questions. Two engineering unknowns that are *not*
owner calls and must be answered before implementing L0:

1. **Does `claude auth status --json` touch the network?** Not measured. If it does, an offline host
   must classify `unreadable`, never `unauthenticated`, or a laptop in flight mode parks every Claude
   agent. Measurable by running it with the network black-holed, the way `t-0338fc` measured
   OpenCode's probe.
2. **Two ACTOR × TRIGGER doors are untraced** (`plan.md` §7): Tachyon's crash-restart path and Bridge
   `restart_agent`. Both reach `applyHarness` and therefore the same throw, but neither presentation
   was read. This repository has paid for exactly this gap before (`0.56.159`: green tests on one
   coalesced entry point, five call sites bypassing it), so they are listed as uncovered rather than
   assumed.
