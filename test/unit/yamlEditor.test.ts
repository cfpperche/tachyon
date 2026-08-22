import { describe, it, expect } from "vitest";
import {
  cloneAgent,
  deleteAgent,
  renameAgent,
  agentEntryLine,
  upsertAgent,
  setCompanionTabTools,
  setIdeBrowserEnabled,
  setCompanionLanAccess,
  setCompanionAllowedHosts,
  agentStanzaSection,
  agentStanzaSourceSlice,
  replaceAgentStanzaValue,
} from "@tachyon/engine/config/YamlConfigEditor.js";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { parseProfileAwareConfigSyntax } from "@tachyon/engine/config/agentProfileConfigLoader.js";

/**
 * t-c1ef82 — the EXACT call promotion makes (`extensionOperationService.promoteAgent`).
 *
 * Spelled once here so these tests exercise the production door rather than a lookalike: if that call
 * site changes shape, this helper is what has to change with it, and the composition guard below then
 * measures the new shape instead of quietly still measuring the old one.
 */
const promote = (text: string | undefined, name: string, cmd: string) =>
  upsertAgent(text ?? "", name, { cmd }, undefined, "terminals");

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
const TERMINAL_YML = YML.replace(/^agents:/m, "terminals:");

function expectValid(text: string) {
  const { config, errors } = parseConfig(text);
  expect(errors).toEqual([]);
  return config!;
}

describe("YamlConfigEditor", () => {
  it("replaces exactly one agent stanza value and preserves every outside byte", () => {
    const before = agentStanzaSourceSlice(YML, "frontend");
    const result = replaceAgentStanzaValue(
      YML,
      "frontend",
      before.valueSha256,
      "profile: .tachyon/agents/frontend/agent.yml\n",
    );
    expect(result.text.slice(0, before.valueStart)).toBe(YML.slice(0, before.valueStart));
    expect(result.text.slice(result.next.valueEnd)).toBe(YML.slice(before.valueEnd));
    expect(result.next.valueText).toBe("profile: .tachyon/agents/frontend/agent.yml\n");
    expect(() => replaceAgentStanzaValue(YML, "frontend", "0".repeat(64), "profile: x\n")).toThrow("CAS mismatch");
  });

  it("rejects aliases and merge keys for canonical profile pointers", () => {
    expect(() => agentStanzaSourceSlice("agents:\n  codex: &shared\n    cmd: codex\n", "codex")).toThrow("anchors");
    expect(() => agentStanzaSourceSlice("base: &base\n  cmd: codex\nagents:\n  codex:\n    <<: *base\n", "codex")).toThrow("merge keys");
  });

  it("promotion appends a terminal without touching comments elsewhere", () => {
    const { text } = promote(YML, "backend", "claude");
    const config = expectValid(text);
    expect(config.agents.backend.cmd).toBe("claude");
    expect(config.agents.backend.kind).toBe("terminal");
    // every user comment survived
    for (const comment of ["meu projeto", "o agente principal", "roda o Claude Code", "restart quando mudar", "lado a lado", "guardrail"]) {
      expect(text).toContain(comment);
    }
  });

  it("promotion creates a minimal file when none exists, and validates input", () => {
    const { text } = promote(undefined, "solo", "codex");
    expect(expectValid(text).agents.solo.cmd).toBe("codex");
    expect(() => promote(YML, "frontend", "x")).toThrow("already exists");
    expect(() => promote(YML, "1bad", "x")).toThrow("invalid agent name");
    expect(() => promote(YML, "ok", "  ")).toThrow("non-empty command");
  });

  /**
   * t-c1ef82 — the guard, and it must be read BY COMPOSITION.
   *
   * The retired `addAgent` passed its own unit tests for a year while emitting a config the product
   * refuses, because those tests read the result back through `parseConfig` — a different door from
   * the one production loads with. `parseProfileAwareConfigSyntax` is the door that runs on every real
   * load, and it is the only one that can prove a writer and the reader still agree.
   *
   * Add a writer, add it here. A writer whose output this refuses is a writer that corrupts the file.
   */
  it("no product writer emits a tachyon.yml the product reader refuses", () => {
    // A base the reader already accepts: a Saved Agent pointer plus a declared terminal. The `YML`
    // fixture above CANNOT serve here — it still spells the retired inline-agent form, so every case
    // built on it would fail on the fixture's own bytes and say nothing about the writer under test.
    // (Measured: aiming this guard at `YML` first is exactly what it reported.)
    const base = `# Tachyon config — meu projeto
agents:
  saved:
    profile: .tachyon/agents/saved/agent.yml

terminals:
  dev:
    cmd: npm run dev   # restart quando mudar

settings:
  maxAgents: 6
`;
    expect(parseProfileAwareConfigSyntax(base).errors, "the base fixture must itself be readable").toEqual([]);

    const written: Array<{ what: string; text: string }> = [];
    for (const { what, text } of written) {
      expect(parseProfileAwareConfigSyntax(text).errors, `${what} produced config the reader refuses:\n${text}`).toEqual([]);
    }
  });

  it("promotion cannot write the retired inline-agent shape", () => {
    // The shape the removed `addAgent` produced. t-ae221c retired the whole block rather than the
    // shape: it is read, warned about and dropped, so it declares nothing whatever it spells.
    const retired = "agents:\n  rev:\n    cmd: claude\n    kind: terminal\n";
    const read = parseProfileAwareConfigSyntax(retired);
    expect(read.errors).toEqual([]);
    expect(read.warnings).toEqual([]);
    expect(read.discarded).toEqual([]);
    expect(read.config?.agents).toEqual({});
    // What promotion writes instead lands in `terminals:`, where a terminal is readable.
    expect(promote(undefined, "rev", "claude").text).toContain("terminals:");
  });

  it("spec 352 — upsertAgent round-trips only the parent-side subagents field", () => {
    const base = `agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer]\n  reviewer:\n    cmd: codex\n`;
    const editedParent = upsertAgent(base, "claude", { cmd: "claude", subagents: ["reviewer"] }, "claude").text;
    const parentCfg = expectValid(editedParent);
    expect(parentCfg.agents).toEqual({});
    expect(parentCfg.declaredOwner).toEqual({});
    expect(editedParent).not.toContain("declaredOwner");

    const editedChild = upsertAgent(base, "reviewer", { cmd: "codex --model gpt-5" }, "reviewer").text;
    const childCfg = expectValid(editedChild);
    expect(childCfg.agents).toEqual({});
    expect(childCfg.declaredOwner).toEqual({});
    expect(editedChild).not.toContain("declaredOwner");
  });

  it("cloneAgent copies the full definition under a new name", () => {
    const { text } = cloneAgent(TERMINAL_YML, "dev", "dev-2");
    const config = expectValid(text);
    expect(config.agents["dev-2"]).toEqual(config.agents.dev);
    expect(text).toContain("o agente principal"); // comments elsewhere intact
    expect(() => cloneAgent(TERMINAL_YML, "ghost", "x2")).toThrow("does not exist");
    expect(() => cloneAgent(TERMINAL_YML, "dev", "frontend")).toThrow("already exists");
  });

  it("the '2 claude, 5 codex' flow: clone clone clone stays valid", () => {
    let text = upsertAgent(TERMINAL_YML, "review", { cmd: "codex" }, undefined, "terminals").text;
    for (let i = 2; i <= 5; i++) {
      text = cloneAgent(text, "review", `review-${i}`).text;
    }
    const config = expectValid(text);
    const reviewers = Object.keys(config.agents).filter((n) => n.startsWith("review"));
    expect(reviewers).toHaveLength(5);
    expect(config.agents["review-5"].cmd).toBe("codex");
  });

  it("deleteAgent removes the agent, including the last declared entry", () => {
    // spec 234 — the YML fixture still carries a `layouts:` block: it must load fine (tolerated, ignored).
    const { text } = deleteAgent(TERMINAL_YML, "dev");
    const config = expectValid(text);
    expect(config.agents.dev).toBeUndefined();
    expect(config.agents.frontend).toBeDefined();

    // t-ae221c — the last declared entry goes too. The fleet is `.tachyon/agents/`, so an empty
    // `tachyon.yml` roster is a workspace with no TERMINALS, not a workspace with no agents; and an
    // empty roster has been a valid load since t-f67185. Refusing here made deleting the only
    // terminal impossible in every workspace that had one.
    const emptied = deleteAgent(text, "frontend").text;
    expect(expectValid(emptied).agents).toEqual({});
  });

  it("renameAgent renames the key and preserves the definition", () => {
    const { text } = renameAgent(TERMINAL_YML, "frontend", "ui");
    const config = expectValid(text);
    expect(config.agents.frontend).toBeUndefined();
    expect(config.agents.ui.cmd).toBe("claude");
    expect(config.agents.ui.autostart).toBe(true);
    expect(() => renameAgent(TERMINAL_YML, "frontend", "dev")).toThrow("already exists");
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

// t-a65335 — the settings mutators edit `.tachyon/settings.yml`, whose TOP LEVEL is the settings
// mapping (no settings: wrapper), and they create the file's content from nothing: the "needs an
// existing tachyon.yml" guard was an artifact of the retired single file.
const SETTINGS_YML = "auth: true\n";
function expectValidSettings(text: string) {
  const { config, errors } = parseConfig(`settings:\n${text.split("\n").map((l) => (l.trim() ? `  ${l}` : l)).join("\n")}`);
  expect(errors).toEqual([]);
  return config!.settings;
}

describe("setCompanionTabTools (SDD 414)", () => {
  it("writes companion.tabTools true/false at the top level and stays loadable", () => {
    const on = setCompanionTabTools(SETTINGS_YML, true).text;
    expect(expectValidSettings(on).companion?.tabTools).toBe(true);
    expect(on).toMatch(/^companion:/m);
    const off = setCompanionTabTools(on, false).text;
    expect(expectValidSettings(off).companion?.tabTools).toBe(false);
  });

  it("creates the settings document from nothing", () => {
    expect(expectValidSettings(setCompanionTabTools(undefined, true).text).companion?.tabTools).toBe(true);
  });
});

describe("setIdeBrowserEnabled (SDD 488 F4)", () => {
  it("writes ideBrowser.enabled true/false at the top level and stays loadable", () => {
    const on = setIdeBrowserEnabled(SETTINGS_YML, true).text;
    expect(expectValidSettings(on).ideBrowser?.enabled).toBe(true);
    const off = setIdeBrowserEnabled(on, false).text;
    expect(expectValidSettings(off).ideBrowser?.enabled).toBe(false);
  });

  it("creates the settings document from nothing", () => {
    expect(expectValidSettings(setIdeBrowserEnabled(undefined, true).text).ideBrowser?.enabled).toBe(true);
  });
});

describe("setCompanionAllowedHosts (SDD 420)", () => {
  it("writes hosts and clears when empty", () => {
    const withHosts = setCompanionAllowedHosts(SETTINGS_YML, [" example.com ", "example.com", "*.herokuapp.com", ""]).text;
    expect(expectValidSettings(withHosts).companion?.allowedHosts).toEqual(["example.com", "*.herokuapp.com"]);
    const cleared = setCompanionAllowedHosts(withHosts, []).text;
    expect(expectValidSettings(cleared).companion?.allowedHosts).toBeUndefined();
  });

  it("creates the settings document from nothing", () => {
    expect(expectValidSettings(setCompanionAllowedHosts(undefined, ["a.com"]).text).companion?.allowedHosts).toEqual(["a.com"]);
  });
});

describe("setCompanionLanAccess (SDD 422)", () => {
  it("writes companion.lanAccess true/false at the top level and stays loadable", () => {
    const on = setCompanionLanAccess(SETTINGS_YML, true).text;
    expect(expectValidSettings(on).companion?.lanAccess).toBe(true);
    const off = setCompanionLanAccess(on, false).text;
    expect(expectValidSettings(off).companion?.lanAccess).toBe(false);
  });

  it("creates the settings document from nothing", () => {
    expect(expectValidSettings(setCompanionLanAccess(undefined, true).text).companion?.lanAccess).toBe(true);
  });
});

describe("agentStanzaSection", () => {
  const yml = "agents:\n  Ada:\n    cmd: codex\nterminals:\n  shell:\n    cmd: bash\n";

  it("names the block that declares a name, and undefined for one that is declared nowhere", () => {
    expect(agentStanzaSection(yml, "Ada")).toBe("agents");
    // t-bc8eed — Soul authority is an agent-only door. A terminal declaration, legacy or modern,
    // must be absent here rather than masquerading as an agent stanza.
    expect(agentStanzaSection(yml, "shell")).toBeUndefined();
    expect(agentStanzaSection(yml, "Ghost")).toBeUndefined();
  });

  it("treats an absent or empty tachyon.yml as declaring nothing rather than throwing", () => {
    expect(agentStanzaSection(undefined, "Ada")).toBeUndefined();
    expect(agentStanzaSection("   \n", "Ada")).toBeUndefined();
  });
});
