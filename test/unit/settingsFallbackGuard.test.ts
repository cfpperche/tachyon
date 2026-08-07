import fs from "node:fs";
import { describe, expect, it } from "vitest";
// The guard is ONE implementation: the script `npm run check:settings-fallbacks` runs directly,
// imported here rather than restated. Two hand-maintained copies of a rule is how they come to
// disagree. Plain ESM with no declaration surface — same convention as sourceIsDiffable importing
// check-source-diffable.mjs.
// @ts-expect-error -- see above
import { auditSettingsFallbacks, LOAD_CONFIG, SAFE_SIDE, parserSettingsUse, settingsTypeLeaves } from "../../scripts/check-settings-fallbacks.mjs";

const loadConfigText = fs.readFileSync(LOAD_CONFIG, "utf8");
const safeSideText = fs.readFileSync(SAFE_SIDE, "utf8");

const audit = (overrides: { loadConfigText?: string; safeSideText?: string } = {}): string[] =>
  auditSettingsFallbacks({ loadConfigText, safeSideText, ...overrides });

describe("every settings key declares which way it falls when discarded", () => {
  it("is complete as shipped", () => {
    expect(audit()).toEqual([]);
  });

  it("goes red when a new settings key arrives undeclared", () => {
    // The whole point: `settings.companion.allowedHosts` and `settings.agentPermissionProjection`
    // were both added to a loader whose fail-closed return made this question invisible.
    const problems = audit({
      loadConfigText: loadConfigText.replace("    maxAgents?: number;", "    maxAgents?: number;\n    allowAnything?: boolean;"),
    });
    expect(problems.some((problem) => problem.includes("settings.allowAnything has no row"))).toBe(true);
  });

  it("goes red for a new key nested inside an existing block", () => {
    const problems = audit({
      loadConfigText: loadConfigText.replace("companion?: { tabTools?: boolean;", "companion?: { extraHosts?: string[]; tabTools?: boolean;"),
    });
    expect(problems.some((problem) => problem.includes("settings.companion.extraHosts has no row"))).toBe(true);
  });

  it("goes red for a key the parser reads but the table never declared", () => {
    const problems = audit({
      loadConfigText: loadConfigText.replace(
        "if (raw.settings.clipboard !== undefined)",
        "if (raw.settings.backdoor !== undefined || raw.settings.clipboard !== undefined)",
      ),
    });
    expect(problems.some((problem) => problem.includes("raw.settings.backdoor"))).toBe(true);
  });

  it("goes red for an 'opens' key with no closure and no accepted risk", () => {
    const problems = audit({
      safeSideText: safeSideText.replace(
        '    path: "clipboard",\n    kind: "stored",\n    direction: "same",',
        '    path: "clipboard",\n    kind: "stored",\n    direction: "opens",',
      ),
    });
    expect(problems.some((problem) => problem.includes("settingsSafeSide.clipboard: declared 'opens'"))).toBe(true);
  });

  it("goes red when a closure's door stops being recorded as warned", () => {
    // A closure whose domain is never tracked can never fire — the silent way this mechanism dies.
    const problems = audit({
      loadConfigText: loadConfigText.replace('markSettingsWarned("companion", companionAt);', ""),
    });
    expect(problems.some((problem) => problem.includes("closure 'companion': loadConfig never records"))).toBe(true);
  });

  it("reads nodes, not text — a key named only in a comment is not a key", () => {
    // t-48dd8d chose an AST guard because a regex one has twice broken main here by matching an
    // identifier inside a comment, and `loadConfig.ts` is close to half comment.
    const problems = audit({
      loadConfigText: loadConfigText.replace(
        "export interface TachyonConfig {",
        "// settings.phantomKey / raw.settings.phantomKey are only mentioned in this sentence\nexport interface TachyonConfig {",
      ),
    });
    expect(problems).toEqual([]);
  });
});

describe("the guard reads what it claims to read", () => {
  it("walks into inline blocks and stops at named types", () => {
    const leaves = settingsTypeLeaves(loadConfigText);
    // Inline object literal → walked into.
    expect(leaves).toContain("companion.allowedHosts");
    expect(leaves).toContain("worktree.shareDependencies");
    // Named type (`Record<…>`) → the door is the key itself, its shape is another module's business.
    expect(leaves).toContain("agentPermissionProjection");
    expect(leaves).not.toContain("agentPermissionProjection.builder");
  });

  it("finds the doors the parser records as warned", () => {
    const { tracked, reads } = parserSettingsUse(loadConfigText);
    expect([...tracked].sort()).toEqual(["agentPermissionProjection", "companion", "legacyBridgeAuth", "worktree"]);
    expect(reads.has("companion")).toBe(true);
  });
});
