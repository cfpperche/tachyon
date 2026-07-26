# 468 — runtime-native-memory-parity — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-26 — measured inventory

- Installed versions: Claude 2.1.220, Codex 0.145.0, Grok 0.2.112,
  OpenCode 1.18.4, Pi 0.80.10 and Hermes 0.18.2.
- Claude, Codex, Grok and Hermes have native learned-memory mechanisms.
  OpenCode/Pi core do not, but plugins/extensions can introduce equivalent
  prompt-writing authority.
- Probe `probe-42744006-bc41-426a-8047-4d8ad054c213` was requested as Claude
  Opus 5, executed Haiku 4.5 and timed out. Its output was discarded and the
  evidence was attached to `t-37fb51`.
- Implementation roadmap: `t-8c7431`, foundation `t-56daa1`, Claude
  `t-f22211`, Codex `t-c46aad`, Grok `t-c46c35`, Hermes `t-b5d28c`,
  OpenCode/Pi extension boundary `t-b4a557`, UX `t-c3dccf`.
