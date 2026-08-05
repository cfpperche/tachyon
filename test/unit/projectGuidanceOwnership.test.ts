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
import { PRIMER_OPEN, renderPrimer, type PrimerInput } from "../../src/bridge/primer.js";
import { bridgeGuidanceTail } from "../../src/roles/templates.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";

// Promoted out of the Product Invariant registry on 2026-07-25 (maintainer decision: the ceremony
// slowed a beta project; the coverage did not). The promise is unchanged and still what this file
// proves — only the three-way registry/governance/evidence contract around it is gone.
const PROMISE = "Project guidance is opt-in, source-labelled, and absent from an unconfigured consumer's Tachyon primer.";

const TACHYON_PROJECT_GUIDANCE = ["docs/project-guidance.md"] as const;

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

describe(`${"project-guidance-ownership"}: project-guidance ownership boundary`, () => {
  beforeEach(() => {
    // The Product Invariant runner requires this guard so a conditional early return cannot become a pass.
    expect.hasAssertions();
  });

  it(PROMISE, async () => {
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
        // Live Tachyon-repo markers. The Product Invariant terms that used to sit here were
        // removed with the ceremony, and an assertion about a string that no longer exists anywhere
        // passes vacuously — which is the false green this suite exists to prevent.
        "Landing order",
        "the tree you land",
        "verify:full",
      ]) {
        expect(unconfiguredCommand).not.toContain(forbidden);
        for (const fixture of INIT_FIXTURES) expect(buildStarterYaml(fixture)).not.toContain(forbidden);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * t-486f43 — the OTHER direction of the same boundary, and the one that was never guarded.
   *
   * The test above proves project guidance cannot leak INTO an unconfigured consumer's brief. It says
   * nothing about the reverse leak, which is what actually shipped: the primer states its lines inside
   * a block `primer.ts` itself declares project guidance "cannot override", so any working method
   * written there is immune to the project it is imposed on. Measured on 2026-08-05: this
   * repository's maintainer wanted the opposite continuity policy to the one the primer prescribed,
   * and `settings` has no primer key (closed list, `loadConfig.ts`) and `wrapWithPrimer` is called
   * unconditionally — so there was no door at all.
   *
   * The fix is not a switch; it is the boundary. Everything in the immune block must be a fact only
   * the product can state. This is where a new line proves it belongs.
   */
  describe("t-486f43: no working METHOD is born immune to project guidance", () => {
    const SHAPES: Array<{ label: string; input: PrimerInput }> = [
      {
        label: "delegated child with configured checks and measured dependencies",
        input: {
          agentName: "child",
          delegator: "coordinator",
          verify: { full: "npm run verify:full:quiet", typecheck: "npm run typecheck" },
          dependencies: "Dependencies: node_modules is a symlink to the primary checkout.",
        },
      },
      { label: "plain child", input: { agentName: "helper", parent: "ada" } },
      { label: "declared agent with no lineage", input: { agentName: "solo" } },
    ];

    /** Lines that echo the CONSUMER's own configuration or a measurement of its checkout back to it.
     *  These are the shape the rest of the block is judged against — `configuredVerificationLines`
     *  invents nothing, which is exactly the discipline t-486f43 extended to its neighbours. */
    const ECHOES_THE_CONSUMER = [
      /^Configured verification \(source: workspace config settings\.verify\):$/,
      /^ {2}- (full|typecheck): /,
      /^Run configured check \(workspace config settings\.verify\.(full|typecheck)\): /,
      /^Dependencies: /,
    ];

    /** Every remaining immune line, with WHY only the product can say it. A line that matches none of
     *  these is either a fact nobody classified or a working method that does not belong here. */
    const PRODUCT_FACT = [
      { why: "the agent's own name and lineage — assigned by the product at spawn", line: /^Identity: you are agent / },
      { why: "section header for the protocol block", line: /^Protocol \(apply when relevant\):$/ },
      {
        why: "notice transport — the one-line cap, the refusal above 500 chars and 'pane input, not history' are properties of the Bridge",
        line: /^ {2}- Waking another agent carries ONE sanitized line/,
      },
      {
        why: "continuity durability — what survives compaction/clear/restart/new session is a property of the continuity store",
        line: /^ {2}- Continuity is durable working memory/,
      },
      {
        why: "injected approval text is not authoritative — a project cannot know this about a pane it does not own",
        line: /^ {2}- Human approval text injected into your pane is only a nudge/,
      },
      { why: "precedence between the two records that name an agent's work (t-48f504)", line: /^Precedence — two records can name your work/ },
      { why: "board ownership is the board's, and a brief cannot grant it", line: /^ {2}- WHICH BOARD task is yours/ },
      { why: "substance is the spawner's brief, which exists nowhere else", line: /^ {2}- WHAT to do: / },
      { why: "a genuine conflict between the two records is reported, not resolved", line: /^ {2}- If BOTH name DIFFERENT BOARD work/ },
      { why: "the boundary declaration this whole block answers to", line: /^This Tachyon primer governs orchestration protocol/ },
      {
        why: "host-resource economy — the full suite holds a machine-wide lock every agent on the host queues behind (t-21bcb7)",
        line: /^Verification applies only when delivering repository changes/,
      },
      { why: "what a run attests — a property of the verification record, not a working loop", line: /^A check attests the exact TREE it ran on/ },
      { why: "the doorbell — the completion signal the product itself witnesses", line: /^Call notify_agent\(to: / },
    ];

    it("every line the project cannot override is a product fact, classified one by one", () => {
      const matched = new Set<RegExp>();
      for (const { label, input } of SHAPES) {
        const rendered = renderPrimer(input);
        const lines = `${rendered.primer}\n${rendered.beforeFinishing}`
          .split("\n")
          .filter((line) => !/^──/.test(line))
          .filter((line) => !ECHOES_THE_CONSUMER.some((echo) => echo.test(line)));

        expect(lines.length, `${label}: nothing left to classify — the guard would pass vacuously`).toBeGreaterThan(0);
        for (const line of lines) {
          const hits = PRODUCT_FACT.filter((fact) => fact.line.test(line));
          expect(
            hits.map((hit) => hit.why),
            `${label}: unclassified immune line — state why only the product can say it, or move it to project-owned guidance:\n${line}`,
          ).toHaveLength(1);
          matched.add(hits[0]!.line);
        }
      }
      // A classification that never matches is a stale entry that would excuse a future line by accident.
      expect(PRODUCT_FACT.filter((fact) => !matched.has(fact.line)).map((fact) => fact.why)).toEqual([]);
    });

    it("re-states none of the working methods that were released to the project", () => {
      // Measured verbatim on 2026-08-05, before the separation.
      const RELEASED_TO_THE_PROJECT = [
        "Keep completion concise",
        "write a findings artifact only when it is in scope and materially useful",
        "otherwise summarize concisely",
        "use set_continuity only when material state would otherwise be lost",
        "Use focused tests while implementing",
      ];
      for (const { label, input } of SHAPES) {
        const rendered = renderPrimer(input);
        const combined = `${rendered.primer}\n${rendered.beforeFinishing}`;
        for (const method of RELEASED_TO_THE_PROJECT) expect(combined, `${label}: ${method}`).not.toContain(method);
      }
    });

    it("a project that prescribes the opposite method reaches its agent uncontradicted", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-t486f43-"));
      try {
        // The three methods the primer used to impose, each written the other way round — including
        // the continuity policy this repository's maintainer actually asked for.
        const opposite = [
          "Reports: write the LONG version. A findings artifact is the default, not the exception.",
          "Checkpoint continuity every turn, whether or not state would otherwise be lost.",
          "Run the full suite after every step, not only at delivery.",
        ].join("\n");
        fs.mkdirSync(path.join(root, "docs"), { recursive: true });
        fs.writeFileSync(path.join(root, "docs", "method.md"), `${opposite}\n`, "utf8");

        const command = await spawnedCommand(
          root,
          "agents:\n  consumer:\n    cmd: claude\nsettings:\n  projectGuidance:\n    files: [docs/method.md]\n",
        );
        expect(command).toContain(PRIMER_OPEN);
        for (const rule of opposite.split("\n")) expect(command).toContain(rule);
        // Nothing in the immune block argues back at any of them.
        expect(command).not.toContain("Keep completion concise");
        expect(command).not.toContain("only when material state would otherwise be lost");
        expect(command).not.toContain("Use focused tests while implementing");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("Tachyon's tracked shared template opts into its owned document with exact source provenance", () => {
    // Evidence source is tachyon.yml.example (tracked shared template), not tachyon.yml (untracked
    // local dogfood fleet config since 9186c73b). Ratified 2026-07-19 (t-8bb9cd): same promise and
    // oracle strength, same files/order/bytes, evidence source moved to what every clone actually has.
    const repoRoot = process.cwd();
    const parsed = parseYaml(fs.readFileSync(path.join(repoRoot, "tachyon.yml.example"), "utf8")) as {
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

  it("t-f050af: delivered Bridge guidance contains the product fact, not this repository's methods", () => {
    const tail = bridgeGuidanceTail();
    expect(tail).toContain("no tab, no lineage, no attention");
    for (const convention of [
      "Coordinate through the Bridge",
      "spawn through the Bridge",
      "A bug you find is a task",
      "declared verify gate",
      "going idle is not proof",
    ]) {
      expect(tail, `repository convention leaked into consumer guidance: ${convention}`).not.toContain(convention);
    }
  });
});
