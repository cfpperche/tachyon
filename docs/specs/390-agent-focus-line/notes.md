# 390 — notes

## Worktree

`/home/goat/tachyon-worktrees/agent-focus-line-poc` · branch `grok/agent-focus-line-poc`

## POC (2026-07-16)

Interactive HTML (no runtime wiring yet):

```bash
# open in browser
xdg-open docs/specs/390-agent-focus-line/prototype.html
# or: file:///…/docs/specs/390-agent-focus-line/prototype.html
```

**Idea under test:** one truncated **focus line** under each agent row.

| Priority | Source | Example |
|----------|--------|---------|
| 1 | Mission Control task (`assignee`) | `t-769666 rebind resume readiness` |
| 2 | Spawn brief | child `leasesalvage3` inherits implement brief |
| 3 | Continuity `# Current Goal` | product design line for grok |
| — | none | omit line (e.g. grok-hermes) |

Filters POC: **On task** · **Has focus** (plus existing All/Live/Needs you).

POC tweak: removed the **working** badge from L2 — redundant once focus line shows subject; green live-dot remains.

## Dev Host dogfood (2026-07-16) — CLOSED

```bash
scripts/dev-host/cli.sh point \
  --worktree /home/goat/tachyon-worktrees/agent-focus-line-poc \
  --workspace …/test/fixtures/agent-focus-line-dogfood \
  --spec 390 --slug agent-focus-line --owner grok
```

Fixture seeds:

| Agent | Focus source |
|-------|----------------|
| grok | task `t-f0c001` |
| solo | continuity goal |
| idle | none |
| helper (adhoc ledger) | spawn brief |

**Human evidence:**

- Focus line + On task / Has focus filters work in Dev Host Agents tab.
- Child row alignment: meta/focus pad must not reuse parent toggle-gutter 28px (fixed to 13px under child name).
- Resource metrics (CPU/MEM peek) only appear for **running** agents with a sampleable pane — expected blank when Live 0 / Stopped N.
- Dev Host mirror: `.tachyon` under fixture must be **copied** into the workspace mirror (`pointer.mjs` `cpSync`), not symlinked — otherwise Soul launch fails closed (parent escapes workspace).

## Deferred / open after land

- Click focus → MC task (v1 = tooltip only)
- Source pill density / default filter when fleet > N
- Manual pin, `set_focus`, activity scrape — not v1
