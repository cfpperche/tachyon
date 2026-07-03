# 340 — agent-desktop-input-control — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Extend `/home/goat/tachyon-plugins/agent-desktop` with three small input primitives:

```bash
agent-desktop type --window-id <id> --text <text> --session <id> [--dry-run] --json
agent-desktop key --window-id <id> --key <key-or-chord> --session <id> [--dry-run] --json
agent-desktop click --window-id <id> --x <px> --y <px> --session <id> [--expected-bounds <json>] [--dry-run] --json
```

All three commands should:

1. Resolve only an explicit `--window-id`.
2. Require `--session`.
3. Verify or create a session ledger target identity before input, and fail closed on stale/mismatched HWND/process/start
   time/class identity.
4. Record non-owned touched windows with their pre-mutation minimized/foreground state before focusing.
5. Append a ledger event for every dry-run and mutating input action.
6. Focus the target using the existing `Focus-TargetWindow` path.
7. Verify foreground immediately before sending input.
8. Execute one bounded input action.
9. Return compact JSON describing what happened, including post-input foreground identity for mutating actions.

For owned windows, the existing cleanup path closes them. For non-owned touched windows, the spec 338 cleanup behavior
restores minimized state and never closes them. If an owned app becomes dirty and refuses `WM_CLOSE`, cleanup must report
`still_open` and not force-kill it; dogfood should avoid dirty close prompts unless explicitly testing that case.

Implementation should stay in the current Windows-host PowerShell helper inside
`agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`. Use Win32 `SendInput` with `KEYEVENTF_UNICODE` for
literal text; do not use `System.Windows.Forms.SendKeys` for `type`. The bash wrapper should base64(UTF-8)-encode text
and pass it into PowerShell as a `-TextB64` parameter so quotes, braces, semicolons, `$()`, backticks, and trailing
backslashes are data rather than shell syntax. Refuse newline, carriage return, other control characters, and text longer
than 1024 characters.

Use Win32 keyboard input for the `key` allow-list only:

```text
enter, escape, tab, backspace, delete, up, down, left, right, ctrl+a, ctrl+f, ctrl+s, ctrl+z
```

Release synthetic modifiers on all paths. Do not include clipboard shortcuts, `alt+f4`, arbitrary function keys, or
free-form SendKeys strings in v1.

For click, coordinates are screenshot-relative offsets into the DWM extended frame bounds returned by `agent-screen
screenshot --window-id` and `agent-desktop` window records. Translation is `screen_x = bounds.x + x` and
`screen_y = bounds.y + y`. Re-fetch bounds immediately before click; if caller supplied expected bounds and current
bounds differ, refuse. Refuse out-of-bounds coordinates, refuse nonclient hit-test results, focus the target, verify
foreground, verify `WindowFromPoint(screenPoint)` resolves to the same root HWND, then send a single left button
down/up pair. The physical cursor may move and is not restored.

The agent workflow stays outside the plugin:

1. `agent-desktop launch/focus/restore`
2. `agent-screen screenshot --window-id <id>`
3. model chooses exact input
4. `agent-desktop type/key/click`
5. `agent-screen screenshot --window-id <id>`
6. `agent-desktop cleanup --session <id>`

## Key decisions

- **Window-id only for input** — chosen because mouse/keyboard mutation is too risky for fuzzy process/title targeting.
  Rejected process/title input targeting for v1.
- **Session required for input** — chosen because mutation without a ledger cannot be audited, stale-checked, or restored.
  Rejected optional sessions for v1.
- **One input action per command** — chosen because every mutation is auditable and can be followed by a screenshot.
  Rejected macro scripts/background loops for v1.
- **Dry-run on every input primitive** — chosen because input mutates user apps and may affect private data.
- **Whitelisted keys** — chosen because arbitrary key strings are hard to reason about and can trigger destructive
  shortcuts. Start narrow and expand from dogfood.
- **Screenshot/DWM-bounds-relative click coordinates** — chosen because `agent-screen --window-id` captures DWM extended
  frame bounds, not Win32 client area. Rejected client-relative coordinates for v1 because they would misalign with
  screenshot pixels.
- **Nonclient and obscured-click refusal** — chosen because title-bar clicks can close user windows and overlays can steal
  in-bounds clicks.
- **SendInput Unicode plus base64 transport** — chosen because it avoids the `SendKeys` metacharacter language and WSL to
  PowerShell argv quoting bugs.
- **Use existing touched-window cleanup** — chosen because the user already flagged that non-owned windows must return to
  their prior visibility state.

## Files touched

- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — add input commands,
  Win32 input helpers, parsing, dry-run, and ledger touch handling.
- `/home/goat/tachyon-plugins/agent-desktop/README.md` — document input commands and `agent-screen` loop.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/SKILL.md` — teach agents how to pair screenshot and
  input safely.
- `/home/goat/tachyon-plugins/agent-desktop/tachyon-plugin.json` — version bump.
- `docs/specs/340-agent-desktop-input-control/*` — plan, tasks, review, validation, dogfood notes.

## Risks & unknowns

- Synthetic input may be blocked by Windows focus/UIPI rules.
- Elevated apps, games, Electron apps, and RDP sessions may ignore synthetic input or remap it.
- User-held physical modifiers can combine with synthetic input.
- Apps may move or resize between screenshot and click; expected-bounds checks mitigate this only when callers provide
  the screenshot bounds.
- Clicking while the user is moving the mouse can be disruptive.
- A same-named user-launched window can appear during the wait/focus interval; identity checks must remain tight.
- Input to unsaved/recent app state can mutate user data. Consent and dry-run help, but do not remove the risk.

## Visual impact

This mutates real desktop apps. Visual proof should be captured with `agent-screen` before and after input. Headless
dogfood can use Notepad or a disposable app window: open a controlled window, type text, screenshot or inspect title/state,
then cleanup.

## Sources consulted

- `docs/specs/334-agent-desktop-control/*` — original focus/restore/window targeting contract.
- `docs/specs/336-agent-desktop-session-cleanup/*` — ledger ownership and cleanup behavior.
- `docs/specs/338-agent-desktop-app-resolver-native-lifecycle/*` — app lifecycle, touched-window restoration, Fable
  review findings.
- `/home/goat/tachyon-plugins/agent-desktop/README.md` — current plugin contract and non-goals.
