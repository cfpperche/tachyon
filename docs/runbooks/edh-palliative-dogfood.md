# EDH dogfood lane v1

> **Status:** versioned final lane · **Contract owner:** `t-1d53e8`

This is the single-owner lane for isolated Extension Development Host dogfood. The historical
`dogfood:edh-palliative` command remains as a compatibility alias; new use should call `npm run dogfood:edh`.

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
node scripts/edh-palliative/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood:edh -- headless

# GUI owner holds the lease across the separate desktop step
node scripts/edh-palliative/lane.mjs acquire --owner coordinator --target worktree
node scripts/edh-palliative/lane.mjs status
node scripts/edh-palliative/lane.mjs release --owner coordinator
```

If a hard crash leaves `owner.lease` present but completely empty, inspect it and use
`node scripts/edh-palliative/lane.mjs recover`. Recovery is intentionally ownerless and narrow: it removes only an
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

4. **Use a compatible executable.** `npm run dogfood:edh -- resolve-code` prefers the current worktree test cache,
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
(`scripts/edh-palliative/headless-runner.js`) — same class of dogfood as
`scripts/screenshots/capture.sh`, without sign-in wizards or desktop focus.

```bash
npm run build
npm run dogfood:edh -- headless
```

What it asserts (S1 / t-8354ae):

- cold start with **invalid** `tachyon.yml` → `configFailure` present  
- degraded roster from ledger + LKG (not empty-only)  
- LKG-only spawn refused  
- `tachyon.doctor` executes  
- restore valid YAML → reload succeeds  

Report: `$FIXTURE/headless-out/result.json` (+ `host.log` on failure).
PNG evidence: `$FIXTURE/headless-out/shots/fail-visible.png` (copied to `.tachyon/evidence/edh-palliative/`).

Requirements: `Xvfb`, and a compatible VS Code test/native binary. The resolver also sees the primary checkout's
`.vscode-test` cache when this command runs from an isolated worktree.

---

## Optional: GUI launch

From the repo root (any clean-enough tree; prefer the SHA under test):

```bash
# 1) Build the extension under test
npm run build

# 2) Seed an isolated fixture (prints paths + the exact launch command)
npm run dogfood:edh -- seed

# 3) Launch EDH (script can also exec when a code binary is available)
npm run dogfood:edh -- launch
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
npm run dogfood:edh -- clean
```

Do not substitute a raw `rm -rf`: a closed desktop EDH intentionally leaves its persistent Bridge alive until the lane
cleanup sends the identity-matched stop request, and fixture agents may leave a private tmux server to terminate.

---

## Scenario pack (start here)

### S1 — Fail-visible config (t-8354ae)

**Setup (seed already creates a valid fleet + fake LKG + ledger rows).**

1. Open EDH on the fixture workspace; wait until the Tachyon sidebar lists agents (e.g. `pilot`, `reviewer`).
2. In the fixture only, break config with a **hard** validation error
   (`npm run dogfood:edh -- break` uses self-referential `subagents: [pilot]`).
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

## Related

- Task: `t-1d53e8` — Establish EDH dogfood lane and pilot it with SDD 370  
- Task: `t-8354ae` — Fail-visible config (banner / LKG / Doctor) — first scenario pack target  
- Script: `scripts/edh-palliative/edh-palliative.sh`  
- Product boundary: `docs/architecture/dogfood-product-boundary.md`

## UI shortlist (headless Chromium / preview harness)

For landed UI surfaces that need a glance without a full EDH window:

```bash
npm run build
npm run dogfood:edh -- shortlist
# or: npm run dogfood:ui-shortlist
# subset: npm run dogfood:edh -- shortlist mermaid grok-activity
```

| Scene | Task | Harness |
|-------|------|---------|
| `mermaid` | t-3febb9 / 374 | activity + fixture `mermaid-nav` |
| `grok-activity` | t-9874be | activity + fixture `grok-feed` |
| `handoff-distill` | t-4eb7c0 | handoff + fixture `distill-list` |
| `fail-visible` | t-8354ae | Xvfb EDH (optional, slower) |

PNGs land under `.tachyon/evidence/ui-shortlist/<stamp>-<sha>/`.
