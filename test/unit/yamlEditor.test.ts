import { describe, it, expect } from "vitest";
import {
  addAgent,
  cloneAgent,
  deleteAgent,
  renameAgent,
  agentEntryLine,
} from "../../src/config/YamlConfigEditor.js";
import { parseConfig } from "../../src/config/loadConfig.js";

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

  it("deleteAgent cleans layout references; empty layouts are dropped with a warning", () => {
    const { text, warnings } = deleteAgent(YML, "dev");
    const config = expectValid(text);
    expect(config.agents.dev).toBeUndefined();
    expect(config.layouts.pair.agents).toEqual(["frontend"]);
    expect(warnings).toContainEqual(expect.stringContaining("'pair' no longer includes 'dev'"));

    // the last remaining agent cannot be deleted (would leave an invalid config)
    expect(() => deleteAgent(text, "frontend")).toThrow("is the last agent");

    // deleting the last layout member removes the layout itself
    const withExtra = addAgent(text, "spare", "sh").text;
    const second = deleteAgent(withExtra, "frontend");
    const config2 = expectValid(second.text);
    expect(config2.layouts.pair).toBeUndefined();
    expect(second.warnings).toContainEqual(expect.stringContaining("lost its last agent"));
  });

  it("renameAgent updates layout references and preserves the definition", () => {
    const { text, warnings } = renameAgent(YML, "frontend", "ui");
    const config = expectValid(text);
    expect(config.agents.frontend).toBeUndefined();
    expect(config.agents.ui.cmd).toBe("claude");
    expect(config.agents.ui.autostart).toBe(true);
    expect(config.layouts.pair.agents).toEqual(["ui", "dev"]);
    expect(warnings).toContainEqual(expect.stringContaining("'pair' updated"));
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
