# 334 — agent-desktop-control — notes

_Created 2026-07-02._

## Design decisions

2026-07-02: initial direction from owner conversation. `agent-screen` is "eyes"; `agent-desktop` is "hands". The plugin
should be separate from `agent-screen` because app/window control mutates the user's desktop while screenshot capture is
evidence collection.

2026-07-02: v1 should start with app/window control only: launch, open URL, focus, restore, wait. Mouse and keyboard
primitives are intentionally future work because they are broader and riskier. Composite `ensure` was moved out of v1
after probe review because it duplicates primitives and doubles semantics before they are proven.

2026-07-02: consent posture mirrors `agent-screen`: the user explicitly consents to the operation and accepts the current
privacy risk. Sensitive-data detection/redaction/blur is deferred.

2026-07-02: Claude Fable probe `probe-237fa645-b227-41c8-849f-b0946c8b8e78` reviewed the draft. Material changes folded:
focus/restore must be spiked before full implementation because Windows foreground restrictions can make
`SetForegroundWindow` silently fail; `open-url` must be deterministic because Chrome's single-instance model makes
`wait-window --process chrome` racy; `wait-window` needs title matching; every command needs JSON-capable output and
documented exit codes; dogfood must validate `agent-desktop` restore/focus instead of leaning on
`agent-screen --restore-minimized`.

2026-07-02 focus/restore spike: created `.tachyon/evidence/agent-desktop-focus-spike/focus-spike.ps1` and tested real
Chrome and VS Code windows from WSL PowerShell. Results:

- Chrome visible but not foreground: `ShowWindow(SW_RESTORE) + SetForegroundWindow` returned `apiOk=false` and did not
  focus; ALT-unlock + `SetForegroundWindow` returned `apiOk=true` and foregrounded Chrome.
- VS Code visible but not foreground: same result; direct foreground failed, ALT-unlock succeeded.
- Chrome minimized: `ShowWindow(SW_RESTORE) + SetForegroundWindow` restored and foregrounded directly.
- `agent-screen screenshot --active` visually confirmed the foreground target after each successful focus/restore:
  `.tachyon/evidence/agent-desktop-focus-spike/active-after-focus-chrome.png`,
  `.tachyon/evidence/agent-desktop-focus-spike/active-after-focus-code.png`, and
  `.tachyon/evidence/agent-desktop-focus-spike/active-after-restore-chrome.png`.

Decision: v1 focus should not trust `SetForegroundWindow` return value alone. It should verify foreground after each
attempt and only report success when `GetForegroundWindow`/root handle matches the target. The default focus sequence is
restore, direct foreground, ALT-unlock foreground, then `AttachThreadInput` fallback. If none works, return a
machine-readable `focus-denied` error.

## Follow-ups Already Registered

- V1.1 candidate: window layout (`move`, `resize`, `arrange`) to set up side-by-side screenshots before `agent-screen`.
- V1.1 candidate: composite `ensure` after primitive command semantics are proven.
- V2 candidate: keyboard primitives (`hotkey`, `type`) with stricter target/timeout constraints.
- V2 candidate: mouse primitives (`click`, `scroll`) with target-window-relative coordinates and strong guardrails.
- Future privacy pass: warnings or redaction for URLs/window titles/clipboard-like content once basic control is proven.

## Probe Requests

- Claude Fable review completed via `probe_agent`.
- First probe attempt `probe-01326f48-405f-46b4-978f-13682dc7d205` failed on budget before returning useful review.
- Second probe attempt `probe-237fa645-b227-41c8-849f-b0946c8b8e78` completed and was folded into spec/plan/tasks.
