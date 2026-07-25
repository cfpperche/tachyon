# 453 — agent-studio-static-sections — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- The three task-named configuration blocks are semantic regions with visible headings. Agent Evolution's
  per-file diff disclosure remains scoped to reviewing individual generated files and is not a form
  configuration block.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- Narrow preview measurement exposed a pre-existing 760px intrinsic form width inside the Cockpit shell.
  The Agent form now constrains itself to `100vw` below 720px, making the changed surface genuinely
  responsive rather than documenting a misleading clipped capture.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None.

## Visual QA

- **Anchor:** Persistent instructions, Git worktree isolation, and applicable Isolated harness must read
  as always-expanded in-flow cards with clear hierarchy and no disclosure affordance.
- **Surface:** preview catalog routes `cockpit/studio-agent` and `cockpit/studio-agent-edit`.
- **Viewports:** 720×980 and 390×844.
- **Verdict:** pass. New and Edit expose the static regions in the accessibility tree, all controls remain
  visible, and the applicable Edit harness is present. At 390px the form measures 358px at x=16, cards
  and fields wrap without horizontal overflow; desktop remains centered and compact.
- **Artifacts:** `.tachyon/vqa/visual-qa/agent-studio-static-sections-new-720x980.png`,
  `.tachyon/vqa/visual-qa/agent-studio-static-sections-new-390x844.png`,
  `.tachyon/vqa/visual-qa/agent-studio-static-sections-edit-720x980.png`, and
  `.tachyon/vqa/visual-qa/agent-studio-static-sections-edit-390x844.png`.
