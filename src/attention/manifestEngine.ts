import { runtimeProfile } from "../runtime/runtimeProfile.js";
import type { ResumeRuntime } from "../resume/adapters.js";
import { parseRateLimitInfo, type RateLimitInfo } from "./patterns.js";

/**
 * t-c59600 — who a manifest is FOR. A declared runtime, or `neutral`: an entry that declared no
 * runtime at all (today: `kind: terminal`, whose `cmdOf` returns null by design). Neutral is not a
 * runtime and never resolves a runtime overlay — it exists so "no runtime declared" stops being
 * spelled as "claude" by a default parameter.
 */
export type AttentionManifestScope = ResumeRuntime | "neutral";

export type ManifestAttentionState = "idle" | "working" | "needs-input" | "unknown" | "throttled";
export type ManifestMatchKind = "prompt" | "error" | "stall";
export type ManifestRegion =
  | "whole_recent"
  | "prompt_box_body"
  | { bottom_non_empty_lines: number };

export type ManifestMatcher =
  | { contains: string; flags?: string }
  | { regex: string; flags?: string }
  | { lineRegex: string; flags?: string }
  | { any: ManifestMatcher[] }
  | { all: ManifestMatcher[] }
  | { not: ManifestMatcher };

export interface AttentionManifestRule {
  id: string;
  state: ManifestAttentionState;
  priority: number;
  region: ManifestRegion;
  matcher: ManifestMatcher;
  kind?: ManifestMatchKind;
  skipStateUpdate?: boolean;
  evidence?: string;
}

export interface AttentionManifest {
  version: string;
  runtime: AttentionManifestScope;
  evidence: string;
  rules: AttentionManifestRule[];
}

export interface ManifestRuleMatch {
  rule: AttentionManifestRule;
  line: string;
  pattern: string;
  kind: ManifestMatchKind;
  rateLimit?: RateLimitInfo;
  distanceFromBottom: number;
}

interface RegionLine {
  text: string;
  distanceFromBottom: number;
}

interface MatcherHit {
  line: string;
  pattern: string;
  distanceFromBottom: number;
}

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function evaluateAttentionManifest(
  manifest: AttentionManifest,
  paneText: string,
  extraPromptPatterns: RegExp[] = [],
  allowedKinds?: ReadonlySet<ManifestMatchKind>,
): ManifestRuleMatch | null {
  let best: ManifestRuleMatch | null = null;
  for (const [order, rule] of manifest.rules.entries()) {
    const hit = matchRule(manifest.runtime, paneText, rule, extraPromptPatterns);
    if (!hit) continue;
    const kind = rule.kind ?? kindForState(rule.state);
    if (allowedKinds && !allowedKinds.has(kind)) continue;
    const candidate: ManifestRuleMatch = {
      rule,
      line: hit.line.trim(),
      pattern: hit.pattern,
      kind,
      ...(rule.state === "throttled" ? { rateLimit: parseRateLimitInfo(hit.line) } : {}),
      distanceFromBottom: hit.distanceFromBottom,
    };
    if (!best || compareMatches(candidate, order, best, manifest.rules.indexOf(best.rule)) < 0) best = candidate;
  }
  return best;
}

function compareMatches(a: ManifestRuleMatch, aOrder: number, b: ManifestRuleMatch, bOrder: number): number {
  if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
  if (a.distanceFromBottom !== b.distanceFromBottom) return a.distanceFromBottom - b.distanceFromBottom;
  return aOrder - bOrder;
}

function matchRule(
  runtime: AttentionManifestScope,
  paneText: string,
  rule: AttentionManifestRule,
  extraPromptPatterns: RegExp[],
): MatcherHit | null {
  const lines = regionLines(runtime, paneText, rule.region);
  return matchLines(lines, rule.matcher, rule.id === "extra_prompt_patterns" ? extraPromptPatterns : []);
}

function matchLines(lines: RegionLine[], matcher: ManifestMatcher, extraPatterns: RegExp[]): MatcherHit | null {
  if ("any" in matcher) return bestHit(matcher.any.map((child) => matchLines(lines, child, extraPatterns)));
  if ("all" in matcher) {
    const hits = matcher.all.map((child) => matchLines(lines, child, extraPatterns));
    return hits.every(Boolean) ? (hits.find(Boolean) ?? null) : null;
  }
  if ("not" in matcher) return matchLines(lines, matcher.not, extraPatterns) ? null : fallbackHit(lines);
  if ("contains" in matcher) return matchText(lines, matcher.contains, "contains", matcher.flags);
  if ("regex" in matcher) return matchText(lines, matcher.regex, "regex", matcher.flags);
  return bestHit([matchText(lines, matcher.lineRegex, "lineRegex", matcher.flags), matchExtra(lines, extraPatterns)]);
}

function matchText(lines: RegionLine[], source: string, kind: "contains" | "regex" | "lineRegex", flags = ""): MatcherHit | null {
  if (kind === "contains") {
    for (const line of lines) {
      const haystack = flags.includes("i") ? line.text.toLowerCase() : line.text;
      const needle = flags.includes("i") ? source.toLowerCase() : source;
      if (haystack.includes(needle)) return { line: line.text, pattern: source, distanceFromBottom: line.distanceFromBottom };
    }
    return null;
  }
  const pattern = new RegExp(source, flags);
  const text = lines.map((line) => line.text).join("\n");
  if (kind === "regex" && pattern.test(text)) {
    const line = lines.find((candidate) => pattern.test(candidate.text)) ?? lines[0];
    return line ? { line: line.text, pattern: pattern.source, distanceFromBottom: line.distanceFromBottom } : null;
  }
  for (const line of lines) {
    if (pattern.test(line.text)) return { line: line.text, pattern: pattern.source, distanceFromBottom: line.distanceFromBottom };
  }
  return null;
}

function matchExtra(lines: RegionLine[], patterns: RegExp[]): MatcherHit | null {
  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line.text)) return { line: line.text, pattern: pattern.source, distanceFromBottom: line.distanceFromBottom };
    }
  }
  return null;
}

function bestHit(hits: Array<MatcherHit | null>): MatcherHit | null {
  return hits.filter((hit): hit is MatcherHit => !!hit).sort((a, b) => a.distanceFromBottom - b.distanceFromBottom)[0] ?? null;
}

function fallbackHit(lines: RegionLine[]): MatcherHit | null {
  const line = lines[0];
  return line ? { line: line.text, pattern: "not", distanceFromBottom: line.distanceFromBottom } : null;
}

function regionLines(runtime: AttentionManifestScope, paneText: string, region: ManifestRegion): RegionLine[] {
  const allLines = paneText.split("\n").map((line) => line.trimEnd());
  if (region === "whole_recent") return withDistance(allLines.filter((line) => line.trim().length > 0));
  if (region === "prompt_box_body") return withDistance(promptBoxBody(runtime, allLines));
  return withDistance(allLines.filter((line) => line.trim().length > 0).slice(-region.bottom_non_empty_lines));
}

function withDistance(lines: string[]): RegionLine[] {
  return lines.map((text, index) => ({ text, distanceFromBottom: lines.length - 1 - index })).reverse();
}

function promptBoxBody(runtime: AttentionManifestScope, lines: string[]): string[] {
  // Neutral declares no runtime, so it has no composer region to bound: no prompt-box rule applies.
  const composer = runtime === "neutral" ? undefined : runtimeProfile(runtime)?.composer;
  if (!composer) return [];
  const first = Math.max(0, lines.length - composer.tailLines);
  if (composer.frameLine) {
    const frames: number[] = [];
    for (let i = first; i < lines.length; i++) if (composer.frameLine.test(lines[i].replace(ANSI_RE, ""))) frames.push(i);
    if (frames.length < 2) return [];
    return lines.slice(frames.at(-2)! + 1, frames.at(-1)!);
  }
  if (composer.promptLine) {
    for (let i = lines.length - 1; i >= first; i--) {
      if (composer.promptLine.test(lines[i].replace(ANSI_RE, ""))) return lines.slice(i);
    }
  }
  return [];
}

function kindForState(state: ManifestAttentionState): ManifestMatchKind {
  return state === "throttled" ? "error" : "prompt";
}
