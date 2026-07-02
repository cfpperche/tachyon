# 324 — activity-share-actions — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Claude review `probe-7177613c-bdc2-4583-895f-f7dc14706445` rejected immediate internal submit as too risky. Final v1 stages the prompt in the destination pane with `enter=false`.
- External share always shows a modal preview/confirmation before opening `mailto:` or WhatsApp Web because Activity can contain injected context or model output.
- The webview sends only `sequence + shareKey`; the host recomputes the payload from the last posted VM and refuses stale keys instead of trusting webview text.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- No auto-submit flow is implemented. This is intentional and captured as a non-goal until a later spec defines a safe submit contract.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- URL share payload is capped more tightly than clipboard payload. This avoids very long `mailto:` / `wa.me` URLs; Copy remains the full bounded payload fallback.
- Internal destinations are limited to other currently running AI agents. That avoids surprising auto-resume/start behavior and avoids sending Activity content into terminal/process rows.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Human dogfood still needs to validate the exact VS Code QuickPick/modal flow and whether the hover affordance is discoverable enough in the real theme.
