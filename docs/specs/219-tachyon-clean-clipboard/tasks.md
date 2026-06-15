# 219 — tachyon-clean-clipboard — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Implementation

- [x] 1. **Bundled helper** `media/clipboard-copy.sh` (ships via `.vscodeignore !media/**`): reads
      stdin, self-detects WSL (PowerShell UTF-8) / macOS (`pbcopy`) / Wayland (`wl-copy`) / X11
      (`xclip`/`xsel`); exits non-zero if none. Invoked as `sh '<path>'` (no +x reliance).
- [x] 2. **Pure gate** `src/tmux/clipboard.ts` + test: `isWsl`, `shouldWireClipboard(env)` (WSL /
      macOS / Linux-with-display → wire; headless/unknown → leave OSC 52), `currentClipboardEnv()`.
- [x] 3. **TmuxService** `setClipboardHelper(path|null)` + `newSession` boot chain adds
      `set-option -g set-clipboard off` + `bind-key -T copy-mode|copy-mode-vi MouseDragEnd1Pane
      send-keys -X copy-pipe-and-cancel "sh '<path>'"` when set; nothing when null. 3 arg-chain tests.
- [x] 4. **Config** `settings.clipboard: "auto"|"off"` (default auto) + parse + schema enum.
- [x] 5. **Workspace wiring**: at config-apply, wire the bundled helper path unless
      `clipboard:"off"` AND only when `shouldWireClipboard(currentClipboardEnv())`; else null.
- [x] 6. **Docs**: README copy callout rewritten (clean drag-select default, Shift+drag workaround
      retired, `settings.clipboard: off` opt-out) + settings list.
- [x] 7. **codex dueto** — 5 rounds → SHIP. r1 (MAJOR auto→off didn't unwind a live server; MAJOR
      Linux gate assumed a tool from DISPLAY; MINOR path quoting) → fixed (`--check` real detection +
      unwind branch + POSIX quote). r2 (MAJOR X11 --check ignored $DISPLAY; MAJOR explicit-off couldn't
      unwind post-reload; MINOR no config test) → fixed (DISPLAY gate + forceUnwind + parse tests). r3
      (MAJOR/MINOR process-local flags can't see a persisted server) → fixed by SIMPLIFYING to an
      unconditional idempotent unwind (dropped the flags). r4 (MAJOR unwind used `copy-selection-and-cancel`
      but tmux 3.6's true default is bare `copy-pipe-and-cancel` — verified via list-keys on a fresh
      server) → fixed. r5 **SHIP** (no findings).

## Validated
- clipboard 5/5 + tmux 38/38 + config 31/31 green; typecheck exit 0. Live-proven on WSL earlier
  (clean UTF-8 copy, scrollback, no Shift, ~0.2s, mouse on).

## Notes
- Decision: default ON, `settings.clipboard: off` opt-out (maintainer-confirmed 2026-06-15).
- Keeps `mouse on` (TUI scroll). Retires the A1 Shift+drag clean-copy workaround.
- The bind-key clauses are NOT `set -g`, so they live in TmuxService's boot chain (not settings.tmux).
