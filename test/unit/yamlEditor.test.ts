import { describe, it, expect } from "vitest";
import {
  addAgent,
  cloneAgent,
  deleteAgent,
  renameAgent,
  agentEntryLine,
  upsertAgent,
  upsertRunbook,
  deleteRunbook,
  runbookEntryLine,
  setCompanionTabTools,
} from "../../src/config/YamlConfigEditor.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import schema from "../../src/config/tachyon.schema.json";

/** A realistic file: user comments everywhere — they must survive every mutation. */
const YML = `# Tachyon config — meu projeto
agents:
  # o agente principal
  frontend:
    cmd: claude        # roda o Claude Code
    autostart: true
  dev:
    cmd: npm run dev
    watch: "package.json"   # restart quando mudar

layouts:
  pair:   # lado a lado
    grid: 2up
    agents: [frontend, dev]

settings:
  maxAgents: 6   # guardrail
`;

function expectValid(text: string) {
  const { config, errors } = parseConfig(text);
  expect(errors).toEqual([]);
  return config!;
}

describe("YamlConfigEditor", () => {
  it("addAgent appends without touching comments elsewhere", () => {
    const { text } = addAgent(YML, "backend", "claude");
    const config = expectValid(text);
    expect(config.agents.backend.cmd).toBe("claude");
    // every user comment survived
    for (const comment of ["meu projeto", "o agente principal", "roda o Claude Code", "restart quando mudar", "lado a lado", "guardrail"]) {
      expect(text).toContain(comment);
    }
  });

  it("addAgent creates a minimal file when none exists, and validates input", () => {
    const { text } = addAgent(undefined, "solo", "codex");
    expect(expectValid(text).agents.solo.cmd).toBe("codex");
    expect(() => addAgent(YML, "frontend", "x")).toThrow("already exists");
    expect(() => addAgent(YML, "1bad", "x")).toThrow("invalid agent name");
    expect(() => addAgent(YML, "ok", "  ")).toThrow("non-empty command");
  });

  it("addAgent writes kind + instructions when given (spec 211 promote)", () => {
    const cfg = expectValid(addAgent(undefined, "rev", "claude", "agent", "review PRs carefully").text);
    expect(cfg.agents.rev).toMatchObject({ cmd: "claude", instructions: "review PRs carefully" });
    // empty instructions are omitted, not written as a blank key
    const cfg2 = expectValid(addAgent(undefined, "t", "sh", "terminal", "   ").text);
    expect(cfg2.agents.t.instructions).toBeUndefined();
    expect(cfg2.agents.t.kind).toBe("terminal");
  });

  it("spec 352 — upsertAgent round-trips only the parent-side subagents field", () => {
    const base = `agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer]\n  reviewer:\n    cmd: codex\n`;
    const editedParent = upsertAgent(base, "claude", { cmd: "claude", subagents: ["reviewer"] }, "claude").text;
    const parentCfg = expectValid(editedParent);
    expect(parentCfg.agents.claude.subagents).toEqual(["reviewer"]);
    expect(parentCfg.declaredOwner).toEqual({ reviewer: "claude" });
    expect(editedParent).not.toContain("declaredOwner");

    const editedChild = upsertAgent(base, "reviewer", { cmd: "codex --model gpt-5" }, "reviewer").text;
    const childCfg = expectValid(editedChild);
    expect(childCfg.agents.claude.subagents).toEqual(["reviewer"]);
    expect(childCfg.agents.reviewer.subagents).toBeUndefined();
    expect(editedChild).not.toContain("declaredOwner");
  });

  it("round-trips agent soul and strips it from terminal entries", () => {
    const agentText = upsertAgent(undefined, "ada", { cmd: "codex", soul: true }).text;
    expect(expectValid(agentText).agents.ada.soul).toBe(true);
    expect(agentText).toContain("soul: true");

    const terminalText = upsertAgent(undefined, "shell", { cmd: "bash", kind: "terminal", soul: true }, undefined, "terminals").text;
    expect(expectValid(terminalText).agents.shell.soul).toBeUndefined();
    expect(terminalText).not.toContain("soul:");
  });

  it("declares soul as a JSON-schema boolean", () => {
    const soul = schema.properties.agents.additionalProperties.properties.soul;
    expect(soul.type).toBe("boolean");
  });

  it("cloneAgent copies the full definition under a new name", () => {
    const { text } = cloneAgent(YML, "dev", "dev-2");
    const config = expectValid(text);
    expect(config.agents["dev-2"]).toEqual(config.agents.dev);
    expect(text).toContain("o agente principal"); // comments elsewhere intact
    expect(() => cloneAgent(YML, "ghost", "x2")).toThrow("does not exist");
    expect(() => cloneAgent(YML, "dev", "frontend")).toThrow("already exists");
  });

  it("the '2 claude, 5 codex' flow: clone clone clone stays valid", () => {
    let text = addAgent(YML, "review", "codex").text;
    for (let i = 2; i <= 5; i++) {
      text = cloneAgent(text, "review", `review-${i}`).text;
    }
    const config = expectValid(text);
    const reviewers = Object.keys(config.agents).filter((n) => n.startsWith("review"));
    expect(reviewers).toHaveLength(5);
    expect(config.agents["review-5"].cmd).toBe("codex");
  });

  it("deleteAgent removes the agent; the last agent cannot be deleted", () => {
    // spec 234 — the YML fixture still carries a `layouts:` block: it must load fine (tolerated, ignored).
    const { text } = deleteAgent(YML, "dev");
    const config = expectValid(text);
    expect(config.agents.dev).toBeUndefined();
    expect(config.agents.frontend).toBeDefined();

    // the last remaining agent cannot be deleted (would leave an invalid config)
    expect(() => deleteAgent(text, "frontend")).toThrow("is the last agent");
  });

  it("renameAgent renames the key and preserves the definition", () => {
    const { text } = renameAgent(YML, "frontend", "ui");
    const config = expectValid(text);
    expect(config.agents.frontend).toBeUndefined();
    expect(config.agents.ui.cmd).toBe("claude");
    expect(config.agents.ui.autostart).toBe(true);
    expect(() => renameAgent(YML, "frontend", "dev")).toThrow("already exists");
  });

  it("agentEntryLine points Edit at the right line", () => {
    const line = agentEntryLine(YML, "dev")!;
    expect(YML.split("\n")[line]).toContain("dev:");
    expect(agentEntryLine(YML, "ghost")).toBeUndefined();
  });

  it("refuses to operate on a broken file instead of destroying it", () => {
    expect(() => deleteAgent("agents: [unclosed", "x")).toThrow("not parseable");
  });

});

describe("runbook CRUD (Studio Runbook tab path)", () => {
  const RB_YML = [
    "agents:",
    "  a: {cmd: x}",
    "commands:",
    "  lint: {cmd: npm run lint}",
    "# procedures",
    "runbooks:",
    "  ship:",
    "    steps: [lint, ./deploy.sh]",
    "",
  ].join("\n");

  it("upsertRunbook creates, edits in place, and renames via replaceName", () => {
    const created = upsertRunbook(RB_YML, "release", { steps: ["lint", "echo done"] });
    const config = expectValid(created.text);
    expect(config.runbooks.release.steps).toEqual(["lint", "echo done"]);
    expect(created.text).toContain("# procedures"); // comments preserved

    expect(() => upsertRunbook(RB_YML, "ship", { steps: ["x"] })).toThrow("already exists");

    const edited = upsertRunbook(RB_YML, "ship", { steps: ["lint"] }, "ship");
    expect(expectValid(edited.text).runbooks.ship.steps).toEqual(["lint"]);

    const renamed = upsertRunbook(RB_YML, "deploy", { steps: ["lint"] }, "ship");
    const config2 = expectValid(renamed.text);
    expect(config2.runbooks.ship).toBeUndefined();
    expect(config2.runbooks.deploy.steps).toEqual(["lint"]);
  });

  it("upsertRunbook refuses empty steps and a missing yml", () => {
    expect(() => upsertRunbook(RB_YML, "r", { steps: [] })).toThrow("non-empty");
    expect(() => upsertRunbook(undefined, "r", { steps: ["x"] })).toThrow("create an agent first");
  });

  it("deleteRunbook removes the entry; runbookEntryLine points Edit at it", () => {
    const line = runbookEntryLine(RB_YML, "ship")!;
    expect(RB_YML.split("\n")[line]).toContain("ship:");
    const { text } = deleteRunbook(RB_YML, "ship");
    expect(expectValid(text).runbooks.ship).toBeUndefined();
    expect(() => deleteRunbook(text, "ship")).toThrow("does not exist");
  });
});

describe("YamlConfigEditor — terminals: block section-awareness (spec 215)", () => {
  // A file with BOTH blocks + a comment in each, plus a legacy terminal under agents:.
  const MIX = `# topo
agents:
  frontend:
    cmd: claude
  legacy-term:        # terminal declarado do jeito antigo
    cmd: npm run old
    kind: terminal
terminals:
  # o dev server
  dev:
    cmd: npm run dev
    watch: src/**
`;

  it("a NEW terminal lands in terminals: and never carries kind/instructions", () => {
    const { text } = upsertAgent(MIX, "api", { cmd: "npm run api", kind: "terminal", instructions: "x" }, undefined, "terminals");
    const config = expectValid(text);
    expect(config.agents.api).toMatchObject({ kind: "terminal", cmd: "npm run api" });
    expect(text).toContain("# o dev server");        // comments preserved
    expect(text).not.toMatch(/api:[\s\S]*?kind:/);    // kind stripped (parseConfig would reject it)
  });

  it("a NEW agent stays in agents:", () => {
    const { text } = upsertAgent(MIX, "rev", { cmd: "codex" }, undefined, "agents");
    expect(text).toMatch(/agents:[\s\S]*rev:/);
    expect(text).not.toMatch(/terminals:[\s\S]*rev:/);
  });

  it("editing a legacy agents: terminal rewrites it IN PLACE (never moves to terminals:)", () => {
    const { text } = upsertAgent(MIX, "legacy-term", { cmd: "npm run new", kind: "terminal" }, "legacy-term", "terminals");
    const config = expectValid(text);
    expect(config.agents["legacy-term"].cmd).toBe("npm run new");
    expect(text).toMatch(/agents:[\s\S]*legacy-term:/);       // still under agents:
    expect(text).not.toMatch(/terminals:[\s\S]*legacy-term:/); // not moved
  });

  it("editing a terminals: entry stays in terminals:", () => {
    const { text } = upsertAgent(MIX, "dev", { cmd: "npm run dev -- --host" }, "dev", "terminals");
    expect(text).toMatch(/terminals:[\s\S]*dev:/);
    expect(expectValid(text).agents.dev.cmd).toBe("npm run dev -- --host");
  });

  it("refuses a new name already taken in EITHER block", () => {
    expect(() => upsertAgent(MIX, "frontend", { cmd: "x" }, undefined, "terminals")).toThrow("already exists");
    expect(() => upsertAgent(MIX, "dev", { cmd: "x" }, undefined, "agents")).toThrow("already exists");
  });

  it("delete / rename / clone / entryLine resolve a terminals: entry", () => {
    expect(expectValid(deleteAgent(MIX, "dev").text).agents.dev).toBeUndefined();
    const renamed = renameAgent(MIX, "dev", "devserver").text;
    expect(expectValid(renamed).agents.devserver.kind).toBe("terminal");
    const cloned = cloneAgent(MIX, "dev", "dev2").text;
    expect(expectValid(cloned).agents.dev2.cmd).toBe("npm run dev");
    expect(cloned).toMatch(/terminals:[\s\S]*dev2:/); // cloned within terminals:
    expect(agentEntryLine(MIX, "dev")).toBeGreaterThan(0);
  });

  it("addAgent refuses a name already taken in terminals: (one namespace — #2 review fix)", () => {
    expect(() => addAgent(MIX, "dev", "claude")).toThrow("already exists");
  });

  it("deleting the last entry of a block drops the now-empty block", () => {
    const oneEach = `agents:\n  a:\n    cmd: claude\nterminals:\n  dev:\n    cmd: npm run dev\n`;
    const { text } = deleteAgent(oneEach, "dev");
    expect(text).not.toContain("terminals:"); // empty block removed
    expect(expectValid(text).agents.a.kind).toBe("agent");
  });
});

describe("setCompanionTabTools (SDD 414)", () => {
  it("writes settings.companion.tabTools true/false and stays loadable", () => {
    const on = setCompanionTabTools(YML, true).text;
    expect(expectValid(on).settings.companion?.tabTools).toBe(true);
    expect(on).toMatch(/companion:[\s\S]*tabTools:\s*true/);
    const off = setCompanionTabTools(on, false).text;
    expect(expectValid(off).settings.companion?.tabTools).toBe(false);
  });

  it("refuses empty yml", () => {
    expect(() => setCompanionTabTools(undefined, true)).toThrow("existing tachyon.yml");
  });
});
