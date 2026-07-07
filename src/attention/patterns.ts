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

export type RateLimitRuntime = "claude" | "codex";
export type RateLimitScope = "5h" | "weekly";

export interface RateLimitInfo {
  runtime?: RateLimitRuntime;
  scope?: RateLimitScope;
  /** Best-effort reset time parsed from the CLI's local-time wording. */
  resetAt?: number;
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
 * spec 306 — provider-error signatures (rate limit / overloaded / 429 / 529 / provider 5xx).
 * Every pattern requires a co-occurring provider/capacity/server/error-context word — no bare status code
 * or "API Error" — so a port number or an ordinary chat mention doesn't misfire. Kept separate from
 * DEFAULT_PATTERNS so tuning one never risks the other's precision.
 */
export const PROVIDER_ERROR_PATTERNS: RegExp[] = [
  /\b(rate[- ]?limit(?:ed|ing)?|too many requests|quota exceeded|request limit)\b/i,
  /\busage limit\b[^\n]{0,60}\b(?:exceeded|reached|hit)\b/i,
  /\b(?:exceeded|reached|hit)\b[^\n]{0,60}\busage limit\b/i,
  /\b(?:you(?:'ve| have)?\s+)?(?:hit|reached)\b[^\n]{0,80}\b(?:usage|rate|request)\s+limit\b/i,
  /\b(?:usage|rate|request)\s+limit\b[^\n]{0,120}\b(?:resets?|try again)\b[^\n]{0,80}\b(?:at|after|in)\b/i,
  /\b(overloaded|server overloaded|temporarily unavailable|capacity exceeded|at capacity)\b/i,
  /\b(?:api|provider|http|status|error|request)[^\n]{0,60}\b(?:429|529)\b/i,
  /\b(?:429|529)\b[^\n]{0,60}\b(?:api|provider|http|status|error|rate|overload|capacity)\b/i,
  /\b(?:api|provider|http|status|error|request)[^\n]{0,80}\b5\d\d\b[^\n]{0,80}\b(?:internal server error|server error|service unavailable|bad gateway|gateway timeout|overload|capacity)\b/i,
  /\b5\d\d\b[^\n]{0,80}\b(?:internal server error|server error|service unavailable|bad gateway|gateway timeout|overload|capacity)\b[^\n]{0,80}\b(?:api|provider|http|status|error|request)\b/i,
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
export interface TailClassification extends TailMatch {
  kind: TailKind;
  rateLimit?: RateLimitInfo;
}

const REAL_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b(rate[- ]?limit(?:ed|ing)?|too many requests|quota exceeded|request limit)\b/i,
  /\busage limit\b[^\n]{0,80}\b(?:exceeded|reached|hit|resets?|try again)\b/i,
  /\b(?:exceeded|reached|hit)\b[^\n]{0,80}\busage limit\b/i,
  /\b(?:you(?:'ve| have)?\s+)?(?:hit|reached)\b[^\n]{0,80}\b(?:usage|rate|request)\s+limit\b/i,
];

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
      if (pattern.test(line)) return { line: line.trim(), pattern: pattern.source, kind: "error", rateLimit: parseRateLimitInfo(line) };
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

export function parseRateLimitInfo(line: string, now = Date.now()): RateLimitInfo | undefined {
  if (!REAL_RATE_LIMIT_PATTERNS.some((p) => p.test(line))) return undefined;
  const lower = line.toLowerCase();
  const runtime = /\b(claude|anthropic)\b/.test(lower) ? "claude" : /\b(codex|openai|gpt)\b/.test(lower) ? "codex" : undefined;
  const scope = /\b(weekly|7d|7-day|week)\b/.test(lower) ? "weekly" : /\b(5h|5-hour|5 hour|five-hour|session)\b/.test(lower) ? "5h" : undefined;
  return { runtime, scope, resetAt: parseResetAt(line, now) };
}

function parseResetAt(line: string, now: number): number | undefined {
  const relative = /\b(?:resets?|try again)\b[^\n]{0,60}\bin\s+((?:(?:\d+)\s*(?:hours|hour|hrs|hr|h|minutes|minute|mins|min|m)\b\s*){1,3})/i.exec(line);
  if (relative) {
    const ms = parseRelativeDuration(relative[1]);
    if (ms !== undefined) return now + ms;
  }

  const absolute = /\b(?:resets?|reset|try again)\b[^\n]{0,80}\b(?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(line);
  if (!absolute) return undefined;

  let hour = Number.parseInt(absolute[1], 10);
  const minute = absolute[2] ? Number.parseInt(absolute[2], 10) : 0;
  const meridiem = absolute[3]?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return undefined;

  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now - 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function parseRelativeDuration(text: string): number | undefined {
  let total = 0;
  for (const m of text.matchAll(/(\d+)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)\b/gi)) {
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    total += /^h|^hour/i.test(m[2]) ? n * 60 * 60_000 : n * 60_000;
  }
  return total > 0 ? total : undefined;
}
