import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * t-a5bd6b — the absence guard for the retired canonical / ad-hoc / declared species.
 *
 * Agent Instance has two lifetimes, Saved and Temporary, and lifetime is DECLARED data. The species
 * that used to be inferred from which store held the definition are gone, and this test is what keeps
 * them gone: a cut symbol must not come back by copy-paste, by a revert, or by an agent reading an old
 * spec and reintroducing the name because it looked authoritative.
 *
 * SCOPE: live code — `src/` and `test/`. Historical specs are the other lane; they record decisions
 * that were true when they were written and are MARKED historical, never rewritten, which is step 7 of
 * the cut. This guard is not that step and does not scan prose.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO, both measured on the tree that introduced it:
 *
 * 1. It does not match the WORDS `canonical`, `adhoc` or `declared`. Those tokens have live, correct,
 *    unrelated meanings, and a word-level guard would order them renamed:
 *      - `HandoffDistillMode = "existing" | "adhoc"` (`src/handoff/distill.ts`, and the union
 *        discriminant in `src/runtime-api/handoffCommands.ts`) is the handoff distill TARGET — distill
 *        into a new unnamed target versus an existing agent. It is not an agent species.
 *      - `mode: "canonical" | "legacy"` (`src/config/agentProfileResolver.ts`) is the config RESOLUTION
 *        axis — a profile document versus a `tachyon.yml` entry. Also not a species.
 *      - `requesterTrust: "self-declared"` is the provenance of a claim.
 *    So every entry below is a named symbol, or a literal in the ROLE the species occupied. The removal
 *    plan's inventory counts tokens (149 canonical / 151 declared / 34 adhoc in `src`) to measure reach;
 *    those counts are not a work list, and reading them as one is how this guard would have become a
 *    wrecking ball through three unrelated features.
 *
 * 2. It does not delete its own evidence. A test that proves a retired literal is REFUSED has to name
 *    that literal. Such a line carries an inline `legacy-absence-exempt:` marker with its reason, at
 *    the usage site — deliberately NOT a file-level allowlist, because a path entry silently licenses
 *    every future occurrence in that file, and this exception has to stay as narrow as the one line
 *    that earns it.
 */

const repoRoot = path.resolve(__dirname, "../..");

/** The marker that exempts ONE line, and only with a stated reason after the colon. */
const EXEMPT_MARKER = /legacy-absence-exempt:\s*(\S.*)$/;

interface RetiredSymbol {
  /** What to look for: a named symbol, or a literal in the role the species used to occupy. */
  readonly pattern: RegExp;
  /** How it is referred to in the plan and in review. */
  readonly name: string;
  /** The task that cut it, so a reader can find what replaced it instead of guessing. */
  readonly cutBy: string;
  /** What answers this question now. */
  readonly replacedBy: string;
}

/**
 * Symbols already cut. Each later step of the removal appends its own entry in the SAME change that
 * removes it — that is why this is data rather than a pile of assertions.
 *
 * NOT yet listed, because they are still live and correct on this tree: `AdhocAgent` / `.adhoc`
 * (t-eb4b30 collapses the second instance store, 41 occurrences in `src`) and `adhocAdmission`
 * (t-7ff13d collapses admission, 5). Listing a symbol before its step lands would fail the build for
 * code that has no replacement yet, which is the guard front-running the plan.
 */
const RETIRED: readonly RetiredSymbol[] = [
  {
    pattern: /\bdeclaredParent\b/,
    name: "declaredParent",
    cutBy: "t-d542ac",
    replacedBy: "lineage is durable for both lifetimes; there is no parent to strip",
  },
  {
    pattern: /\bstripDeclaredParent\b/,
    name: "stripDeclaredParent",
    cutBy: "t-d542ac",
    replacedBy: "lineage is lifetime-agnostic — nothing rewrites the parent on read",
  },
  {
    pattern: /\badhocDefinition\b/,
    name: "adhocDefinition",
    cutBy: "t-04052d",
    replacedBy: "one instance definition, with lifetime as declared data",
  },
  {
    pattern: /\badhocStore\b/,
    name: "adhocStore",
    cutBy: "t-04052d",
    replacedBy: "one instance store; storage is not a species",
  },
  {
    pattern: /z\.literal\("canonical"\)/,
    name: 'z.literal("canonical")',
    cutBy: "t-04052d",
    replacedBy: 'z.literal("agent-instance") — the single contract kind',
  },
  {
    pattern: /kind:\s*"canonical"/,
    name: 'kind: "canonical"',
    cutBy: "t-04052d",
    replacedBy: 'kind: "agent-instance"',
  },
  {
    pattern: /kind:\s*"adhoc"/,
    name: 'kind: "adhoc"',
    cutBy: "t-04052d",
    replacedBy: 'kind: "agent-instance" plus a declared lifetime',
  },
  {
    pattern: /storage\s*===\s*"canonical"/,
    name: 'storage === "canonical"',
    cutBy: "t-04052d",
    replacedBy: "the declared lifetime — never a branch on where the definition is kept",
  },
];

/**
 * This file names every retired symbol by definition — it is the registry, so it excludes itself by
 * path. That is not an exemption mechanism and shares nothing with `EXEMPT_MARKER`: keeping them
 * separate means no future occurrence can hide behind "the registry mentions it too".
 */
const GUARD_SOURCE = "test/unit/agentInstanceLegacyAbsence.test.ts";

function sourceFiles(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.(ts|tsx)$/.test(entry.name) ? [child] : [];
  });
}

/** Every live occurrence of a retired symbol, as `path:line: name`, minus exempted lines. */
function offenders(overrides: Record<string, string> = {}): string[] {
  const found: string[] = [];
  for (const rel of [...sourceFiles("src"), ...sourceFiles("test")]) {
    if (rel === GUARD_SOURCE) continue;
    const lines = (overrides[rel] ?? fs.readFileSync(path.join(repoRoot, rel), "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const symbol of RETIRED) {
        if (!symbol.pattern.test(line)) continue;
        // The marker may sit on the line itself or on the line directly above, so a long assertion does
        // not have to be reflowed to be exempted. Anything further away stops being visible at the
        // usage site, which is the whole reason this is not a file-level allowlist.
        const marked = EXEMPT_MARKER.test(line) || (index > 0 && EXEMPT_MARKER.test(lines[index - 1]!));
        if (!marked) found.push(`${rel}:${index + 1}: ${symbol.name}`);
      }
    });
  }
  return found.sort();
}

/** Every exemption actually claimed in the tree, with the reason each one gives. */
function exemptions(): Array<{ at: string; reason: string }> {
  const claimed: Array<{ at: string; reason: string }> = [];
  for (const rel of [...sourceFiles("src"), ...sourceFiles("test")]) {
    if (rel === GUARD_SOURCE) continue;
    fs.readFileSync(path.join(repoRoot, rel), "utf8").split("\n").forEach((line, index) => {
      const match = EXEMPT_MARKER.exec(line);
      if (match) claimed.push({ at: `${rel}:${index + 1}`, reason: match[1]!.trim() });
    });
  }
  return claimed;
}

describe("t-a5bd6b — the retired species cannot come back into live code", () => {
  it("finds no retired canonical/ad-hoc/declared symbol under src or test", () => {
    expect(offenders()).toEqual([]);
  });

  it("actually fails when a retired symbol returns, in src and in test alike", () => {
    // Without this the guard could be silently inert — a regex typo, a walk that returns nothing, and a
    // green suite that proves the absence of the SCAN rather than the absence of the symbol.
    expect(offenders({ "src/agents/AgentManager.ts": 'const x = { kind: "adhoc" };' }))
      .toEqual(['src/agents/AgentManager.ts:1: kind: "adhoc"']);
    expect(offenders({ "test/unit/agentStudioAdapter.test.ts": "stripDeclaredParent(snapshot)" }))
      .toEqual(["test/unit/agentStudioAdapter.test.ts:1: stripDeclaredParent"]);
  });

  it("exempts a marked line, and only when the marker states a reason", () => {
    const withReason = 'kind: "canonical" // legacy-absence-exempt: asserts the literal is refused';
    expect(offenders({ "src/agents/AgentManager.ts": withReason })).toEqual([]);
    // A bare marker buys nothing: an exemption with no reason is the padding this design exists to stop.
    expect(offenders({ "src/agents/AgentManager.ts": 'kind: "canonical" // legacy-absence-exempt:' }))
      .toEqual(['src/agents/AgentManager.ts:1: kind: "canonical"']);
    // On the line above is also honored, so a long assertion need not be reflowed to be exempted.
    expect(offenders({
      "src/agents/AgentManager.ts": '// legacy-absence-exempt: proves refusal\nkind: "canonical"',
    })).toEqual([]);
    // Two lines above is NOT: past that the reason stops being visible where the symbol is used.
    expect(offenders({
      "src/agents/AgentManager.ts": '// legacy-absence-exempt: proves refusal\nconst gap = 1;\nkind: "canonical"',
    })).toEqual(['src/agents/AgentManager.ts:3: kind: "canonical"']);
  });

  it("keeps every exemption in the tree narrow and reasoned", () => {
    const claimed = exemptions();
    // The refusal tests are the only thing this may ever be used for. If the count grows, the reasons
    // are what a reviewer reads, so they are asserted to exist rather than assumed.
    for (const entry of claimed) {
      expect(entry.reason.length, entry.at).toBeGreaterThan(20);
      expect(entry.reason, entry.at).toMatch(/refus|reject|retired|historical/i);
    }
    // Exercised, not theoretical: the mechanism is proven by a real usage, not only by the fixtures above.
    expect(claimed.length).toBeGreaterThan(0);
  });

  it("excludes only its own registry, and by path rather than by exemption", () => {
    expect(fs.existsSync(path.join(repoRoot, GUARD_SOURCE))).toBe(true);
    expect(EXEMPT_MARKER.test(GUARD_SOURCE)).toBe(false);
  });

  it("scans a real, non-empty tree in both roots", () => {
    // The failure this catches is a guard that passes because it looked at nothing.
    expect(sourceFiles("src").length).toBeGreaterThan(100);
    expect(sourceFiles("test").length).toBeGreaterThan(100);
    expect(sourceFiles("src")).toContain("src/agents/AgentManager.ts");
  });

  it("states what replaced each retired symbol, so a reader is not left guessing", () => {
    for (const symbol of RETIRED) {
      expect(symbol.cutBy, symbol.name).toMatch(/^t-[0-9a-f]{6}$/);
      expect(symbol.replacedBy.length, symbol.name).toBeGreaterThan(20);
    }
    // The species WORDS are not patterns here — see the header. If someone "strengthens" this guard
    // into a word scan, these live and unrelated uses are exactly what breaks.
    for (const symbol of RETIRED) {
      expect(symbol.pattern.test('mode: "canonical" | "legacy"'), symbol.name).toBe(false);
      expect(symbol.pattern.test('HandoffDistillMode = "existing" | "adhoc"'), symbol.name).toBe(false);
      expect(symbol.pattern.test('requesterTrust: "self-declared"'), symbol.name).toBe(false);
    }
  });
});
