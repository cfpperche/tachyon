import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import {
  PROJECT_GUIDANCE_END,
  PROJECT_GUIDANCE_START,
  loadAndRenderProjectGuidance,
} from "../../src/config/projectGuidance.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { buildStarterYaml, type DetectedProject } from "../../src/init/initLogic.js";
import { PRIMER_OPEN } from "../../src/bridge/primer.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";

const PI_001 = Object.freeze({
  id: "PI-001",
  promise: "Project guidance is opt-in, source-labelled, and absent from an unconfigured consumer's Tachyon primer.",
} as const);

const TACHYON_PROJECT_GUIDANCE = [
  "docs/project-guidance.md",
  "docs/architecture/product-invariant-testing.md",
] as const;

function expectedRenderedGuidance(root: string, files: readonly string[]): string {
  let rendered = `${PROJECT_GUIDANCE_START}\n`;
  for (const source of files) {
    const content = fs.readFileSync(path.join(root, ...source.split("/")), "utf8");
    rendered += `Source: ${source}\n${content}`;
    if (!content.endsWith("\n")) rendered += "\n";
  }
  return `${rendered}${PROJECT_GUIDANCE_END}`;
}

async function spawnedCommand(root: string, yaml: string, name = "consumer"): Promise<string> {
  const parsed = parseConfig(yaml);
  if (!parsed.config) throw new Error(parsed.errors.join("; "));
  const sessions = new Set<string>();
  let command: string | undefined;
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1] as string);
      command = args.at(-1);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      if (!target || !sessions.has(target)) throw new Error("no session");
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "list-sessions") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: `${[...sessions].join("\n")}\n`, stderr: "" };
    }
    if (args[2] === "list-panes") {
      return { stdout: [...sessions].map((session) => `${session}\t0\t`).join("\n"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const manager = new AgentManager({
    tmux: new TmuxService(exec),
    wsHash: workspaceHash(root),
    workspaceRoot: root,
    getConfig: () => parsed.config,
    getMaxAgents: () => 2,
  });
  await manager.spawn(name);
  if (!command) throw new Error("spawn did not produce a tmux command");
  return command;
}

const INIT_FIXTURES: DetectedProject[] = [
  {
    files: ["package.json"],
    packageJson: { scripts: { dev: "vite", test: "vitest" }, devDependencies: { vite: "latest" } },
    installedClis: ["claude"],
  },
  { files: ["Cargo.toml"], installedClis: ["codex"] },
];

describe(`${PI_001.id}: project-guidance ownership boundary`, () => {
  beforeEach(() => {
    // The Product Invariant runner requires this guard so a conditional early return cannot become a pass.
    expect.hasAssertions();
  });

  it(PI_001.promise, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-001-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.writeFileSync(path.join(root, "docs", "first.md"), "FIRST PROJECT RULE\n", "utf8");
      fs.writeFileSync(path.join(root, "docs", "second.md"), "SECOND PROJECT RULE", "utf8");
      fs.writeFileSync(path.join(root, "docs", "not-listed.md"), "UNLISTED PROJECT RULE\n", "utf8");

      const expectedGuidance =
        `${PROJECT_GUIDANCE_START}\n` +
          "Source: docs/first.md\n" +
          "FIRST PROJECT RULE\n" +
          "Source: docs/second.md\n" +
          "SECOND PROJECT RULE\n" +
          PROJECT_GUIDANCE_END;
      expect(loadAndRenderProjectGuidance(root, undefined)).toBeUndefined();
      expect(loadAndRenderProjectGuidance(root, { files: ["docs/first.md", "docs/second.md"] })).toBe(expectedGuidance);

      const configuredCommand = await spawnedCommand(
        root,
        "agents:\n  consumer:\n    cmd: claude\nsettings:\n  projectGuidance:\n    files: [docs/first.md, docs/second.md]\n",
      );
      expect(configuredCommand).toContain(expectedGuidance);
      expect(configuredCommand.indexOf("FIRST PROJECT RULE")).toBeLessThan(configuredCommand.indexOf("SECOND PROJECT RULE"));
      for (const expectedOnce of [
        PROJECT_GUIDANCE_START,
        PROJECT_GUIDANCE_END,
        "Source: docs/first.md\n",
        "Source: docs/second.md\n",
        "FIRST PROJECT RULE",
        "SECOND PROJECT RULE",
      ]) {
        expect(configuredCommand.split(expectedOnce)).toHaveLength(2);
      }
      expect(configuredCommand).not.toContain("docs/not-listed.md");
      expect(configuredCommand).not.toContain("UNLISTED PROJECT RULE");

      const unconfiguredCommand = await spawnedCommand(root, "agents:\n  consumer:\n    cmd: claude\n");
      expect(unconfiguredCommand).toContain(PRIMER_OPEN);
      for (const forbidden of [
        PROJECT_GUIDANCE_START,
        "FIRST PROJECT RULE",
        "SECOND PROJECT RULE",
        "UNLISTED PROJECT RULE",
        "docs/project-guidance.md",
        "product-invariant-testing",
        "Product Invariant",
        "Affected Product Invariants",
        "PI-",
        "test:invariants",
      ]) {
        expect(unconfiguredCommand).not.toContain(forbidden);
        for (const fixture of INIT_FIXTURES) expect(buildStarterYaml(fixture)).not.toContain(forbidden);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("PI-001: Tachyon's real repository opts into both owned documents with exact source provenance", () => {
    const repoRoot = process.cwd();
    const parsed = parseYaml(fs.readFileSync(path.join(repoRoot, "tachyon.yml"), "utf8")) as {
      settings?: { projectGuidance?: { files?: unknown } };
    };
    const configuredFiles = parsed.settings?.projectGuidance?.files;
    expect(configuredFiles).toEqual(TACHYON_PROJECT_GUIDANCE);
    const rendered = loadAndRenderProjectGuidance(repoRoot, { files: [...TACHYON_PROJECT_GUIDANCE] });
    expect(rendered).toBe(expectedRenderedGuidance(repoRoot, TACHYON_PROJECT_GUIDANCE));

    for (const source of TACHYON_PROJECT_GUIDANCE) {
      expect(rendered?.split(`Source: ${source}\n`)).toHaveLength(2);
    }
  });
});
