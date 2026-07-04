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
  const lines = tailLines(paneText);
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

/**
 * spec 306 — provider-error signatures (rate limit / overloaded / 429 / 529). Every pattern requires a
 * co-occurring rate/capacity/error-context word — no bare "429"/"529"/"API Error" — so a port number or an
 * ordinary chat mention doesn't misfire. Kept separate from DEFAULT_PATTERNS so tuning one never risks the
 * other's precision.
 */
export const PROVIDER_ERROR_PATTERNS: RegExp[] = [
  /\b(rate[- ]?limit(?:ed|ing)?|too many requests|quota exceeded|usage limit|request limit)\b/i,
  /\b(overloaded|server overloaded|temporarily unavailable|capacity exceeded|at capacity)\b/i,
  /\b(?:api|provider|http|status|error|request)[^\n]{0,60}\b(?:429|529)\b/i,
  /\b(?:429|529)\b[^\n]{0,60}\b(?:api|provider|http|status|error|rate|overload|capacity)\b/i,
  /\b(?:try again later|please try again)\b[^\n]{0,80}\b(?:rate|overload|capacity|429|529)\b/i,
];

/**
 * t-d65be2 — turn-ending transport/connection failures ("API Error: Connection closed
 * mid-response" and siblings). Distinct from PROVIDER_ERROR_PATTERNS: a rate-limit/overload
 * error usually self-resolves via the CLI's own retry, but a dropped connection mid-turn
 * leaves the process sitting there with NOTHING further going to happen — the parent needs
 * a poke, not a wait-and-see. Same precision discipline as PROVIDER_ERROR_PATTERNS: every
 * pattern requires a connection/transport co-occurring signal so an ordinary log line
 * mentioning "error" or "API" can't misfire.
 */
export const STALL_ERROR_PATTERNS: RegExp[] = [
  /\bapi error\b[^\n]{0,60}\b(connection closed|connection reset|timed? ?out|network error|socket hang up)\b/i,
  /\bconnection closed\b[^\n]{0,40}\bmid-response\b/i,
  /\b(socket hang up|econnreset|enotfound|etimedout|econnrefused)\b/i,
];

export type TailKind = "prompt" | "error" | "stall";
export interface TailClassification extends TailMatch { kind: TailKind }

function tailLines(paneText: string): string[] {
  return paneText
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-TAIL_WINDOW);
}

/**
 * spec 306 — a single bottom-up walk checking BOTH provider-error and prompt patterns per line, so recency
 * (not category) decides the winner: a newer prompt below a stale error banner still wins. A line matching
 * both categories ties to "error" (a line that's simultaneously an error banner and prompt-shaped is still
 * fundamentally a provider error). Two independent full-window scans (error-first, then prompts) would let a
 * stale error line anywhere in the tail beat a fresher prompt line further down — this walk fixes that.
 */
export function classifyAttentionTail(paneText: string, extraPromptPatterns: RegExp[] = []): TailClassification | null {
  const lines = tailLines(paneText);
  const promptPatterns = [...extraPromptPatterns, ...DEFAULT_PATTERNS];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const pattern of PROVIDER_ERROR_PATTERNS) {
      if (pattern.test(line)) return { line: line.trim(), pattern: pattern.source, kind: "error" };
    }
    for (const pattern of STALL_ERROR_PATTERNS) {
      if (pattern.test(line)) return { line: line.trim(), pattern: pattern.source, kind: "stall" };
    }
    for (const pattern of promptPatterns) {
      if (pattern.test(line)) return { line: line.trim(), pattern: pattern.source, kind: "prompt" };
    }
  }
  return null;
}
