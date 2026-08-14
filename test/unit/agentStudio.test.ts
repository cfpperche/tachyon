import { describe, it, expect } from "vitest";
import {
  quickAddChips,
  AGENT_CATALOG,
  flagSuggestionsFor,
  toggleFlag,
  suggestName,
  validateForm,
  validateTerminalForm,
  blockingErrors,
  toEntry,
  toTerminalEntry,
  fromTerminalDef,
  fromRunbookDef,
  fromScheduleDef,
  parseSteps,
  stepResolutions,
  type FormState,
} from "../../src/webview/formLogic.js";
import { detectInstalledClis } from "../../src/webview/cliDetect.js";
import { isAttestedRuntime } from "@tachyon/shared/runtime/attestedRuntimes.js";
import { composeCommand, shellQuote, instructionsDeliverable, parseConfig } from "../../src/config/loadConfig.js";
import { upsertAgent } from "../../src/config/YamlConfigEditor.js";

const BASE: FormState = {
  name: "revisor",
  cmd: "npm run dev",
  kind: "terminal",
  instructions: "",
  watch: "",
  steps: "",
  cwd: "",
  autostart: false,
  restartOnCrash: false,
  attention: false,
  worktree: false,
  branch: "",
  worktreeSetup: "",
  schedTiming: "every",
  schedEvery: "1h",
  schedAt: "09:00",
  schedAction: "run",
  schedTarget: "",
  catchUp: false,
  isolate: false,
};

describe("instructions delivery (composeCommand)", () => {
  it("appends a quoted positional prompt for known CLIs", () => {
    expect(composeCommand({ cmd: "claude", instructions: "you are a reviewer" })).toBe(
      "claude 'you are a reviewer'",
    );
    expect(composeCommand({ cmd: "agy", instructions: "review" })).toBe("agy --prompt-interactive 'review'");
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
    expect(flagSuggestionsFor("codex")).toContain("--model");
    expect(flagSuggestionsFor("codex")).not.toContain("-m gpt-5-codex");
    expect(flagSuggestionsFor("agy")).toContain("--continue");
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

  it("validateTerminalForm owns terminal validation and honors edit-mode uniqueness", () => {
    expect(validateTerminalForm({ ...BASE, name: "1bad" }, []).map((i) => i.code)).toContain("name-invalid");
    expect(validateTerminalForm({ ...BASE, cmd: " " }, []).map((i) => i.code)).toContain("cmd-required");
    expect(validateTerminalForm(BASE, ["revisor"]).map((i) => i.code)).toContain("name-taken");
    expect(validateTerminalForm(BASE, ["revisor"], "revisor")).toEqual([]);
  });

  it("toTerminalEntry writes only terminal fields and round-trips a full definition", () => {
    const entry = toTerminalEntry({
      ...BASE,
      watch: " src/** , package.json , ",
      cwd: "app",
      autostart: true,
      restartOnCrash: true,
      attention: true,
      instructions: "ignored",
      worktree: true,
      branch: "ignored",
      worktreeSetup: "ignored",
    });
    expect(entry).toEqual({
      cmd: "npm run dev",
      watch: ["src/**", "package.json"],
      cwd: "app",
      autostart: true,
      restart: "on-crash",
      attention: true,
    });
    const { config } = parseConfig("terminals:\n  dev:\n    cmd: npm run dev\n    cwd: app\n    autostart: true\n    restart: on-crash\n");
    expect(toTerminalEntry(fromTerminalDef("dev", config!.agents.dev))).toEqual({
      cmd: "npm run dev",
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

  it("edit mode replaces in place; rename moves the key; duplicate guarded", () => {
    const edited = upsertAgent(YML, "claude", { cmd: "claude --model haiku" }, "claude").text;
    expect(parseConfig(edited).config!.agents.claude.cmd).toBe("claude --model haiku");

    // spec 234 — rename moves the agent key; the legacy layouts: block in YML is tolerated (parses clean).
    const renamed = upsertAgent(YML, "principal", { cmd: "claude" }, "claude");
    const rcfg = parseConfig(renamed.text);
    expect(rcfg.errors).toEqual([]);
    expect(rcfg.config!.agents.principal).toBeDefined();
    expect(rcfg.config!.agents.claude).toBeUndefined();

    expect(() => upsertAgent(YML, "claude", { cmd: "x" })).toThrow("already exists");
    expect(() => upsertAgent(YML, "novo", { cmd: " " })).toThrow("non-empty command");
  });
});

/**
 * t-d68b8b narrowed this surface: a chip is now offered only for a runtime the canonical creation
 * path accepts, so both rules below are read through `isAttestedRuntime` instead of naming binaries.
 * What the FILTER guarantees lives in `agentStudioAttestedCreation.test.ts`; these keep measuring the
 * catalog-merge rules (always-visible vs detected-only, install hint) on top of it.
 */
describe("quickAddChips (catalog merge)", () => {
  it("attested majors are always visible; undetected ones carry the install hint", () => {
    const chips = quickAddChips(["claude"]);
    const majors = AGENT_CATALOG.filter((e) => e.alwaysVisible && isAttestedRuntime(e.bin)).map((e) => e.bin);
    expect(majors.length).toBeGreaterThan(0);
    for (const bin of majors) expect(chips.map((c) => c.bin)).toContain(bin);
    expect(chips.find((c) => c.bin === "claude")).toMatchObject({ detected: true, installHint: undefined });
    const codex = chips.find((c) => c.bin === "codex")!;
    expect(codex.detected).toBe(false);
    expect(codex.installHint).toContain("npm install");
    // An always-visible entry the creation path cannot accept is NOT a chip — that offer was the
    // dead end t-d68b8b closed (the form showed it, the save sent the human back to the form).
    const blockedMajors = AGENT_CATALOG.filter((e) => e.alwaysVisible && !isAttestedRuntime(e.bin)).map((e) => e.bin);
    for (const bin of blockedMajors) expect(chips.map((c) => c.bin)).not.toContain(bin);
  });

  it("long-tail CLIs appear only when detected — and only while attested", () => {
    const longTail = AGENT_CATALOG.filter((e) => !e.alwaysVisible);
    for (const entry of longTail) {
      expect(quickAddChips([]).map((c) => c.bin)).not.toContain(entry.bin);
      const found = quickAddChips([entry.bin]).find((c) => c.bin === entry.bin);
      if (isAttestedRuntime(entry.bin)) expect(found, entry.bin).toMatchObject({ detected: true });
      else expect(found, entry.bin).toBeUndefined();
    }
    // grok is this repo's attested long-tail entry today; qwen/gemini/aider are the blocked side.
    expect(quickAddChips(["grok"]).map((c) => c.bin)).toContain("grok");
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

describe("Runbook tab form logic", () => {
  const RB: FormState = { ...BASE, name: "ship", cmd: "", kind: "runbook", steps: "lint\n  test  \n\n./deploy.sh\n" };

  it("parseSteps trims and drops blanks; toEntry emits only the steps list", () => {
    expect(parseSteps(RB.steps)).toEqual(["lint", "test", "./deploy.sh"]);
    expect(toEntry(RB)).toEqual({ steps: ["lint", "test", "./deploy.sh"] });
  });

  it("validateForm: runbook requires name + at least one step; cmd not required", () => {
    expect(blockingErrors(validateForm(RB, []))).toEqual([]);
    const empty = blockingErrors(validateForm({ ...RB, steps: "  \n " }, []));
    expect(empty.map((i) => i.code)).toEqual(["steps-required"]);
    const taken = blockingErrors(validateForm(RB, ["ship"]));
    expect(taken.map((i) => i.code)).toEqual(["name-taken"]);
    expect(blockingErrors(validateForm(RB, ["ship"], "ship"))).toEqual([]); // edit mode
  });

  it("stepResolutions mirrors the runner: exact command-name match = ref, else inline", () => {
    expect(stepResolutions("lint\n./deploy.sh", ["lint", "test"])).toEqual([
      { step: "lint", ref: true },
      { step: "./deploy.sh", ref: false },
    ]);
  });

  it("fromRunbookDef prefills steps one per line", () => {
    expect(fromRunbookDef("ship", { steps: ["lint", "test"] }).steps).toBe("lint\ntest");
  });
});

// spec 279 — removed "Studio webview script integrity": it guarded spec 201's inline-script template-literal
// escaping bug (a raw \n unterminating the embedded <script> → blank form). The Agent Studio is now a preact
// BUNDLE, so that whole bug class is gone — there is no inline template-literal script to escape.

describe("Schedule tab form logic", () => {
  const SCHED = { ...BASE, name: "hourly", kind: "schedule" as const, schedTarget: "test" };

  it("toEntry builds every/run and at/spawn(+instructions, catchUp)", () => {
    expect(toEntry(SCHED)).toEqual({ every: "1h", run: "test" });
    expect(toEntry({ ...SCHED, schedTiming: "at", schedAt: "09:00", schedAction: "spawn", schedTarget: "claude", instructions: "standup", catchUp: true }))
      .toEqual({ at: "09:00", spawn: "claude", instructions: "standup", catchUp: true });
  });

  it("validates timing + target", () => {
    expect(blockingErrors(validateForm(SCHED, []))).toEqual([]);
    expect(blockingErrors(validateForm({ ...SCHED, schedEvery: "soon" }, [])).map((i) => i.code)).toEqual(["timing-invalid"]);
    expect(blockingErrors(validateForm({ ...SCHED, schedTiming: "at", schedAt: "25:00" }, [])).map((i) => i.code)).toEqual(["timing-invalid"]);
    expect(blockingErrors(validateForm({ ...SCHED, schedTarget: "" }, [])).map((i) => i.code)).toEqual(["target-required"]);
  });

  it("fromScheduleDef prefills timing/action from the entry", () => {
    expect(fromScheduleDef("s", { at: "02:00", run: "ship", catchUp: true })).toMatchObject({ schedTiming: "at", schedAt: "02:00", schedAction: "run", schedTarget: "ship", catchUp: true });
    expect(fromScheduleDef("s", { every: "30m", spawn: "claude", instructions: "go" })).toMatchObject({ schedTiming: "every", schedEvery: "30m", schedAction: "spawn", schedTarget: "claude", instructions: "go" });
  });
});
