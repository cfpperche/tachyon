/**
 * Prompt-pattern library for attention detection. High-precision by design: a match
 * drives the strong "needs-input" signal (badge + toast), so broad patterns (e.g. any
 * line ending in "?") are deliberately excluded.
 */

export interface TailMatch {
  /** The line that matched (trimmed). */
  line: string;
  /** Source pattern, for diagnostics. */
  pattern: string;
}

export const DEFAULT_PATTERNS: RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[y\/N\]/,
  /\[Y\/n\]/,
  /\byes\/no\b/i,
  /press enter\b/i,
  /enter to confirm/i,
  /esc to cancel/i,
  /do you want to/i,
  /would you like to/i,
  /continue\?\s*$/i,
  /proceed\?\s*$/i,
  /password[^:]{0,20}:\s*$/i,
  /passphrase[^:]{0,20}:\s*$/i,
  /are you sure/i,
  /awaiting (your )?(input|response|confirmation)/i,
  /❯\s*\d+\./, // numbered selector menus (Claude Code-style pickers)
  /\bselect an option\b/i,
];

/** How many trailing non-empty lines of the pane are scanned. Prompts live at the bottom. */
export const TAIL_WINDOW = 8;

export function compileExtraPatterns(sources: string[]): RegExp[] {
  return sources.map((src) => {
    try {
      return new RegExp(src, "i");
    } catch {
      throw new Error(`invalid attention pattern: ${src}`);
    }
  });
}

/** Scans the last TAIL_WINDOW non-empty lines for a prompt pattern; bottom-most match wins. */
export function classifyTail(paneText: string, extras: RegExp[] = []): TailMatch | null {
  const lines = paneText
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-TAIL_WINDOW);
  const patterns = [...extras, ...DEFAULT_PATTERNS];
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const pattern of patterns) {
      if (pattern.test(lines[i])) {
        return { line: lines[i].trim(), pattern: pattern.source };
      }
    }
  }
  return null;
}
