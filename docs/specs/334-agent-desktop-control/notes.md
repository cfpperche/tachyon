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

2026-07-03 implementation/dogfood: shipped `/home/goat/tachyon-plugins/agent-desktop` v0.1.0 with Windows-host/WSL
backend and JSON-only stdout for every command. The final dogfood evidence lives in
`.tachyon/evidence/agent-desktop-v1-dogfood-final/`:

- Plugin commit/tag: `9894330` / `v0.29.0`; install source
  `github:cfpperche/tachyon-plugins@v0.29.0#path=agent-desktop`.

- `open-url.json`: opened `https://example.com` in a new Chrome window and returned a target `window_id`.
- `wait-window.json`: matched the same window by `--process chrome --title "Example Domain"`.
- `focus.json`: focused the same `window_id`; direct `SetForegroundWindow` failed, ALT-unlock fallback succeeded, and
  foreground verification passed.
- `restore.json`: restore command succeeded for the same window.
- `chrome.png` and `screenshot.txt`: `agent-screen screenshot --window-id <id>` captured a real PNG without
  using `agent-screen --restore-minimized`.
- `invalid-url.json`: `file:///etc/passwd` failed with `invalid-argument`, exit 64.
- `timeout.json`: missing title failed with `timeout`, exit 73.
- `ambiguous.json`: two Chrome windows made `focus --process chrome` fail with `ambiguous`, exit 72.

Focus-denied behavior is implemented as the fallback when foreground verification never matches after restore, direct
foreground, ALT-unlock, and attach-thread attempts. Local dogfood did not reproduce a true Windows focus-denial state
because ALT-unlock succeeded.

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

## Verification log

### 2026-07-03T03:22:20Z — pass (1/1) — source: tasks.md
- `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — pass

## Dogfood log

### 2026-07-03T03:22:35Z — fail (0/1) — source: tasks.md — commit: efe5c2e964ea4fcb2c8c2860da5c0b9d687b5514
- `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-v1-dogfood-final; mkdir -p "$evidence"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --json > "$evidence/open-url.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh wait-window --process chrome --title "Example Domain" --timeout 15 --json > "$evidence/wait-window.json"; window_id=$(node -e "const j=require(process.argv[1]); console.log(j.window_id)" "$evidence/wait-window.json"); /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh focus --window-id "$window_id" --json > "$evidence/focus.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh restore --window-id "$window_id" --json > "$evidence/restore.json"; /home/goat/tachyon-plugins/agent-screen/skills/agent-screen/scripts/agent-screen.sh screenshot --window-id "$window_id" --out "$evidence/chrome.png" > "$evidence/screenshot.txt"; test -s "$evidence/chrome.png"'` — fail

### 2026-07-03T03:23:17Z — fail (0/1) — source: tasks.md — commit: 20800e34a586b862ead27ab4177d93d9db394b6f
- `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-v1-dogfood-final; mkdir -p "$evidence"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --json > "$evidence/open-url.json"; window_id=$(node -e "const j=require(process.argv[1]); if (!j.ok || !j.window_id) process.exit(1); console.log(j.window_id)" "$evidence/open-url.json"); /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh focus --window-id "$window_id" --json > "$evidence/focus.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh restore --window-id "$window_id" --json > "$evidence/restore.json"; /home/goat/tachyon-plugins/agent-screen/skills/agent-screen/scripts/agent-screen.sh screenshot --window-id "$window_id" --out "$evidence/chrome.png" > "$evidence/screenshot.txt"; test -s "$evidence/chrome.png"'` — fail

### 2026-07-03T03:23:53Z — pass (1/1) — source: tasks.md — commit: 20800e34a586b862ead27ab4177d93d9db394b6f
- `bash -lc 'set -euo pipefail; evidence=.tachyon/evidence/agent-desktop-v1-dogfood-final; mkdir -p "$evidence"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://example.com --json > "$evidence/open-url.json"; window_id=$(node -e "const fs=require(\"fs\"); const j=JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); if (!j.ok || !j.window_id) process.exit(1); console.log(j.window_id)" "$evidence/open-url.json"); /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh focus --window-id "$window_id" --json > "$evidence/focus.json"; /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh restore --window-id "$window_id" --json > "$evidence/restore.json"; /home/goat/tachyon-plugins/agent-screen/skills/agent-screen/scripts/agent-screen.sh screenshot --window-id "$window_id" --out "$evidence/chrome.png" > "$evidence/screenshot.txt"; test -s "$evidence/chrome.png"'` — pass
