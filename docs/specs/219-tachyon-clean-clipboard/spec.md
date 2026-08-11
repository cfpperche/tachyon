# 219 — tachyon-clean-clipboard

_Created 2026-06-15._

**Status:** shipped
**Closure:** Landed in commit `8d7e0812`; all seven tasks are checked, with five-round SHIP review and recorded WSL dogfood.

**UI impact:** none
<!-- No UI surface; it changes terminal copy behavior. Verified by drag-selecting scrollback in a
Tachyon pane and pasting — clean UTF-8, no Shift, mouse stays on. -->

## Intent

**Make copying text from a Tachyon terminal "just work" — plain mouse drag-select (incl. scrollback)
→ clean UTF-8 on the OS clipboard, no Shift, no command.** Today the maintainer must Shift+drag
(xterm.js native selection — clean but viewport-bound, doesn't auto-scroll past the edge), because
the natural path (tmux copy-mode) copies via OSC 52, which **VS-Code-on-Windows decodes as Latin-1 →
mojibake** (the A1 incident). So neither path is good: Shift+drag can't reach scrollback; copy-mode
mangles.

**Root cause + the proven fix (live-verified 2026-06-15 on the maintainer's WSL):**
- `mouse on` (Tachyon default) is correct — it gives TUI scroll; `mouse off` breaks it (the wheel
  becomes arrow keys in alt-screen agents). So keep mouse on.
- With mouse on, plain drag enters tmux **copy-mode**, which **auto-scrolls the scrollback natively**
  — the selection part already works. The ONLY problem is the *copy encoding*.
- OSC 52 mangles; `clip.exe` **also** mangles under tmux's `sh` context (inherits an OEM codepage).
- **PowerShell with an explicit UTF-8 input encoding is clean AND fast (~0.2s):**
  `powershell.exe -NoProfile -Command "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"`.
- So: disable OSC 52 (`set-clipboard off`) and bind copy-mode's mouse-drag-end to **copy-pipe** the
  selection to a UTF-8-correct clipboard helper. Clean copy, scrollback, no Shift, mouse stays on.

## Confirmed design (locked with the maintainer 2026-06-15)
- **Default ON, opt-out via `settings.clipboard: auto | off`** (`auto` default). `off` restores
  today's behavior (OSC 52 / `set-clipboard` default, no copy-mode rebind).
- **A bundled, self-detecting clipboard helper** ships in the extension: `media/clipboard-copy.sh`
  (`.vscodeignore` already ships `media/**`). It reads the selection on stdin and pipes to the right
  tool per platform: **WSL → PowerShell (UTF-8 forced)**; **macOS → `pbcopy`**; **Linux Wayland →
  `wl-copy`**; **Linux X11 → `xclip`/`xsel`**. Exits non-zero if none.
- **TmuxService** gains `setClipboardHelper(path | null)`. When set, `newSession`'s boot chain adds
  `set-option -g set-clipboard off` + `bind-key -T copy-mode MouseDragEnd1Pane send -X
  copy-pipe-and-cancel "sh '<helper>'"` + the `copy-mode-vi` variant (re-asserted each new-session,
  race-free, like the existing server options). When null → nothing changes (OSC 52 default).
- **Graceful degradation:** the extension wires the helper only when a clipboard environment is
  detectable (WSL / macOS / Linux-with-a-tool). On a headless/SSH box with no tool, it leaves OSC 52
  (which works over SSH through the terminal) — never makes copy worse. `settings.clipboard: off`
  is the manual escape hatch.
- **Retires the A1 Shift+drag workaround.** README/walkthrough stop recommending Shift+drag for clean
  copy (Shift+drag still works for an in-viewport selection; it's just no longer the clean-copy path).

## Decisions
- **D-A — default ON** with `settings.clipboard: off` opt-out (maintainer-confirmed).
- **D-B — bundled self-detecting `media/clipboard-copy.sh`** (one script, all platforms) rather than
  inlining per-platform commands in the tmux bind (escaping the WSL PowerShell one-liner inside a
  bind is fragile).
- **D-C — Node-side gate** decides whether to wire at all (presence of a clipboard environment); the
  script self-detects the exact tool at copy time.

## Non-goals
- Changing `mouse on` (it's correct for TUI scroll; spec 219 keeps it).
- Solving copy from a full-screen alt-screen TUI's *internal* history (that's the app's, not the
  terminal's) — copy-mode reaches the terminal scrollback, which is what the maintainer needs.
- A "copy pane output" command (the earlier idea — rejected as too much friction vs plain select).

## Acceptance
- With `settings.clipboard` unset/`auto` on a supported platform: a plain mouse drag-select in a
  Tachyon pane (incl. dragging past the viewport into scrollback) copies **clean UTF-8** to the OS
  clipboard, no Shift, mouse still on. Live-verified on WSL.
- `settings.clipboard: off` → no copy-mode rebind, `set-clipboard` left at default (parity with
  pre-219). Config + schema validate the enum.
- `TmuxService.newSession` includes the `set-clipboard off` + both copy-mode `bind-key` clauses
  exactly when a helper is set, and omits them when null. Unit-tested on the args chain.
- `media/clipboard-copy.sh` ships in the vsix and self-detects WSL/macOS/Wayland/X11; exits non-zero
  with no tool. (Logic unit-checkable; platform branches documented.)
- README/walkthrough updated: clean copy is the default; Shift+drag note retired; `settings.clipboard`
  documented. CHANGELOG/site note the fix.
- codex dueto → SHIP.
