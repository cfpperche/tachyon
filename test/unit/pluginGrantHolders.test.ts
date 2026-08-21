import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginGrantHolders } from "@tachyon/engine/config/pluginGrantHolders.js";

/**
 * t-b1940c — who holds a grant on a plugin, read from the roster the delivery itself reads.
 *
 * The revoke-on-remove flow needs to name the agents that lose what BEFORE it can say so. This is
 * the enumeration half: members of `.tachyon/agents/` whose profile carries a skill reference owned
 * by `plugin:<name>`. Everything that is not a readable member is invisible to it, on purpose — the
 * roster scanner already owns that rule and reports residue its own way.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-grant-holders-"));
  dirs.push(dir);
  return dir;
}

function writeProfile(root: string, agent: string, yaml: string): void {
  const home = path.join(root, ".tachyon", "agents", agent);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "agent.yml"), yaml);
}

function profileYaml(references: string): string {
  return [
    "schemaVersion: 1",
    'agentId: "00000000-0000-4000-8000-000000000001"',
    "runtime:",
    "  adapter: claude",
    "  executable: claude",
    `references:${references ? `\n${references}` : ""}`,
  ].join("\n") + "\n";
}

function skillReference(id: string, owner: string): string {
  return [
    `  - id: ${id}`,
    "    kind: skill",
    "    scope: project",
    `    owner: ${owner}`,
    `    path: .tachyon/plugins/${id}/skills/${id}`,
    "    mode: pinned",
    `    sha256: ${"a".repeat(64)}`,
    "    version: 1.0.0",
  ].join("\n");
}

describe("t-b1940c — pluginGrantHolders enumerates the profiles a plugin removal would touch", () => {
  it("finds skill references owned by plugin:<name> and nothing else", () => {
    const root = workspace();
    writeProfile(root, "alpha", profileYaml([
      skillReference("sdd", "plugin:sdd"),
      skillReference("other", "plugin:other"),
    ].join("\n")));
    // a member whose only reference belongs to ANOTHER plugin
    writeProfile(root, "beta", profileYaml(skillReference("other", "plugin:other")));

    expect(pluginGrantHolders(root, "sdd")).toEqual([{ agent: "alpha", referenceId: "sdd" }]);
  });

  it("returns every holder across the roster, sorted by the roster's own order", () => {
    const root = workspace();
    writeProfile(root, "alpha", profileYaml(skillReference("sdd", "plugin:sdd")));
    writeProfile(root, "beta", profileYaml(skillReference("sdd", "plugin:sdd")));

    expect(pluginGrantHolders(root, "sdd")).toEqual([
      { agent: "alpha", referenceId: "sdd" },
      { agent: "beta", referenceId: "sdd" },
    ]);
  });

  it("ignores non-members and unreadable profiles instead of failing the enumeration", () => {
    const root = workspace();
    writeProfile(root, "alpha", profileYaml(skillReference("sdd", "plugin:sdd")));
    // residue: a directory without an agent.yml
    fs.mkdirSync(path.join(root, ".tachyon", "agents", "orphan-home"), { recursive: true });
    // a member whose bytes cannot be parsed
    writeProfile(root, "broken", "schemaVersion: 1\nruntime: [not, a, mapping]\n");

    expect(pluginGrantHolders(root, "sdd")).toEqual([{ agent: "alpha", referenceId: "sdd" }]);
  });

  it("answers an empty roster with no holders", () => {
    const root = workspace();
    expect(pluginGrantHolders(root, "sdd")).toEqual([]);
  });
});
