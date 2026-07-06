# 361 — reload-restore-panels-terminals — notes

_Created 2026-07-06._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Added `registerTrustedPanelSerializer` and webview-side persisted state bootstrap. No plugin UI serializer was registered.
- Registered serializers for Mission Control, Task Detail, Activity, Handoff, Server Inspector, Pin Studio, Task Studio, and Agent Studio Shell.
- Added a per-workspace transient terminal manifest in `Terminals`, restored after activation only when `tmux.hasSession(session)` succeeds.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

- Studio reload state restores the document identity. Live dirty-patch restore is left to a future webview-side form-state contract because it is larger than Parte A/B and not required to prevent the panel from disappearing.
- `panel.webview.options` can only restore scripts/local roots on a deserialized panel; creation-only options like `retainContextWhenHidden` and `enableFindWidget` remain on the normal create path.

## Verification log

- Passed `npm run typecheck`.
- Passed `npm test -- --run`.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
