# 340 — agent-desktop-input-control — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

2026-07-03: Claude Fable ad-hoc review via Bridge spawn `claude-fable-340-spec-review` returned NEEDS-CHANGES. Folded
the six major findings before implementation:

- click coordinates are screenshot/DWM-bounds-relative, not Win32 client-relative;
- click must refuse topmost-at-point mismatch/obscured targets;
- click must refuse nonclient/title-bar points so input cannot close user windows through the side door;
- `--session` is mandatory for `type`/`key`/`click`, with per-input ledger events;
- dogfood must not leave dirty Notepad/save prompts unless explicitly testing that cleanup behavior;
- `type` uses base64 UTF-8 transport plus Win32 `SendInput` Unicode, not `SendKeys`.

Folded minor findings too: explicit key allow-list, foreground verification immediately before injection, post-input
foreground identity in JSON, modifier release hygiene, single-left-click semantics, and pinned exit-code mapping.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
