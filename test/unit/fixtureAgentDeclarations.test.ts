import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * SDD 478 M8 — "a synthetic process may never be declared as an Agent" stops depending on a reviewer
 * remembering it.
 *
 * t-9418ac is the evidence that review does not remember: three `cmd: sh` entries sat under `agents:`
 * in `sample-workspace` until they broke the whole config — commands, runbooks and schedules with it —
 * and cost three increments of investigation to trace back. The rule was ratified; nothing enforced it.
 *
 * The value here is not the sweep, it is WHEN it fails. A fixture written next month fails in the
 * commit that introduces it, naming the file, the entry and the fix — instead of weeks later, inside
 * an editor-host gate whose message never mentions fixtures.
 *
 * Two properties, because either alone would rot:
 *
 *  1. **The guard catches a violation.** A sweep that reports nothing is indistinguishable from a
 *     sweep that cannot see, so the detector is run against a fixture tree built to be wrong.
 *  2. **No fixture in the tree violates it.**
 *
 * SCOPE, deliberately: fixture FILES (`test/fixtures/**​/tachyon.yml`). Inline YAML inside test
 * sources is not swept, because a large share of it is negative cases — suites that assert the
 * loader's refusal must be free to write the refused shape.
 */

const FIXTURES_ROOT = path.resolve(__dirname, "..", "fixtures");

interface InlineAgent {
  /** path relative to test/fixtures, so a failure message is copy-pasteable */
  file: string;
  agent: string;
  reason: string;
}

/**
 * Post-M6 an `agents:` entry is a POINTER to a canonical profile — `profile: .tachyon/agents/<n>/agent.yml`.
 * A `cmd:` there is the retired inline shape, whatever the binary: `sh` is a process and can never be an
 * agent, and `claude` inline skips the profile and the host-custodied authority that attests it.
 */
function inlineAgentDeclarations(yamlText: string, file: string): InlineAgent[] {
  let document: unknown;
  try {
    document = parse(yamlText);
  } catch (error) {
    // A fixture nobody can parse is not a fixture that passes: the rule cannot be proven against it.
    return [{ file, agent: "(whole file)", reason: `is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const agents = (document as { agents?: unknown } | null)?.agents;
  if (agents === undefined || agents === null) return [];
  if (typeof agents !== "object" || Array.isArray(agents)) {
    return [{ file, agent: "(whole file)", reason: "declares 'agents:' as something other than a mapping" }];
  }
  return Object.entries(agents as Record<string, unknown>).flatMap(([agent, entry]) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return [{ file, agent, reason: "is not a mapping, so it cannot be a profile pointer" }];
    }
    const fields = entry as Record<string, unknown>;
    if (typeof fields.cmd === "string") {
      return [{ file, agent, reason: `declares 'cmd: ${fields.cmd}' inline instead of pointing at a canonical profile` }];
    }
    if (typeof fields.profile !== "string") {
      return [{ file, agent, reason: "has no 'profile:' pointer" }];
    }
    return [];
  });
}

/** Every `tachyon.yml` under `root`, deepest included, as paths relative to `root`. */
function fixtureConfigs(root: string, prefix = ""): string[] {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) return fixtureConfigs(root, relative);
    return entry.isFile() && entry.name === "tachyon.yml" ? [relative] : [];
  });
}

function sweep(root: string): InlineAgent[] {
  return fixtureConfigs(root).flatMap((file) =>
    inlineAgentDeclarations(fs.readFileSync(path.join(root, file), "utf8"), file));
}

describe("SDD 478 M8 — the fixture guard is worth trusting", () => {
  it("reports a process declared as an agent, which is the shape that caused t-9418ac", () => {
    const root = makeTempDir("tachyon-fixture-guard-");
    fs.mkdirSync(path.join(root, "nested", "workspace"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "nested", "workspace", "tachyon.yml"),
      "agents:\n  boss:\n    cmd: sh\n    kind: agent\n",
      "utf8",
    );

    expect(sweep(root)).toEqual([{
      file: path.join("nested", "workspace", "tachyon.yml"),
      agent: "boss",
      reason: "declares 'cmd: sh' inline instead of pointing at a canonical profile",
    }]);
  });

  it("reports an attested runtime declared inline too — the banned thing is the shape, not the binary", () => {
    const root = makeTempDir("tachyon-fixture-guard-");
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  reviewer:\n    cmd: claude\n", "utf8");

    expect(sweep(root)).toEqual([{
      file: "tachyon.yml",
      agent: "reviewer",
      reason: "declares 'cmd: claude' inline instead of pointing at a canonical profile",
    }]);
  });

  it("accepts a canonical pointer, an empty roster, and any terminal — a process declared as one is correct", () => {
    const root = makeTempDir("tachyon-fixture-guard-");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  reviewer:\n    profile: .tachyon/agents/reviewer/agent.yml\nterminals:\n  dev:\n    cmd: sh\n",
      "utf8",
    );
    fs.mkdirSync(path.join(root, "empty"));
    fs.writeFileSync(path.join(root, "empty", "tachyon.yml"), "agents: {}\nterminals:\n  dev:\n    cmd: npm run dev\n", "utf8");

    expect(sweep(root)).toEqual([]);
  });

  it("does not let an unreadable or malformed roster pass silently", () => {
    const root = makeTempDir("tachyon-fixture-guard-");
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  - not\n  - a mapping\n", "utf8");

    expect(sweep(root)).toEqual([{
      file: "tachyon.yml",
      agent: "(whole file)",
      reason: "declares 'agents:' as something other than a mapping",
    }]);
  });
});

describe("SDD 478 M8 — no product fixture declares an agent inline", () => {
  it("every test/fixtures/**/tachyon.yml declares agents only as canonical profile pointers", () => {
    const violations = sweep(FIXTURES_ROOT);

    expect(
      violations.map((v) => `test/fixtures/${v.file} — '${v.agent}' ${v.reason}`),
      "An Agent is a runtime Tachyon attests, declared as a pointer to .tachyon/agents/<name>/agent.yml. "
      + "A process is a Terminal: move the entry under 'terminals:'. A fixture cannot ship the "
      + "host-custodied authority a real agent needs, so agents are created in Agent Studio at dogfood time.",
    ).toEqual([]);
  });

  it("sweeps every fixture roster in the tree, so a new directory is covered by default", () => {
    // Guards the guard: if the walk ever stopped descending, the assertion above would pass by
    // finding nothing at all. The count is deliberately a floor, not an equality — adding a fixture
    // must not require editing this test.
    const swept = fixtureConfigs(FIXTURES_ROOT);
    expect(swept.length).toBeGreaterThanOrEqual(16);
    expect(swept).toContain(path.join("multiroot", "alpha", "tachyon.yml"));
    expect(swept).toContain(path.join("sample-workspace", "tachyon.yml"));
  });
});
