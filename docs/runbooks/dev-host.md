# Dev Host dogfood lane v1

> **Status:** versioned final lane · **Contract owner:** `t-1d53e8` · **Rename:** `t-2d1810`

This is the single-owner lane for isolated Extension Development Host dogfood — private fixture,
private tmux/cache/state/data, extension bits from a known checkout/worktree, without reloading the monorepo
fleet window.

**Primary CLI:** `npm run dogfood -- dev-host`
**Canonical F5 config:** `Tachyon: Dev Host` (pointer under `.tachyon/dev-host/`)
**Scripts:** `scripts/dev-host/`

## Maintaining the harness (read this if you dogfood)

**Everything under `scripts/dev-host/` is FIRST-PARTY, living code — ours to keep sharp.** The harness
_orchestrates_ third-party primitives (VS Code / the Extension Development Host, `Xvfb`, `puppeteer-core`,
the Chrome DevTools Protocol) but the scenario runner, the verb dispatch, the frame targeting, the
pointer/fixture lane, and every assertion are ours.

Standing directive (maintainer, 2026-07-22): **if you hit a bug or a rough edge IN THE HARNESS while
dogfooding, fix it — don't work around it silently.** A broken/awkward harness is a product defect on
our own tooling; treat it to the same bar as any other code (branch, test, land, journal). Every real
dogfood session is also a chance to harden the harness: a new reusable verb, better frame targeting, a
new scenario worth keeping — land it back into `scripts/dev-host/` so the next agent starts ahead.

The one line to hold: distinguish **our bugs from their limits.** A defect in what we built → fix it.
A genuine limitation of a third-party primitive (an EDH quirk, an Xvfb/CDP constraint) → work around it
AND document the workaround here (or report upstream) — that is not ours to patch, but the reader after
you must not have to rediscover it. The webview-console caveat below is the model: a real CDP limit,
documented, with the injected-spy workaround captured next to it.

## Evolution (keep this on purpose)

The *mechanism* did not change; the **name and entry surface** did. Agents and humans reading old
pins, journals, or commits should map the old vocabulary here:

| Era | What it was called | Why |
|-----|--------------------|-----|
| Origin | **EDH palliative** / `edh-palliative` | Temporary isolation lane so dogfood would not strangle concurrent Delivery work (368). “Palliative” = workaround name, not a product noun. |
| Interim | `npm run dogfood -- edh` (+ alias `dogfood:edh-palliative`) | Same scripts; shorter entry while still under the palliative path. |
| Current (`t-2d1810`) | **Dev Host** / `npm run dogfood -- dev-host` / `scripts/dev-host/` | Semantic product name: isolated Extension Development Host for worktree/fixture dogfood. F5 pointer is first-class (`point` / `point-status` / `point-clear`). |

**F5 launch shape (WSL Remote parent window):** keep the same shape as **Run Tachyon (demo)** /
**Run Tachyon (test fixture)**:

| Do | Do not |
|----|--------|
| Open `${workspaceFolder}/.tachyon/dev-host/workspace` (real dir under the current checkout) | Pass machine-local absolute paths in `launch.json` (forces a fresh WSL re-entry → **Disconnected from WSL** / **Extension 'WSL' is required**) |
| `--extensionDevelopmentPath=${workspaceFolder}/.tachyon/dev-host/extension` | Open a *symlink* as the EDH folder (empty **NO FOLDER OPENED**) |
| Private `TMUX_TMPDIR` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` / `XDG_DATA_HOME` | Private `--extensions-dir` / `--user-data-dir` (drops `ms-vscode-remote.remote-wsl` on the local side of the EDH window) |

### Mirror layout (symlink vs copy)

`point` materializes `workspace` as a **real directory** under `.tachyon/dev-host/workspace`:

| Entry | How | Why |
|-------|-----|-----|
| `tachyon.yml` | **real copy** | Engine config reads are no-follow and Studio mutations must stay inside disposable dogfood state |
| README, other files | **symlink** into fixture | Live edits in fixture show in EDH Explorer |
| `.tachyon/` (tasks, continuity, sessions, …) | **real copy** (`cpSync`) | Engine Soul launch fails closed if `.tachyon` resolves *outside* the open workspace (`SoulError: … parent escapes workspace`) |
| `.edh-*` CLI dirs | skipped | Not needed for F5 |

If you see **SoulError** on agent start after F5: re-run `point` (rematerializes the copy) and confirm `point-status` says `mirror .tachyon: real directory (ok)`.

CLI `launch` / `headless` may still use private profile dirs under the fixture.

**Deliberately not kept as runtime aliases:** `dogfood:edh` and `dogfood:edh-palliative` were removed
after the rename so there is one canonical command. History lives in this section, the stub
[`edh-palliative-dogfood.md`](./edh-palliative-dogfood.md), git renames under `scripts/dev-host/`,
and task `t-2d1810` — not in permanent dual npm scripts.

Env vars still **accept** the old `TACHYON_EDH_PALLIATIVE_*` / `EDH_PALLIATIVE_*` names as fallbacks
where headless/fixture code already depended on them; prefer `TACHYON_DEV_HOST_*` / `DEV_HOST_*` in
new material.

## Target matrix

| Target | Extension bits | Workspace | Automated? | Use |
|---|---|---|---|---|
| `worktree` | current worktree via `--extensionDevelopmentPath` | seeded fixture | yes, preferred | pre-merge behavior |
| `main` | clean main checkout at a recorded SHA | seeded fixture | yes | post-merge confirmation |
| `vsix` | explicitly installed package | isolated profile only | no | packaging/manifest boundary; coordinator-owned pilot |

Never describe one target as proof of another. Record target, owner, SHA, command exit, and evidence path.

## Stable versus dev engine channel

`npm run build` and `npm run watch` always emit a `dev` engine. The Dev Host writes a closed
`.tachyon-dev-host.json` marker into its fixture and accepts that channel only there; its XDG cache, state and
data roots are fixture-private. A worktree build therefore cannot replace the engine used by the installed
extension.

The installed VSIX accepts `stable` only. `npm run release` (also exposed as the `npm run package` compatibility
alias) runs the complete release operation: `build:stable` → `package:assert` → `vsce package` → `smoke:vsix`.
It aborts on the first failure. The stable build refuses unless it is executed from the clean primary `main`
checkout with `HEAD`, local `main`, and cached `origin/main` at the exact same commit. A direct `vsce package`
still invokes `package:assert` through `vscode:prepublish`, so it cannot package unchecked bytes; ordinary users
only install the VSIX and open a workspace.

## Single-owner lease

All headless and desktop pilots have one named owner. The atomic lane lease refuses a second owner and is not
automatically stolen based on PID or age. A coordinator must investigate and explicitly release an abandoned lease.

```bash
# bounded command: acquires, runs, writes allowlisted latest.json, and releases even on failure
node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood -- dev-host -- headless

# GUI owner holds the lease across the separate desktop step
node scripts/dev-host/lane.mjs acquire --owner coordinator --target worktree
node scripts/dev-host/lane.mjs status
node scripts/dev-host/lane.mjs release --owner coordinator
```

If a hard crash leaves `owner.lease` present but completely empty, inspect it and use
`node scripts/dev-host/lane.mjs recover`. Recovery is intentionally ownerless and narrow: it removes only an
empty, real lease directory. It refuses a valid lease, any other directory contents, and symlinks; it never steals by
PID or age.

Evidence is bounded to owner, target, timestamps, exit code, and signal at
`${TACHYON_EDH_EVIDENCE:-<resolved-lane-base>/evidence}/latest.json`. `TACHYON_EDH_LANE_BASE` remains available for
isolated tests. Otherwise the lane uses a private `XDG_RUNTIME_DIR` when valid, falling back to
`~/.tachyon/runtime/edh-lane-v1`; `status` prints the resolved base.
It never captures stdout, environment, catalogs, credentials, or prompts. Fixture cleanup refuses a still-running
recorded EDH, then stops the exact persistent engine unit derived from the fixture workspace, the matching legacy
persistent Bridge, and the fixture-private tmux server before removing only the printed fixture directory. A proven
stale private tmux socket is removed; suspicious, oversized, or symlinked ownership metadata refuses cleanup. Lease
release only removes the lane's `owner.lease` directory.

## Delegation contract

Copy [the EDH owner template](edh-delegation-template.md) into the delegated task. The delegate owns the entire lane
from acquire through evidence and cleanup. Observers may read artifacts but must not drive the same EDH, send desktop
input, release the lease, or start a parallel target. A GUI/desktop pilot is a separate explicit coordinator step.

---

## What this is for

| Use | Not for |
|-----|---------|
| Pre-merge / post-merge **sidebar / config / doctor** smoke | Proving Delivery leases (368) |
| Dogfood while **another agent owns 368** on main | Public release / VSIX install validation |
| Loading extension from a **known SHA** via `--extensionDevelopmentPath` | Replacing `verify:full` |

Full repository verification (`npm run verify:full:quiet`) remains mandatory for code changes.
EDH palliative is the **visual / product-path** check on top.

---

## Hard isolation rules (do not skip)

These exist so palliative EDH **cannot** strangle Codex/368 or the human’s live fleet.

1. **Never dogfood against the monorepo root as the open workspace.**
   Always open the **seeded fixture** directory (see below). The product under test is the
   *extension build* (`--extensionDevelopmentPath=<repo>`), not the Tachyon fleet `tachyon.yml`.

2. **Never reload / reinstall VSIX in the normal (non-EDH) window** while 368 (or any live fleet) is running.

3. **Private tmux + XDG namespaces** (the seed script sets these for the EDH process only):
   - `TMUX_TMPDIR` → fixture-local (not the default shared socket)
   - `XDG_CACHE_HOME` → fixture-local (worktrees never land in `~/.cache/tachyon/worktrees` used by 368)
   - `XDG_STATE_HOME` and `XDG_DATA_HOME` → fixture-local (the dev engine and Bridge cannot reuse production state)
   - inherited live Tachyon Bridge/agent identity, Codex session identity, `TMUX`, and `TMUX_PANE` are removed from the
     EDH child; both GUI and headless launches use `--use-inmemory-secretstorage`

4. **Use a compatible executable.** `npm run dogfood -- dev-host -- resolve-code` prefers the current worktree test cache,
   then the primary checkout cache derived from Git's common directory. It rejects WSL `remote-cli/code`, which cannot
   honor the isolated Extension Development Host flags. The detached dev engine itself uses a fixture-local link to
   the standalone Node executable; do not point it at the VS Code Electron binary.

5. **One human/agent drives the EDH window under the lane lease.** No second agent sends keys into it.

6. **Forbidden while palliative EDH is up:**
   - editing monorepo `tachyon.yml` “to see what happens”
   - `kill-server` on the default tmux socket
   - pruning/removing worktrees under `~/.cache/tachyon/worktrees/b349073a/*` belonging to 368
   - claiming you “dogfooded” without the fixture path + SHA recorded

7. **When palliative EDH is insufficient** (must still do installed-VSIX or main-window checks later):
   - packaging / activation / `contributes` ship boundary
   - trust/approval modals that only appear on marketplace installs
   - multi-window rebind after real extension-host crash of the *installed* build

---

## Preferred: headless EDH (no GUI, no Codex collision)

Runs a real Extension Development Host under **Xvfb** with an in-host runner
(`scripts/dev-host/headless-runner.js`) — same class of dogfood as
`scripts/screenshots/capture.sh`, without sign-in wizards or desktop focus.

```bash
npm run build
npm run dogfood -- dev-host -- headless
```

What it asserts (S1 / t-8354ae):

- cold start with **invalid** `tachyon.yml` → `configFailure` present
- degraded roster from ledger + LKG (not empty-only)
- LKG-only spawn refused
- `tachyon.doctor` executes
- restore valid YAML → reload succeeds

Report: `$FIXTURE/headless-out/result.json` (+ `host.log` on failure).
PNG evidence: `$FIXTURE/headless-out/shots/fail-visible.png` (copied to `.tachyon/evidence/dev-host/`).

Requirements: `Xvfb`, and a compatible VS Code test/native binary. The resolver also sees the primary checkout's
`.vscode-test` cache when this command runs from an isolated worktree.

---

## Interactive headless (agent-drivable, full webview access)

`scripts/dev-host/headless-runner.js` (above) runs INSIDE the extension host — it has the full
`vscode` API but **cannot see webview DOM/console** (webviews are separate renderer targets). When a
bug lives in a webview — a Control route, a studio form, the sidebar — use the **interactive** harness
instead: it launches the SAME pointed Dev Host on Xvfb with `--remote-debugging-port`, then drives it
over CDP (puppeteer-core, already a dep) with every webview iframe reachable for clicks, DOM reads,
console capture, and screenshots. This is the "agent reproduces a UI bug end-to-end, headless, no
human clicking" primitive.

```bash
# arm the pointer once (any worktree/fixture — primary checkout is fine):
npm run dogfood -- dev-host -- point --worktree /home/goat/tachyon --fixture <slug> --spec NNN --slug <slug>
# build the pointed extension's dev bundle (the harness refuses a missing dist/extension.js):
TACHYON_ENGINE_CHANNEL=dev npm run build

# boot smoke (settle, dump CDP targets + one screenshot, exit):
node scripts/dev-host/headless-interactive.mjs

# run a scenario (reproduce a specific bug, assert, capture evidence):
node scripts/dev-host/headless-interactive.mjs --scenario scripts/dev-host/scenarios/<name>.mjs
```

Output (default `.tachyon/dev-host/interactive-out/`, wiped per run): `console.log` (every target's
console + pageerrors, captured continuously), `driver.log`, `host.log`, `result.json`
(`{ ok, asserts: [{id, ok, detail}] }`), and `<name>.png` screenshots.

**Scenario contract** — an ES module exporting `run(ctx)`; `ctx` gives you:

| `ctx.*` | what |
|---|---|
| `workbench` | puppeteer `Page` for the VS Code workbench renderer |
| `findWebviewFrame(predJs)` | locate a webview iframe by a JS predicate string evaluated inside each candidate frame (e.g. `"!!document.querySelector('.ck-tabs')"` finds Control) |
| `command(id)` | run a VS Code command via the keyboard-driven Command Palette (e.g. `"Tachyon: Open Control"`) |
| `shot(name)` | screenshot the workbench → `<out>/<name>.png` |
| `log(msg)` / `sleep(ms)` | timestamped driver log line / delay |

`scripts/dev-host/scenarios/t-0e8a9a-agent-studio-nav-loop.mjs` is the worked reference: it opens
Control, edits an agent, clicks the breadcrumb back, and asserts the route actually stays put — the
exact repro that caught the studio nav-checkpoint teardown bug (t-0e8a9a). Copy it as a template for
any "click here, then this should happen" webview repro.

**Webview-console caveat:** the parent CDP target does NOT surface a webview iframe's own
`console.log` (separate execution context). When you need client-side visibility, inject a spy INTO
the frame with `frame.evaluate` — e.g. `window.addEventListener('message', …)` recording inbound host
messages into a `window.__x` array, then read it back with another `frame.evaluate`. The reference
scenario does exactly this to prove the checkpoint/ack handshake.

Requirements: `Xvfb`, `puppeteer-core` (dep), a compatible VS Code binary (`resolve-code.mjs` finds
`.vscode-test/…/bin/code` — the sh launcher, NOT the raw ELF, which is the tunnel CLI). The harness
strips `VSCODE_IPC_HOOK_CLI`/`ELECTRON_RUN_AS_NODE` from the child env so it never hijacks the human's
live window. Uses display `:97` (distinct from the S1 lane's `:96`) and its own private profile dirs.

### Exploratory session (drive it live, verb-by-verb)

`headless-interactive.mjs` runs ONE scenario then exits — great for a canned repro. For **exploratory**
dogfood (boot once → look → act → look → decide the next step) use `headless-session.mjs`: `up` launches
the pointed Dev Host once under Xvfb + CDP and leaves it running detached; every later verb makes a
fresh cheap CDP connection, does one thing, prints a JSON line, disconnects. No relaunch between steps.

```bash
node scripts/dev-host/headless-session.mjs up                       # boot once (detached), ~10s
node scripts/dev-host/headless-session.mjs cmd "Tachyon: Open Human Inbox"
node scripts/dev-host/headless-session.mjs eval "!!document.querySelector('.hi-root')" "[...document.querySelectorAll('.ds-page-chrome button')].map(b=>b.title.trim())"
node scripts/dev-host/headless-session.mjs dom "!!document.querySelector('.hi-root')" "[data-testid='inbox-counts']"
node scripts/dev-host/headless-session.mjs shot inbox              # → session-out/inbox.png (Read it)
node scripts/dev-host/headless-session.mjs down                     # kill EDH + Xvfb
```

While that session is live, `point` and `point-clear` refuse to replace its pointer. Every
interactive verb also checks the pointer generation and aborts fail-closed if metadata was changed
outside the CLI. Always finish with `down` before handing the shared pointer to another workflow.

Verbs: `up`/`down`/`status`/`sleep`/`cmd`/`shot`/`frames`/`eval`/`click`/`click-testid`/`dom`/
`spy-console`/`console`/`steps`. `<frame>` is the alias `control` (built-in Control-webview predicate)
or any JS predicate string that returns truthy inside the target frame. `spy-console <frame>` installs
a `console.*`/error mirror in the frame and `console <frame> [n]` reads it back — this is how you get
the **webview's own** console (the parent CDP target can't see it).

Guided/batch mode: `steps <file.json>` runs `[{ "verb": "...", "args": [...] }, ...]` in order (insert
`{ "verb": "sleep", "args": ["2000"] }` between actions to let the UI settle) and prints a result
array; it stops at the first failing step unless that step has `"continueOnError": true`. Session
state lives in `.tachyon/dev-host/session.json`; screenshots/logs in `.tachyon/dev-host/session-out/`.
`up` refuses if a session is already live (`--force` overrides a stale one). **Always `down` when
finished** — a detached EDH left running holds the CDP port and the pointer's engine.

### Crossing `Developer: Reload Window` (restore verification)

Restore is the only family of product behaviour that **requires** a reload to be observed, so the
harness has to survive one. It does, on both doors: VS Code reloads the renderer's webContents in
place, so the same puppeteer `Page` keeps working and **no reconnect is needed** — `evaluate`,
`screenshot` and further palette commands all land on the far side.

```bash
node scripts/dev-host/headless-interactive.mjs \
  --scenario scripts/dev-host/scenarios/t-5fc17d-reload-traversal.mjs
```

Assert the reload **actually happened** rather than that the page still answers: plant a marker on
`window` before, and require it to be gone after. A handle that survived without a reload looks
identical to one that crossed, right up until the restore assertions are meaningless.

Budget for it. Editors and webviews come back lazily, so poll for the window to settle instead of
guessing a single sleep — a loaded window took ~30s in measurement, and `--timeout` covers the whole
run, not the step.

> **`edhPid` is the app, not the launcher** (`t-5fc17d`). `bin/code` is a shell wrapper around
> `cli.js`, which spawns the real Electron *detached* and exits — so the pid the harness spawns is
> gone seconds after a **successful** launch. The harness used to record it, which made `status`
> answer `{"live":false}` about a perfectly healthy window and made `down` inert (teardown only
> worked because killing Xvfb takes the EDH with it). It now resolves the process that owns the CDP
> port; `session.json` carries that as `edhPid` and keeps the wrapper as `launcherPid`. If you are
> judging whether the EDH survived something, trust `status`/`edhPid` — and remember `host.log`
> only ever captures the wrapper's own output, never the detached app's.

---

## Optional: GUI launch

### GUI launch consent (t-fe621b)

`launch` opens a **visible** Extension Development Host on the human `DISPLAY`. Fixture isolation
(`TACHYON_DEV_HOST_ID`, private XDG/tmux/user-data) does **not** prevent focus steal — a second
desktop EDH still interrupts an active session or an F5 dogfood already on screen.

| Mode | Command | When |
|------|---------|------|
| **Automated / agent** | `npm run dogfood -- dev-host -- headless` | Default for agents — Xvfb, no desktop focus |
| **Human F5 (preferred GUI)** | `point` from your checkout, then F5 `Tachyon: Dev Host` | One dev-host per checkout (spec 448); no slots, no owner flag |
| **Secondary desktop GUI** | `launch --gui` or `TACHYON_DEV_HOST_GUI=1 … launch` | Explicit only; prints warnings if F5 is armed or caller is an agent |

Without `--gui` / `TACHYON_DEV_HOST_GUI=1`, `launch` **fails closed** and points at the safe routes above.
A second `launch` on the **same** `TACHYON_DEV_HOST_ID` while the recorded EDH pid is still alive is also refused.

From the repo root (any clean-enough tree; prefer the SHA under test):

```bash
# 1) Seed an isolated fixture (prints paths + the exact launch command)
npm run dogfood -- dev-host -- seed

# 2) Launch EDH only with explicit GUI consent (always rebuilds the dev channel before opening)
npm run dogfood -- dev-host -- launch --gui
# or: TACHYON_DEV_HOST_GUI=1 npm run dogfood -- dev-host -- launch
```


The exact manual equivalent, including its private environment, is printed by `seed`; use that output instead of
a raw `code --extensionDevelopmentPath` command. Agents must not paste that launch line into automation —
use `headless` instead.


Record in the task note / PR:

- git SHA (`git rev-parse --short HEAD`)
- fixture path
- scenario name (below)
- pass / fail + one-line evidence

Cleanup:

```bash
# Close the isolated EDH window first; a live recorded EDH makes cleanup fail closed.
npm run dogfood -- dev-host -- clean
```

Do not substitute a raw `rm -rf`: a closed desktop EDH intentionally leaves its persistent engine and legacy Bridge
alive until the lane cleanup sends exact, fixture-scoped stops, and fixture agents may leave a private tmux server to
terminate.

---

## Scenario pack (start here)

### S1 — Fail-visible config (t-8354ae)

**Setup (seed already creates a valid fleet + fake LKG + ledger rows).**

1. Open EDH on the fixture workspace; wait until the Tachyon sidebar lists agents (e.g. `pilot`, `reviewer`).
2. In the fixture only, break config with a **hard** validation error
   (`npm run dogfood -- dev-host -- break` uses self-referential `subagents: [pilot]`).
   Note: after t-099be8, a *dangling* name is only a warning — it will not arm fail-visible.

3. In the **EDH** window: Command Palette → `Developer: Reload Window` (EDH only).
4. **Expect:**
   - Agents tab shows a persistent **Invalid tachyon.yml** banner (not only a toast)
   - rows still visible (`pilot` and/or ledger/LKG names) with **config invalid** badge
   - empty-only `(no agents)` is **not** the sole UI
5. Command Palette → `Tachyon: Doctor` → Output channel lists config error + LKG/ledger notes.
6. **Spawn** of an LKG-only name must refuse; **Resume** of a ledger-resumable row may still be offered.
7. Fix the YAML, reload EDH → banner gone, normal roster.

### S2 — Smoke only (no config break)

Open EDH, confirm sidebar loads, Bridge line present, `Tachyon: Doctor` runs without error. Enough for “extension boots from this SHA”.

---

## SDD 370 headless pilot

```bash
npm run dogfood -- runtime-launch-preflight
```

This exercises exact-model accept/reject, bounded catalog streaming, malformed/timeout/non-zero/oversized handling,
EDH executable/environment isolation, readiness/bootstrap authorization, lane ownership, and cleanup. It makes no
live model-catalog or inference call. A real delegated launch remains a separate coordinator-owned GUI pilot.

For a clean Codex home, keep the agent provisional while answering only the bootstrap screen actually visible in
`read_output`. Use `write_input(..., answering: true)` for the terminal warning (`y`), update deferral (`2` or `3`),
and directory selector (`1` or `2`). Hook screens are key-driven: the safe no-trust path is
`write_input(..., text: "\\u001b", submit: false, answering: true)`; trusting uses literal `t` with `submit:false` and
must be an explicit source-reviewed choice. Every other pre-ready input, `notify_agent`, and Task assignment remains
refused. Re-read the pane after each answer and assign work only after the normal composer/footer is visible.

---

## Preferred human path: stable F5 from the checkout

This is the **default** dogfood path for product UI. CLI `seed` / `launch` remain available as
secondary (scripted / non-F5); headless remains the automated Xvfb path.

Open VS Code on the **checkout containing the feature under test**. The Dev Host belongs to that
checkout; there is no shared monorepo pointer to select.

Arm the Dev Host from the same checkout where you will press F5. Before launching, verify that
`.tachyon/dev-host/extension` resolves to that checkout (or a path inside it); a pointer resolving
outside the F5 checkout is not correctly armed for that window.

Recorded observation: arming from the primary checkout while targeting a linked worktree produced
an `extension` symlink into `/home/goat/.cache/tachyon/worktrees/...`, and F5 opened a Windows-side
window with an empty sidebar. Re-arming from inside the linked worktree worked. This records the
observed boundary; it does not assert an unmeasured mechanism for the different outcomes.

```bash
# Optional: scaffold a fixture (intent focus = stopped OK; metrics = autostart loops)
npm run dogfood -- dev-host -- fixture-new --slug my-feature --spec 393 --intent focus \
  --worktree /path/to/worktree
# Force-add .tachyon seeds (gitignored): git add -f test/fixtures/my-feature-dogfood/.tachyon

# Run this FROM the checkout you want to dogfood — the dev-host belongs to it (spec 448).
# Every checkout (monorepo or linked worktree) has exactly one dev-host at
# <checkout>/.tachyon/dev-host/. There is no slot to pick and no `active` pointer to set, so two
# agents working in two worktrees cannot collide: isolation is structural, not a naming convention.
cd /path/to/your/worktree
npm run dogfood -- dev-host -- point \
  --fixture my-feature \
  --spec 393 \
  --slug my-feature

npm run dogfood -- dev-host -- point-status          # doctor for this checkout's dev-host
npm run dogfood -- dev-host -- point-clear           # free this checkout's dev-host
```

**Removed by spec 448, no deprecation window** — each fails immediately naming its replacement:
`--owner`, `--slot`, `--activate`, `--no-activate`, `--require-owner`, `--all`. (`lane.mjs --owner`
is unrelated: that is a *lease* owner and still required.)

### Dogfooding a MULTI-ROOT window (t-f0efc5)

Some bugs only exist with two workspace roots open — "resolves the wrong root", anything reading
`workspaceFolders`, and the worktree-reveal path that branches on whether a `.code-workspace` is open
at all. `point` handles this without a new verb: point it at a fixture that **carries its own
`.code-workspace`** and the lane mirrors every declared folder and writes one of its own.

```bash
cd /path/to/your/worktree
npm run dogfood -- dev-host -- point --fixture multiroot     # test/fixtures/multiroot/ → alpha + beta
npm run dogfood -- dev-host -- point-status                  # reports: workspace mode: multi-root
```

Then in Run and Debug pick **Tachyon: Dev Host (multi-root)** instead of *Tachyon: Dev Host*.
`point` and `point-status` both print the mode and name the configuration to use, so you never have to
work it out from the fixture.

Why two configurations rather than one that adapts: VS Code decides folder-versus-workspace by the
**extension** of the path it is given, and `launch.json` is tracked and never rewritten per dogfood
(spec 448). One static argument cannot be both. Keeping the single-root configuration exactly as it
was is also deliberate — the product genuinely behaves differently in a single-*folder* window
(`vscode.workspace.workspaceFile === undefined` disables worktree reveal, with its own notice), so
collapsing both onto a one-folder `.code-workspace` would have made that branch impossible to reach
by clicking.

What the mirror does, per root: the same rules a single-root mirror uses — `tachyon.yml`, `.tachyon/`,
`.codex/`, `.claude/` and `.mcp.json` are **real copies** (the engine opens config no-follow, and your
dogfood mutations must not write back into a tracked fixture); everything else is a symlink so
Explorer still shows the fixture's files. The fixture's own `.code-workspace` is **not** copied — the
lane writes `<checkout>/.tachyon/dev-host/workspace.code-workspace` with the paths rewritten to the
mirrored folders, relative, so F5 stays inside `${workspaceFolder}` (an absolute path re-enters WSL and
disconnects the window).

Headless needs no change at all: `headless-session up` and the interactive runner read the pointer's
recorded `workspaceArg` and open whichever shape is armed.

To build your own multi-root fixture, give it one `.code-workspace` naming relative folder paths:

```json
{ "folders": [{ "path": "alpha" }, { "path": "beta" }] }
```

Each folder wants its own `tachyon.yml` (`point-status` warns about a root without one — that root
would open as an ordinary folder and the scenario would silently test less than it claims). Seeded
`.tachyon/` state per root is gitignored, so force-add it: `git add -f test/fixtures/<name>/<root>/.tachyon`.

| Piece | Location |
|-------|----------|
| F5 config | `.vscode/launch.json` → **Tachyon: Dev Host** (single-root) or **Tachyon: Dev Host (multi-root)** — static, committed, identical in every checkout, written by no script |
| Dev-host | `<checkout>/.tachyon/dev-host/` (gitignored) — one per checkout |
| Extension bits | this checkout via `--extensionDevelopmentPath=…/extension` |
| Opened folder | mirror of the isolated **fixture** (never a repo root); multi-root opens `…/dev-host/workspace.code-workspace` over the same mirror |
| Dependencies | Install with `npm ci` in the checkout when `node_modules` is absent; F5 refuses a missing dependency tree |

**To dogfood:** open VS Code **on that checkout** and press **F5** → **Tachyon: Dev Host**. Drive only
the EDH window. If dependencies are missing, run `npm ci` in that checkout before pressing F5 again.

**Disk:** a worktree now carries its own dev-host (~100s of MB once VS Code writes its data dir).
That is the trade for lifecycle: removing the worktree reclaims it, instead of leaving an orphaned
slot behind in the monorepo as the old layout did.

### After land (required cleanup)

Free the dev-host **before** discarding the worktree. Do **not** leave a pointed worktree after land.

| Step | Command / action |
|------|------------------|
| 1 | Close the EDH window for that feature (if open) |
| 2 | `npm run dogfood -- dev-host -- point-clear` — from that checkout |
| 3 | `npm run dogfood -- dev-host -- point-status` — confirm it is gone |
| 4 | Remove the worktree (registry / `git worktree remove` as your land flow requires) |

**Order:** prefer **point-clear → then worktree remove**. If the path disappears first, `point-status`
reports **broken** and a persistent engine may still be alive under it. Removing the worktree does
reclaim the bytes either way — but the engine still needs stopping.

### Fixture intents (do not confuse)

| Intent | Expect | Metrics peek? |
|--------|--------|----------------|
| **focus** | Stopped agents OK; task / brief / goal lines | No (Live 0) — by design |
| **metrics** | Autostart busy loops | Yes after Live > 0 |

### Hard rules

1. `--workspace` / resolved fixture must not be the monorepo root (script refuses).
2. Do not reload / reinstall VSIX in the fleet window for this path.
3. Specs document steps under `**Human dogfood:**` in `tasks.md` (not a free-floating `DOGFOOD.md`).
4. **After land / after dogfood:** `point-clear` then remove the worktree (see **After land** above). If the worktree is already gone, clear its Dev Host before removing it when possible.
5. Lease (`lane.mjs`) is required for **delegated** headless/GUI pilots; plain F5 pointer for a single human/agent does not auto-acquire a lease. Map lease owner → slot id when both apply.
6. F5 resolves only the current checkout's `.tachyon/dev-host`; opening a different checkout requires
   arming and launching that checkout's Dev Host separately.

Script: `scripts/dev-host/pointer.mjs`.

## Related

- Task: `t-1d53e8` — Establish EDH dogfood lane and pilot it with SDD 370
- Task: `t-8354ae` — Fail-visible config (banner / LKG / Doctor) — first scenario pack target
- Script: `scripts/dev-host/cli.sh`
- Product boundary: `docs/architecture/dogfood-product-boundary.md`

## UI shortlist (headless Chromium / preview harness)

For landed UI surfaces that need a glance without a full EDH window:

```bash
npm run build
npm run dogfood -- dev-host -- shortlist
# or: npm run dogfood -- ui-shortlist
# subset: npm run dogfood -- dev-host -- shortlist mermaid grok-activity
```

| Scene | Task | Harness |
|-------|------|---------|
| `mermaid` | t-3febb9 / 374 | activity + fixture `mermaid-nav` |
| `grok-activity` | t-9874be | activity + fixture `grok-feed` |
| `handoff-distill` | t-4eb7c0 | handoff + fixture `distill-list` |
| `fail-visible` | t-8354ae | Xvfb EDH (optional, slower) |

PNGs land under `.tachyon/evidence/ui-shortlist/<stamp>-<sha>/`.

## Companion Mobile one-QR (trail)

PWA pair without a physical phone — requires a pointer at a build that serves `/companion/app/*`,
`lanAccess: true`, and Tailscale up (`tailscale ip -4`):

```bash
node scripts/dev-host/headless-interactive.mjs --scenario scripts/dev-host/scenarios/companion-one-qr.mjs
```

Scenario: `scripts/dev-host/scenarios/companion-one-qr.mjs` (Control → Show pair code → mobile-viewport openUrl).
