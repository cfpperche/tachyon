import type { ResumeRuntime } from "../resume/adapters.js";
import { evaluateAttentionManifest } from "./manifestEngine.js";
import { attentionManifestForRuntime } from "./manifests.js";

/**
 * Prompt-pattern library for attention detection. The concrete runtime chrome signatures
 * live in src/attention/manifests/*.json; this module keeps the stable public API and
 * metadata parsing helpers used by the monitor/tests.
 */

export interface TailMatch {
  /** The line that matched (trimmed). */
  line: string;
  /** Source pattern, for diagnostics. */
  pattern: string;
}

export type RateLimitRuntime = "claude" | "codex" | "opencode";
export type RateLimitScope = "5h" | "weekly";

export interface RateLimitInfo {
  runtime?: RateLimitRuntime;
  scope?: RateLimitScope;
  /** Best-effort reset time parsed from the CLI's local-time wording. */
  resetAt?: number;
}

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
  const match = evaluateAttentionManifest(attentionManifestForRuntime("claude"), paneText, extras, new Set(["prompt"]));
  return match?.kind === "prompt" ? { line: match.line, pattern: match.pattern } : null;
}

export type TailKind = "prompt" | "error" | "stall";
export interface TailClassification extends TailMatch {
  kind: TailKind;
  rateLimit?: RateLimitInfo;
  skipStateUpdate?: boolean;
  /** How many non-empty tail lines sit BELOW the matched line (0 = matched line is the last
   *  line scanned). Prompts live at the bottom (see TAIL_WINDOW's comment above) — this lets a
   *  caller require "near the bottom", not just "somewhere in the tail window". */
  distanceFromBottom: number;
}

const REAL_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b(rate[- ]?limit(?:ed|ing)?|too many requests|quota exceeded|request limit)\b/i,
  /\busage limit\b[^\n]{0,80}\b(?:exceeded|reached|hit|resets?|try again)\b/i,
  /\b(?:exceeded|reached|hit)\b[^\n]{0,80}\busage limit\b/i,
  /\b(?:you(?:'ve| have)?\s+)?(?:hit|reached)\b[^\n]{0,80}\b(?:usage|rate|request)\s+limit\b/i,
];

/**
 * spec 306 — manifest evaluation preserves the original single bottom-up walk semantics:
 * recency beats category at equal priority, and manifest order breaks same-line ties.
 */
export function classifyAttentionTail(
  paneText: string,
  extraPromptPatterns: RegExp[] = [],
  runtime: ResumeRuntime = "claude",
): TailClassification | null {
  const match = evaluateAttentionManifest(attentionManifestForRuntime(runtime), paneText, extraPromptPatterns);
  if (!match) return null;
  return {
    line: match.line,
    pattern: match.pattern,
    kind: match.kind,
    ...(match.rateLimit ? { rateLimit: match.rateLimit } : {}),
    ...(match.rule.skipStateUpdate ? { skipStateUpdate: true } : {}),
    distanceFromBottom: match.distanceFromBottom,
  };
}

export function parseRateLimitInfo(line: string, now = Date.now()): RateLimitInfo | undefined {
  if (!REAL_RATE_LIMIT_PATTERNS.some((p) => p.test(line))) return undefined;
  const lower = line.toLowerCase();
  const runtime = /\b(claude|anthropic)\b/.test(lower) ? "claude" : /\bopencode\b/.test(lower) ? "opencode" : /\b(codex|openai|gpt)\b/.test(lower) ? "codex" : undefined;
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
