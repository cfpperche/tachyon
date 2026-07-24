# Dev Host dogfood lane v1

> **Status:** versioned final lane · **Contract owner:** `t-1d53e8` · **Rename:** `t-2d1810`

This is the single-owner lane for isolated Extension Development Host dogfood — private fixture,
private tmux/cache/state/data, extension bits from a known checkout/worktree, without reloading the monorepo
fleet window.

**Primary CLI:** `npm run dogfood:dev-host`  
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
| Interim | `npm run dogfood:edh` (+ alias `dogfood:edh-palliative`) | Same scripts; shorter entry while still under the palliative path. |
| Current (`t-2d1810`) | **Dev Host** / `npm run dogfood:dev-host` / `scripts/dev-host/` | Semantic product name: isolated Extension Development Host for worktree/fixture dogfood. F5 pointer is first-class (`point` / `point-status` / `point-clear`). |

**F5 launch shape (WSL Remote parent window):** keep the same shape as **Run Tachyon (demo)** /
**Run Tachyon (test fixture)**:

| Do | Do not |
|----|--------|
| Open `${workspaceFolder}/.tachyon/dev-host/workspace` (real dir under the monorepo) | Pass machine-local absolute paths in `launch.json` (forces a fresh WSL re-entry → **Disconnected from WSL** / **Extension 'WSL' is required**) |
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

The installed VSIX accepts `stable` only. Stable packaging runs `npm run build:stable` and refuses unless it is
executed from the clean primary `main` checkout with `HEAD`, local `main`, and cached `origin/main` at the exact
same commit. `npm run package` invokes that gate through `vscode:prepublish`; ordinary users still only install
the VSIX and open a workspace.

## Single-owner lease

All headless and desktop pilots have one named owner. The atomic lane lease refuses a second owner and is not
automatically stolen based on PID or age. A coordinator must investigate and explicitly release an abandoned lease.

```bash
# bounded command: acquires, runs, writes allowlisted latest.json, and releases even on failure
node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood:dev-host -- headless

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

4. **Use a compatible executable.** `npm run dogfood:dev-host -- resolve-code` prefers the current worktree test cache,
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
npm run dogfood:dev-host -- headless
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
npm run dogfood:dev-host -- point --worktree /home/goat/tachyon --fixture <slug> --spec NNN --slug <slug>
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
node scripts/dev-host/headless-session.mjs cmd "Tachyon: Open Control"
node scripts/dev-host/headless-session.mjs eval control "[...document.querySelectorAll('.ck-tabs button')].map(b=>b.textContent.trim())"
node scripts/dev-host/headless-session.mjs click control "Fleet"
node scripts/dev-host/headless-session.mjs dom control "[data-testid='control-fleet'] button"
node scripts/dev-host/headless-session.mjs shot fleet             # → session-out/fleet.png (Read it)
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

---

## Optional: GUI launch

### GUI launch consent (t-fe621b)

`launch` opens a **visible** Extension Development Host on the human `DISPLAY`. Fixture isolation
(`TACHYON_DEV_HOST_ID`, private XDG/tmux/user-data) does **not** prevent focus steal — a second
desktop EDH still interrupts an active session or an F5 dogfood already on screen.

| Mode | Command | When |
|------|---------|------|
| **Automated / agent** | `npm run dogfood:dev-host -- headless` | Default for agents — Xvfb, no desktop focus |
| **Human F5 (preferred GUI)** | `point` … then F5 `Tachyon: Dev Host` | Multi-slot (`slots/<owner>/`); default/active for single human; agents use `--owner` |
| **Secondary desktop GUI** | `launch --gui` or `TACHYON_DEV_HOST_GUI=1 … launch` | Explicit only; prints warnings if F5 is armed or caller is an agent |

Without `--gui` / `TACHYON_DEV_HOST_GUI=1`, `launch` **fails closed** and points at the safe routes above.
A second `launch` on the **same** `TACHYON_DEV_HOST_ID` while the recorded EDH pid is still alive is also refused.

From the repo root (any clean-enough tree; prefer the SHA under test):

```bash
# 1) Seed an isolated fixture (prints paths + the exact launch command)
npm run dogfood:dev-host -- seed

# 2) Launch EDH only with explicit GUI consent (always rebuilds the dev channel before opening)
npm run dogfood:dev-host -- launch --gui
# or: TACHYON_DEV_HOST_GUI=1 npm run dogfood:dev-host -- launch
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
npm run dogfood:dev-host -- clean
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
   (`npm run dogfood:dev-host -- break` uses self-referential `subagents: [pilot]`).
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
npm run dogfood:runtime-launch-preflight
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

## Preferred human path: stable F5 from the monorepo

This is the **default** dogfood path for product UI. CLI `seed` / `launch` remain available as
secondary (scripted / non-F5); headless remains the automated Xvfb path.

When the human stays on the **monorepo window** and the feature under test lives in a
**git worktree**, agents arm a pointer instead of editing one-off `launch.json` paths.

```bash
# Optional: scaffold a fixture (intent focus = stopped OK; metrics = autostart loops)
npm run dogfood:dev-host -- fixture-new --slug my-feature --spec 393 --intent focus \
  --worktree /path/to/worktree
# Force-add .tachyon seeds (gitignored): git add -f test/fixtures/my-feature-dogfood/.tachyon

# From monorepo root *or* a linked feature worktree (short form with --fixture).
# Linked worktrees auto-redirect the pointer to the primary monorepo — F5 always reads
# monorepo/.tachyon/dev-host, never the feature worktree's own pointer dir.
#
# Multi-slot (t-efe06d): each agent arms an isolated slots/<owner>/ — no last-writer-wins clobber.
# Humans may omit --owner (slot "default"). Agents MUST pass --owner "$TACHYON_AGENT_NAME".
npm run dogfood:dev-host -- point \
  --worktree /path/to/worktree \
  --fixture my-feature \
  --spec 393 \
  --slug my-feature \
  --owner "$TACHYON_AGENT_NAME"

npm run dogfood:dev-host -- point-status          # doctor for active (or --owner / --slot)
npm run dogfood:dev-host -- point-status --all    # list every armed slot
npm run dogfood:dev-host -- point-clear --owner "$TACHYON_AGENT_NAME"   # free only your slot
npm run dogfood:dev-host -- point-clear --all     # free the whole environment
```

| Piece | Location |
|-------|----------|
| Stable F5 config | monorepo `.vscode/launch.json` → **Tachyon: Dev Host** (paths via `.tachyon/dev-host/active/…`) |
| Per-agent F5 | **Tachyon: Dev Host · &lt;slot&gt;** → `slots/&lt;slot&gt;/` (also sets `TACHYON_DEV_HOST_SLOT`) |
| Pointer (local) | **monorepo** `.tachyon/dev-host/slots/&lt;id&gt;/` + `active` symlink (legacy flat layout migrates once → `slots/default`) |
| Extension bits | worktree via `--extensionDevelopmentPath=…/extension` |
| Opened folder | per-slot mirror of isolated **fixture** (never monorepo root) |

**Human:** Run and Debug → **Tachyon: Dev Host** → **F5**. Drive only the EDH window.
**Agents:** same, or pick **Tachyon: Dev Host · $owner** so concurrent dogfood does not steal `active`.

### After land (required cleanup)

When the feature is **merged to main** (or dogfood for that change is finished), free the slot
**before** discarding the worktree. Do **not** leave a pointed worktree after land.

| Step | Command / action |
|------|------------------|
| 1 | Close the EDH window for that feature (if open) |
| 2 | `npm run dogfood:dev-host -- point-clear --owner <owner\|slug>` — only **your** slot |
| 3 | `npm run dogfood:dev-host -- point-status --all` — confirm your slot is gone; leave others alone |
| 4 | Remove the feature worktree (registry / `git worktree remove` as your land flow requires) |
| 5 | Prune local branch / registry entry if the project flow says so |

**Order:** prefer **point-clear → then worktree remove**. If the path disappears first, `point-status`
reports **broken** and a persistent engine may still be alive under that slot.

**Do not** use `point-clear --all` as routine post-land — that wipes every agent’s slot on the machine.
Reserve `--all` for intentional full environment reset.

### Fixture intents (do not confuse)

| Intent | Expect | Metrics peek? |
|--------|--------|----------------|
| **focus** | Stopped agents OK; task / brief / goal lines | No (Live 0) — by design |
| **metrics** | Autostart busy loops | Yes after Live > 0 |

### Hard rules

1. `--workspace` / resolved fixture must not be the monorepo root (script refuses).
2. Do not reload / reinstall VSIX in the fleet window for this path.
3. Specs document steps under `**Human dogfood:**` in `tasks.md` (not a free-floating `DOGFOOD.md`).
4. **After land / after dogfood:** `point-clear --owner …` then remove the worktree (see **After land** above). If the worktree is already gone, still run **point-clear** so the slot and engine are not left stale.
5. Lease (`lane.mjs`) is required for **delegated** headless/GUI pilots; plain F5 pointer for a single human/agent does not auto-acquire a lease. Map lease owner → slot id when both apply.
6. F5 host is always the **primary monorepo checkout**. When `point` runs from a linked worktree,
   the CLI redirects the pointer there automatically; a pointer only under the feature worktree's
   `.tachyon/dev-host` is invisible to monorepo F5 (preLaunchTask fails with a guided error).
7. **No flat global pointer** as the multi-agent model (t-efe06d). Flat layout is migrated once to
   `slots/default` and then only `slots/*` is first-class. Agents without `--owner` /
   `$TACHYON_AGENT_NAME` / `$TACHYON_DEV_HOST_SLOT` fail closed when agent-bridge env is present.

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
npm run dogfood:dev-host -- shortlist
# or: npm run dogfood:ui-shortlist
# subset: npm run dogfood:dev-host -- shortlist mermaid grok-activity
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
