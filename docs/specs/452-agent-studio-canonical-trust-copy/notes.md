# 452 — agent-studio-canonical-trust-copy — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- The disclosure is canonical-only and sits directly below Working directory, using the existing hint
  treatment. It names both authorized paths and explicitly excludes approvals, sandbox policy, and
  arbitrary hook trust.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- The existing Agent Studio surface has horizontal overflow at a 390px browser viewport. The added hint
  wraps within the same existing content width and introduces no new minimum width or control crowding;
  this copy-only task does not broaden into a responsive redesign.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None.

## Visual QA

- **Anchor:** the canonical trust authorization must be legible beside Working directory without
  competing with controls or changing the New/Edit form hierarchy.
- **Surface:** preview catalog route `cockpit/studio-agent-canonical`, plus the standalone New/Edit shell
  fixtures, catalog hash `33ce1a4637e`.
- **Viewports:** 720×980 and 390×844.
- **Verdict:** pass. The canonical route exposes the localized disclosure immediately after Working
  directory; the accessibility snapshot confirms the complete wording. Desktop spacing and hierarchy
  remain intact. At 390px the pre-existing form width overflows horizontally, while the new hint wraps
  within that width and adds no control crowding.
- **Artifacts:** `.tachyon/vqa/visual-qa/agent-studio-trust-canonical-720x980.png`,
  `.tachyon/vqa/visual-qa/agent-studio-trust-canonical-390x844.png`, and standalone New/Edit captures in
  the same directory.
