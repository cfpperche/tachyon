# 316 — persistence-hook-health-diagnostics — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Health states are `active`, `skipped`, `failed`, and `unknown`.
- `active` and `skipped` are based on current-spawn injection evidence, not desired config alone.
- `failed` comes from the spec-317 failure ledger and only wins when newer than the last active injection.
- The first UI surface is a compact sidebar chip rather than a new inspector panel.
- `active` remains available in the VM/classifier but does not render a badge; only non-active states surface visually.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The initial spec text suggested Inspector first. Sidebar was chosen because the existing agent row already hosts compact
  operational badges and this health state is per-agent, not tmux-server-wide.
- The handoff-pointer script now accepts an optional agent argument when failure logging is enabled so its failure rows
  can be attributed per agent.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- A visible `hooks active` chip was dropped after Claude review because it adds clutter for the healthy case. Active
  remains testable and available to future inspector/settings surfaces.
- No click-through to spec 318 settings yet; the control surface is still owned by spec 318.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Spec 318 should decide whether the hook-health chip becomes clickable to open the persistence settings/control surface.
