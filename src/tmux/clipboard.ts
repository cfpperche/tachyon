/**
 * spec 219 — decide whether Tachyon wires its UTF-8 clipboard helper into tmux copy-mode
 * (replacing the OSC 52 path, which VS-Code-on-Windows mangles).
 *
 * The bundled helper (`media/clipboard-copy.sh`) is the single source of truth for "is a clipboard
 * tool available on this box" — we run it with `--check` (no stdin, no copy; exit 0 = a tool exists)
 * and only wire it when that succeeds. So a headless/SSH box with no clipboard tool keeps the OSC 52
 * default (which rides the terminal back to the client) instead of silently failing to copy after we
 * disabled OSC 52. This avoids any drift between a hand-maintained tool list and the script's.
 */

import { execFileSync } from "node:child_process";

/** Runs `sh <helper> --check`; true when a usable clipboard tool is detected. Injectable for tests. */
export type ClipboardCheck = (helperPath: string) => boolean;

export const defaultClipboardCheck: ClipboardCheck = (helperPath) => {
  try {
    execFileSync("sh", [helperPath, "--check"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * The clipboard helper path to wire, or null. null when opted out (`settings.clipboard: off`) or when
 * no clipboard tool is detected (`--check` fails) — in both cases TmuxService restores the OSC 52
 * default (unconditional, idempotent unwind). Pure given the injected `check`.
 */
export function resolveClipboardHelper(opts: {
  clipboardOff: boolean;
  helperPath: string;
  check?: ClipboardCheck;
}): string | null {
  if (opts.clipboardOff) return null;
  const check = opts.check ?? defaultClipboardCheck;
  return check(opts.helperPath) ? opts.helperPath : null;
}
