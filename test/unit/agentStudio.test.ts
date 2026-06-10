import { describe, it, expect } from "vitest";
import {
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

  it("validateForm: name/cmd rules, uniqueness honors edit mode, instructions note is non-blocking", () => {
    expect(validateForm({ ...BASE, name: "1bad" }, [])).toContainEqual(expect.stringContaining("name:"));
    expect(validateForm({ ...BASE, cmd: " " }, [])).toContainEqual(expect.stringContaining("command:"));
    expect(validateForm(BASE, ["revisor"])).toContainEqual(expect.stringContaining("already exists"));
    expect(validateForm(BASE, ["revisor"], "revisor")).toEqual([]); // editing itself

    const noted = validateForm({ ...BASE, cmd: "bash", kind: "terminal", attention: false, instructions: "hi" }, []);
    expect(noted).toContainEqual(expect.stringContaining("note:"));
    expect(blockingErrors(noted)).toEqual([]);
  });

  it("toEntry writes only non-default fields (clean ymls)", () => {
    expect(toEntry(BASE)).toEqual({ cmd: "claude" }); // agent inferred, attention default, nothing else
    expect(
      toEntry({ ...BASE, kind: "terminal", attention: false, autostart: true, restartOnCrash: true, cwd: "app", instructions: "be brief" }),
    ).toEqual({
      cmd: "claude",
      kind: "terminal", // differs from inference
      instructions: "be brief",
      cwd: "app",
      autostart: true,
      restart: "on-crash",
    });
    // attention written only when it differs from the kind default
    expect(toEntry({ ...BASE, attention: false })).toEqual({ cmd: "claude", attention: false });
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

describe("cliDetect", () => {
  it("filters to CLIs the probe confirms", async () => {
    const found = await detectInstalledClis(async (bin) => bin === "claude" || bin === "codex");
    expect(found).toEqual(["claude", "codex"]);
  });
});
