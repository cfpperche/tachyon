# 334 — agent-desktop-control — tasks

_Generated from `plan.md` on 2026-07-02._

## Planning

- [x] Record the `agent-desktop` direction: desktop "hands" paired with `agent-screen` desktop "eyes".
- [x] Keep arbitrary keyboard/mouse automation out of v1.
- [x] Record consent posture: user consent permits explicit desktop mutation; privacy filtering is future work.
- [x] Fold Claude Fable probe feedback into the plan.
- [x] Cut composite `ensure` from v1.
- [x] Require deterministic `open-url`/`wait-window` matching beyond process name alone.

## Implementation

- [x] Spike Windows foreground/focus feasibility from WSL PowerShell.
- [x] Decide and document the Windows foreground workaround/failure mode.
- [ ] Scaffold `agent-desktop` plugin in `/home/goat/tachyon-plugins`.
- [ ] Implement `agent-desktop doctor`.
- [ ] Implement `agent-desktop list-windows --json [--verbose]`.
- [ ] Implement `agent-desktop launch --app <name-or-path>`.
- [ ] Implement `agent-desktop open-url --browser chrome [--new-window] <https-url>`.
- [ ] Implement `agent-desktop wait-window --process <name> [--title <substring>] --timeout <seconds>`.
- [ ] Implement `agent-desktop focus --window-id <id>` and `focus --process <name>`.
- [ ] Implement `agent-desktop restore --window-id <id>`.
- [ ] Implement JSON-capable output and documented exit codes for every command.
- [ ] Restrict `open-url` v1 to `http://` and `https://` URLs.
- [ ] Document consent, state mutation, and pairing with `agent-screen`.

## Verification

- [ ] Smoke `agent-desktop doctor`.
- [ ] Smoke `list-windows --json` and validate JSON shape.
- [ ] Smoke `launch --app chrome` or `open-url --browser chrome --new-window <url>`.
- [ ] Smoke `wait-window --process chrome --title <substring> --timeout 10`.
- [ ] Smoke `focus --window-id <id>`.
- [ ] Smoke ambiguity failure for process/query matching.
- [ ] Smoke focus-denied failure if Windows refuses foregrounding.
- [ ] Verify command output includes selected id/process/bounds and state flags.

**Verify:** `bash -n /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh`

## Dogfood

**Dogfood:** `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh open-url --browser chrome --new-window https://github.com && /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh wait-window --process chrome --title GitHub --timeout 10 && /home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh focus --process chrome --title GitHub --json && /home/goat/tachyon-plugins/agent-screen/skills/agent-screen/scripts/agent-screen.sh screenshot --window chrome --out .tachyon/evidence/agent-desktop-open-url/chrome.png`

**Human dogfood:** Use the installed plugin to open/focus Chrome or VS Code, then use installed `agent-screen` to capture
the resulting window.

## Visual QA

- [ ] Evidence: `agent-screen` screenshot of a window opened/focused/restored by `agent-desktop`.
- [ ] Verdict:

## Future Backlog

- [ ] Add layout commands: move, resize, arrange left/right.
- [ ] Add composite `ensure` once primitive command semantics are stable.
- [ ] Add explicit keyboard primitives: hotkey, type.
- [ ] Add explicit mouse primitives: click, move, scroll.
- [ ] Add optional restore-after/minimize-after cleanup semantics.
- [ ] Add privacy-aware warnings/redaction once basic control is proven useful.
