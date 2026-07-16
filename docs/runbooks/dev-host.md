# Dev Host dogfood lane v1

> **Status:** versioned final lane · **Contract owner:** `t-1d53e8` · **Rename:** `t-2d1810`

This is the single-owner lane for isolated Extension Development Host dogfood — private fixture,
private tmux/cache, extension bits from a known checkout/worktree, without reloading the monorepo
fleet window.

**Primary CLI:** `npm run dogfood:dev-host`  
**Stable F5 config:** `Tachyon: Dev Host` (pointer under `.tachyon/dev-host/`)  
**Scripts:** `scripts/dev-host/`

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
| Private `TMUX_TMPDIR` / `XDG_CACHE_HOME` only | Private `--extensions-dir` / `--user-data-dir` (drops `ms-vscode-remote.remote-wsl` on the local side of the EDH window) |

### Mirror layout (symlink vs copy)

`point` materializes `workspace` as a **real directory** under `.tachyon/dev-host/workspace`:

| Entry | How | Why |
|-------|-----|-----|
| `tachyon.yml`, README, other files | **symlink** into fixture | Live edits in fixture show in EDH Explorer |
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
recorded EDH, then stops the matching persistent Bridge and fixture-private tmux server before removing only the printed
fixture directory; suspicious, oversized, or symlinked ownership metadata refuses cleanup. Lease release only removes
the lane's `owner.lease` directory.

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

3. **Private tmux + cache namespaces** (the seed script sets these for the EDH process only):
   - `TMUX_TMPDIR` → fixture-local (not the default shared socket)
   - `XDG_CACHE_HOME` → fixture-local (worktrees never land in `~/.cache/tachyon/worktrees` used by 368)
   - inherited live Tachyon Bridge/agent identity, Codex session identity, `TMUX`, and `TMUX_PANE` are removed from the
     EDH child; both GUI and headless launches use `--use-inmemory-secretstorage`

4. **Use a compatible executable.** `npm run dogfood:dev-host -- resolve-code` prefers the current worktree test cache,
   then the primary checkout cache derived from Git's common directory. It rejects WSL `remote-cli/code`, which cannot
   honor the isolated Extension Development Host flags.

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

## Optional: GUI launch

From the repo root (any clean-enough tree; prefer the SHA under test):

```bash
# 1) Build the extension under test
npm run build

# 2) Seed an isolated fixture (prints paths + the exact launch command)
npm run dogfood:dev-host -- seed

# 3) Launch EDH (script can also exec when a code binary is available)
npm run dogfood:dev-host -- launch
```


Manual equivalent (after seed):

```bash
export FIXTURE=…   # printed by seed
export REPO=…      # monorepo path (extensionDevelopmentPath)
code \
  --extensionDevelopmentPath="$REPO" \
  --user-data-dir="$FIXTURE/.edh-user-data" \
  --extensions-dir="$FIXTURE/.edh-extensions" \
  "$FIXTURE/workspace"
```

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

Do not substitute a raw `rm -rf`: a closed desktop EDH intentionally leaves its persistent Bridge alive until the lane
cleanup sends the identity-matched stop request, and fixture agents may leave a private tmux server to terminate.

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
npm run dogfood:dev-host -- point \
  --worktree /path/to/worktree \
  --fixture my-feature \
  --spec 393 \
  --slug my-feature \
  --owner "$TACHYON_AGENT_NAME"

npm run dogfood:dev-host -- point-status   # doctor: worktree, mirror .tachyon, dist/, drift
npm run dogfood:dev-host -- point-clear    # when done / after git worktree remove
```

| Piece | Location |
|-------|----------|
| Stable F5 config | monorepo `.vscode/launch.json` → **Tachyon: Dev Host** (portable `${workspaceFolder}` paths) |
| Pointer (local) | **monorepo** `.tachyon/dev-host/` (`extension` symlink → worktree; `workspace` real mirror → fixture; `meta.json`) |
| Extension bits | worktree via `--extensionDevelopmentPath=…/extension` |
| Opened folder | mirror of isolated **fixture** (never monorepo root) |

**Human:** Run and Debug → **Tachyon: Dev Host** → **F5**. Drive only the EDH window.

### Fixture intents (do not confuse)

| Intent | Expect | Metrics peek? |
|--------|--------|----------------|
| **focus** | Stopped agents OK; task / brief / goal lines | No (Live 0) — by design |
| **metrics** | Autostart busy loops | Yes after Live > 0 |

### Hard rules

1. `--workspace` / resolved fixture must not be the monorepo root (script refuses).
2. Do not reload / reinstall VSIX in the fleet window for this path.
3. Specs document steps under `**Human dogfood:**` in `tasks.md` (not a free-floating `DOGFOOD.md`).
4. After `git worktree remove` of a pointed worktree, run **`point-clear`** (or re-point). `point-status` reports **broken** if the worktree path is gone.
5. Lease (`lane.mjs`) is required for **delegated** headless/GUI pilots; plain F5 pointer for a single human/agent does not auto-acquire a lease.
6. F5 host is always the **primary monorepo checkout**. When `point` runs from a linked worktree,
   the CLI redirects the pointer there automatically; a pointer only under the feature worktree's
   `.tachyon/dev-host` is invisible to monorepo F5 (preLaunchTask fails with a guided error).

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
