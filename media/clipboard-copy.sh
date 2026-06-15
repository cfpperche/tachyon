#!/bin/sh
# Tachyon clipboard helper (spec 219). Reads a tmux selection on stdin and copies it to the OS
# clipboard with correct UTF-8. Tachyon binds tmux copy-mode's mouse-drag-end to this, so a plain
# drag-select (including scrollback) copies cleanly — no Shift, no OSC 52 mojibake.
#
# Platform order: WSL (PowerShell, UTF-8 forced) -> macOS (pbcopy) -> Wayland (wl-copy) ->
# X11 (xclip/xsel). Exits non-zero if no clipboard tool is found.
#
# `--check`: detect a usable clipboard tool WITHOUT reading stdin or copying — exit 0 if one exists,
# 1 if none. Tachyon runs this once before wiring, and only disables OSC 52 + rebinds copy-mode when
# it succeeds, so a box with no tool keeps the OSC 52 default instead of silently failing to copy.

check=""
[ "${1:-}" = "--check" ] && check=1

# --- WSL: clip.exe mangles UTF-8 under tmux's sh context (OEM codepage); PowerShell with an
# explicit UTF-8 InputEncoding is clean (and ~0.2s). ---
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  for ps in powershell.exe \
            /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe \
            pwsh.exe; do
    if command -v "$ps" >/dev/null 2>&1 || [ -x "$ps" ]; then
      [ -n "$check" ] && exit 0
      exec "$ps" -NoProfile -Command \
        "[Console]::InputEncoding=[System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"
    fi
  done
fi

# --- macOS ---
if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v pbcopy >/dev/null 2>&1; then
  [ -n "$check" ] && exit 0
  exec pbcopy
fi

# --- Linux: Wayland first, then X11. Require a display — a tool on PATH without a session (headless/
# SSH) would fail at runtime, and we must NOT disable OSC 52 in that case. ---
if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
  [ -n "$check" ] && exit 0
  exec wl-copy
fi
if [ -n "${DISPLAY:-}" ] && command -v xclip >/dev/null 2>&1; then
  [ -n "$check" ] && exit 0
  exec xclip -selection clipboard -in
fi
if [ -n "${DISPLAY:-}" ] && command -v xsel >/dev/null 2>&1; then
  [ -n "$check" ] && exit 0
  exec xsel --clipboard --input
fi

exit 1
