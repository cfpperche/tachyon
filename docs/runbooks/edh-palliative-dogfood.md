# EDH palliative dogfood (stopgap until t-1d53e8)

> **Status:** palliative · **Owner of the full lane:** `t-1d53e8` (Establish EDH dogfood lane)  
> **Why this exists:** ship a *safe* way to dogfood UI/config changes **without** reloading the
> maintainer’s normal VS Code window and **without** colliding with concurrent work on SDD 368
> (Delivery / worktree leases / AgentManager spawn paths).

This is **not** the final EDH product. It is intentionally thin: isolated fixture + launch recipe +
forbidden list. When `t-1d53e8` lands (runbook versioned + single-owner concurrency + delegation
template + pilot), this document becomes a pointer or is deleted.

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

4. **One human/agent drives the EDH window.** No second agent “helps” by sending keys into the same EDH.
   Full single-owner lease is deferred to `t-1d53e8`; until then, **social** ownership: announce in the
   task note or chat before launching.

5. **Forbidden while palliative EDH is up:**
   - editing monorepo `tachyon.yml` “to see what happens”
   - `kill-server` on the default tmux socket
   - pruning/removing worktrees under `~/.cache/tachyon/worktrees/b349073a/*` belonging to 368
   - claiming you “dogfooded” without the fixture path + SHA recorded

6. **When palliative EDH is insufficient** (must still do installed-VSIX or main-window checks later):
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
npm run dogfood:edh-palliative -- headless
```

What it asserts (S1 / t-8354ae):

- cold start with **invalid** `tachyon.yml` → `configFailure` present  
- degraded roster from ledger + LKG (not empty-only)  
- LKG-only spawn refused  
- `tachyon.doctor` executes  
- restore valid YAML → reload succeeds  

Report: `$FIXTURE/headless-out/result.json` (+ `host.log` on failure).
PNG evidence: `$FIXTURE/headless-out/shots/fail-visible.png` (copied to `.tachyon/evidence/edh-palliative/`).

Requirements: `Xvfb`, VS Code test binary (`.vscode-test/...` or `TACHYON_EDH_CODE`).

---

## Optional: GUI launch

From the repo root (any clean-enough tree; prefer the SHA under test):

```bash
# 1) Build the extension under test
npm run build

# 2) Seed an isolated fixture (prints paths + the exact launch command)
npm run dogfood:edh-palliative -- seed

# 3) Launch EDH (script can also exec when a code binary is available)
npm run dogfood:edh-palliative -- launch
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
npm run dogfood:edh-palliative -- clean
# or: rm -rf "$FIXTURE"  (only the printed fixture dir)
```

---

## Scenario pack (start here)

### S1 — Fail-visible config (t-8354ae)

**Setup (seed already creates a valid fleet + fake LKG + ledger rows).**

1. Open EDH on the fixture workspace; wait until the Tachyon sidebar lists agents (e.g. `pilot`, `reviewer`).
2. In the fixture only, break config with a **hard** validation error
   (`npm run dogfood:edh-palliative -- break` uses self-referential `subagents: [pilot]`).
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

## Mapping to t-1d53e8 (what remains)

| Palliative has | Full lane (t-1d53e8) still needs |
|----------------|----------------------------------|
| Fixture isolation + forbidden list | Single-owner concurrency enforcement |
| Launch recipe + seed script | Versioned delegation-contract block for agents |
| Worktree vs main guidance (use SHA under test) | Explicit (a) worktree EDH / (b) main EDH / (c) VSIX matrix |
| Human-driven scenarios | Bounded desktop/screen owner + evidence store |
| Pilot of fail-visible optional | **Pilot of SDD 370** as the acceptance pilot |

Do **not** expand this palliative into the full design inside random PRs — land that under `t-1d53e8`.

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
npm run dogfood:edh-palliative -- shortlist
# or: npm run dogfood:ui-shortlist
# subset: npm run dogfood:edh-palliative -- shortlist mermaid grok-activity
```

| Scene | Task | Harness |
|-------|------|---------|
| `mermaid` | t-3febb9 / 374 | activity + fixture `mermaid-nav` |
| `grok-activity` | t-9874be | activity + fixture `grok-feed` |
| `handoff-distill` | t-4eb7c0 | handoff + fixture `distill-list` |
| `fail-visible` | t-8354ae | Xvfb EDH (optional, slower) |

PNGs land under `.tachyon/evidence/ui-shortlist/<stamp>-<sha>/`.
