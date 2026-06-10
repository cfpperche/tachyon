import { describe, it, expect } from "vitest";
import {
  quickAddChips,
  AGENT_CATALOG,
  flagSuggestionsFor,
  toggleFlag,
  suggestName,
  validateForm,
  blockingErrors,
  toEntry,
  fromDef,
  type FormState,
} from "../../src/webview/formLogic.js";
import { detectInstalledClis } from "../../src/webview/cliDetect.js";
import { composeCommand, shellQuote, instructionsDeliverable, parseConfig } from "../../src/config/loadConfig.js";
import { upsertAgent } from "../../src/config/YamlConfigEditor.js";

const BASE: FormState = {
  name: "revisor",
  cmd: "claude",
  kind: "agent",
  instructions: "",
  watch: "",
  cwd: "",
  autostart: false,
  restartOnCrash: false,
  attention: true,
};

describe("instructions delivery (composeCommand)", () => {
  it("appends a quoted positional prompt for known CLIs", () => {
    expect(composeCommand({ cmd: "claude", instructions: "you are a reviewer" })).toBe(
      "claude 'you are a reviewer'",
    );
    expect(composeCommand({ cmd: "gemini", instructions: "review" })).toBe("gemini -i 'review'");
    expect(composeCommand({ cmd: "claude --model sonnet", instructions: "x" })).toBe(
      "claude --model sonnet 'x'",
    );
  });

  it("does not deliver for unknown CLIs and without instructions", () => {
    expect(composeCommand({ cmd: "npm run dev", instructions: "irrelevant" })).toBe("npm run dev");
    expect(composeCommand({ cmd: "claude" })).toBe("claude");
    expect(instructionsDeliverable("claude")).toBe(true);
    expect(instructionsDeliverable("bash")).toBe(false);
  });

  it("shell-quotes safely (single quotes, $, backticks, embedded quotes)", () => {
    const evil = `don't run $(rm -rf) or \`x\` or "y"`;
    const quoted = shellQuote(evil);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted).toContain(`'\\''`); // POSIX-escaped single quote
    expect(composeCommand({ cmd: "claude", instructions: evil })).toContain(quoted);
  });
});

describe("formLogic", () => {
  it("flag suggestions follow the runtime in cmd; toggleFlag adds/removes", () => {
    expect(flagSuggestionsFor("claude --model sonnet")).toContain("--dangerously-skip-permissions");
    expect(flagSuggestionsFor("npm run dev")).toEqual([]);
    const withFlag = toggleFlag("claude", "--permission-mode plan");
    expect(withFlag).toBe("claude --permission-mode plan");
    expect(toggleFlag(withFlag, "--permission-mode plan")).toBe("claude");
  });

  it("suggestName avoids collisions", () => {
    expect(suggestName("claude", [])).toBe("claude");
    expect(suggestName("claude", ["claude"])).toBe("claude-2");
    expect(suggestName("claude", ["claude", "claude-2"])).toBe("claude-3");
  });

  it("validateForm: stable issue codes, uniqueness honors edit mode, note is non-blocking", () => {
    expect(validateForm({ ...BASE, name: "1bad" }, []).map((i) => i.code)).toContain("name-invalid");
    expect(validateForm({ ...BASE, cmd: " " }, []).map((i) => i.code)).toContain("cmd-required");
    expect(validateForm(BASE, ["revisor"]).map((i) => i.code)).toContain("name-taken");
    expect(validateForm(BASE, ["revisor"], "revisor")).toEqual([]); // editing itself

    const noted = validateForm({ ...BASE, cmd: "bash", kind: "terminal", attention: false, instructions: "hi" }, []);
    expect(noted.map((i) => i.code)).toContain("instructions-not-deliverable");
    expect(blockingErrors(noted)).toEqual([]);
  });

  it("toEntry writes only non-default fields (clean ymls)", () => {
    expect(toEntry(BASE)).toEqual({ cmd: "claude" }); // agent inferred, attention default, nothing else
    expect(
      toEntry({ ...BASE, kind: "terminal", attention: false, autostart: true, restartOnCrash: true, cwd: "app" }),
    ).toEqual({
      cmd: "claude",
      kind: "terminal", // differs from inference
      cwd: "app",
      autostart: true,
      restart: "on-crash",
    });
    // instructions persists for agent kind
    expect(toEntry({ ...BASE, instructions: "be brief" })).toEqual({ cmd: "claude", instructions: "be brief" });
    // attention written only when it differs from the kind default
    expect(toEntry({ ...BASE, attention: false })).toEqual({ cmd: "claude", attention: false });
  });

  it("kind-conditional fields: watch only for terminals, instructions only for agents", () => {
    // terminal: watch parsed (1 glob -> string, n globs -> list); instructions dropped
    expect(
      toEntry({ ...BASE, name: "dev", cmd: "npm run dev", kind: "terminal", attention: false, watch: "package.json", instructions: "ignored" }),
    ).toEqual({ cmd: "npm run dev", watch: "package.json" });
    expect(
      toEntry({ ...BASE, name: "dev", cmd: "npm run dev", kind: "terminal", attention: false, watch: " src/** , package.json , " }),
    ).toEqual({ cmd: "npm run dev", watch: ["src/**", "package.json"] });
    // agent: watch ignored even if filled
    expect(toEntry({ ...BASE, watch: "src/**" })).toEqual({ cmd: "claude" });
  });

  it("fromDef round-trips through toEntry for a full definition", () => {
    const { config } = parseConfig(
      "agents:\n  rev:\n    cmd: claude\n    instructions: review prs\n    cwd: app\n    autostart: true\n    restart: on-crash\n",
    );
    const state = fromDef("rev", config!.agents.rev);
    expect(state).toMatchObject({ name: "rev", cmd: "claude", instructions: "review prs", autostart: true, restartOnCrash: true });
    expect(toEntry(state)).toEqual({
      cmd: "claude",
      instructions: "review prs",
      cwd: "app",
      autostart: true,
      restart: "on-crash",
    });
  });
});

describe("upsertAgent (Agent Studio writes)", () => {
  const YML = "# meu config\nagents:\n  claude:\n    cmd: claude   # principal\nlayouts:\n  solo:\n    grid: 2up\n    agents: [claude]\n";

  it("creates with a full entry, preserving comments", () => {
    const { text } = upsertAgent(YML, "revisor", { cmd: "codex", instructions: "review", autostart: true });
    const config = parseConfig(text).config!;
    expect(config.agents.revisor).toMatchObject({ cmd: "codex", instructions: "review", autostart: true });
    expect(text).toContain("# meu config");
    expect(text).toContain("# principal");
  });

  it("edit mode replaces in place; rename updates layouts; duplicate guarded", () => {
    const edited = upsertAgent(YML, "claude", { cmd: "claude --model haiku" }, "claude").text;
    expect(parseConfig(edited).config!.agents.claude.cmd).toBe("claude --model haiku");

    const renamed = upsertAgent(YML, "principal", { cmd: "claude" }, "claude");
    expect(parseConfig(renamed.text).config!.layouts.solo.agents).toEqual(["principal"]);
    expect(renamed.warnings).toContainEqual(expect.stringContaining("solo"));

    expect(() => upsertAgent(YML, "claude", { cmd: "x" })).toThrow("already exists");
    expect(() => upsertAgent(YML, "novo", { cmd: " " })).toThrow("non-empty command");
  });
});

describe("quickAddChips (catalog merge)", () => {
  it("majors are always visible; undetected ones carry the install hint", () => {
    const chips = quickAddChips(["claude"]);
    const majors = AGENT_CATALOG.filter((e) => e.alwaysVisible).map((e) => e.bin);
    for (const bin of majors) expect(chips.map((c) => c.bin)).toContain(bin);
    expect(chips.find((c) => c.bin === "claude")).toMatchObject({ detected: true, installHint: undefined });
    const codex = chips.find((c) => c.bin === "codex")!;
    expect(codex.detected).toBe(false);
    expect(codex.installHint).toContain("npm install");
  });

  it("long-tail CLIs appear only when detected", () => {
    expect(quickAddChips([]).map((c) => c.bin)).not.toContain("qwen");
    const withQwen = quickAddChips(["qwen"]);
    expect(withQwen.find((c) => c.bin === "qwen")).toMatchObject({ detected: true });
  });

  it("every always-visible entry has an install hint (discovery contract)", () => {
    for (const e of AGENT_CATALOG.filter((e) => e.alwaysVisible)) {
      expect(e.installHint, e.bin).toBeTruthy();
    }
  });
});

describe("cliDetect", () => {
  it("filters to CLIs the probe confirms", async () => {
    const found = await detectInstalledClis(async (bin) => bin === "claude" || bin === "codex");
    expect(found).toEqual(["claude", "codex"]);
  });
});
