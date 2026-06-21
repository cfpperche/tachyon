# Debate 242 — sortable sidebar lists

**Phase:** review · **Date:** 2026-06-21 · **Participants:** Claude (author) + Codex (reviewer) · **Verdict:** SPEC-READY-WITH-CHANGES → folded into `spec.md`

Codex reviewed the plan adversarially. Core direction sound (drop status-grouping for churn lists; stable A–Z
default); not build-ready until multi-root, a11y, first-render persistence, the lost status-count, and the phase
boundary were pinned down. All folded.

## Per-decision
- **D1 KEEP + boundary** → multi-root must NOT intermix folders; sort within each root (new **D7**).
- **D2 KEEP + label** → offer `Status (live)` so the reflowing mode is self-describing; no hidden "stable-but-status-aware" hybrid (that's just grouping renamed).
- **D3 KEEP** → persist from v1; **global per-user, per-section**, applied within each folder (OQ1).
- **D4 KEEP icon-menu (not cycle)** → a cycle button too-easily drops you into reflowing `Status`. Define header layout: title · count · status-chips · spacer · sort-button · ＋New; accessible name "Sort agents".
- **D5 CHANGE** → dot tooltip alone isn't scan-/a11y-friendly AND loses the per-status count the group headers gave. Add compact non-interactive **status count chips** in the header (`●1 ●4` with `aria-label="Running: 1"`) + row-level accessible status text (OQ5 = real regression).
- **D6 CHANGE** → don't phase Terminals out while acceptance requires it. Ship **both Agents + Terminals** in 242 (true twins, one code path); implement Agents first then Terminals. Rename the helper generic — `sortStatusRows(rows, mode, getName, getStatus)` — Terminals won't reuse a `sortAgents`.

## OQ resolutions
OQ1 global per-user per-section (applied within each folder) · OQ2 flat STATUS_ORDER + name tiebreak is enough · OQ3 persist from the start · OQ4 icon menu · OQ5 keep per-status counts (chips) — real regression.

## New decisions added
- **D7** multi-root sort boundary (preserve folder order; sort within).
- **D8** no first-render flicker — host includes saved prefs in the INITIAL VM (never render default then re-sort).
- **D9** race rule — `setSort` mutates one authoritative host prefs object then republishes fleet+prefs; a stale fleet snapshot must not clobber newer prefs.
- **D10** accessibility — keyboard sort menu, checked active item, Escape dismiss, focus return, row status without hover.
- **D11** flash/auto-scroll target row IDs after sort (not indices); a status change under `name-asc` must not retrigger auto-scroll.
- **D12** existing-user migration — unset = `name-asc`, no legacy grouping mode; call the silent layout change out in release notes.
