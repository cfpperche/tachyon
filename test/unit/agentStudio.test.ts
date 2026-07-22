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
  fromRunbookDef,
  fromScheduleDef,
  parseSteps,
  stepResolutions,
  harnessRuntimeOf,
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
  soul: false,
  selfEvolution: false,
  role: "",
  watch: "",
  steps: "",
  cwd: "",
  autostart: false,
  restartOnCrash: false,
  attention: true,
  worktree: false,
  branch: "",
  worktreeSetup: "",
  verify: "",
  schedTiming: "every",
  schedEvery: "1h",
  schedAt: "09:00",
  schedAction: "run",
  schedTarget: "",
  catchUp: false,
  harness: false,
  harnessInherit: "workspace",
  harnessMcp: "",
  harnessRules: "",
  harnessInstructions: "",
  harnessSkills: "",
  harnessHooks: "",
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

  it("toEntry persists role for agents, drops it for terminals (spec 216)", () => {
    expect(toEntry({ ...BASE, role: "reviewer" })).toEqual({ cmd: "claude", role: "reviewer" });
    expect(toEntry({ ...BASE })).toEqual({ cmd: "claude" }); // none by default → clean yml
    expect(toEntry({ ...BASE, name: "dev", cmd: "npm run dev", kind: "terminal", attention: false, role: "coder" })).toEqual({ cmd: "npm run dev" });
    // round-trips from a declared role agent
    const { config } = parseConfig("agents:\n  rev:\n    cmd: claude\n    role: reviewer\n");
    expect(fromDef("rev", config!.agents.rev).role).toBe("reviewer");
  });

  it("toEntry persists worktree / branch / worktreeSetup (spec 210)", () => {
    expect(toEntry({ ...BASE, worktree: true, branch: "feature/x", worktreeSetup: "pnpm i\ncp a b" })).toMatchObject({
      worktree: true,
      branch: "feature/x",
      worktreeSetup: ["pnpm i", "cp a b"],
    });
    expect(toEntry({ ...BASE, worktree: true, worktreeSetup: "pnpm i" }).worktreeSetup).toBe("pnpm i"); // single → string
    expect(toEntry({ ...BASE }).worktree).toBeUndefined(); // off by default, clean yml
    // round-trips from a declared worktree agent
    const { config } = parseConfig("agents:\n  rev:\n    cmd: claude\n    worktree: true\n    branch: feat/x\n    worktreeSetup:\n      - pnpm i\n");
    expect(toEntry(fromDef("rev", config!.agents.rev))).toMatchObject({ worktree: true, branch: "feat/x", worktreeSetup: "pnpm i" });
  });

  it("toEntry persists the verify-gate; fromDef round-trips it (spec 214)", () => {
    expect(toEntry({ ...BASE, worktree: true, verify: "  npm test  " })).toMatchObject({ verify: "npm test" });
    expect(toEntry({ ...BASE }).verify).toBeUndefined(); // none by default, clean yml
    const { config } = parseConfig("agents:\n  rev:\n    cmd: claude\n    worktree: true\n    verify: test\n");
    expect(fromDef("rev", config!.agents.rev).verify).toBe("test");
    expect(toEntry(fromDef("rev", config!.agents.rev))).toMatchObject({ verify: "test" });
  });

  it("round-trips only the enabled Agent Evolution opt-in (spec 421)", () => {
    expect(toEntry({ ...BASE }).selfEvolution).toBeUndefined();
    expect(toEntry({ ...BASE, selfEvolution: true })).toMatchObject({ selfEvolution: { enabled: true } });
    expect(toEntry({ ...BASE, kind: "terminal", cmd: "bash", attention: false, selfEvolution: true }).selfEvolution).toBeUndefined();

    const { config } = parseConfig("agents:\n  enabled:\n    cmd: codex\n    selfEvolution: {enabled: true}\n  disabled:\n    cmd: codex\n    selfEvolution: {enabled: false}\n");
    expect(fromDef("enabled", config!.agents.enabled).selfEvolution).toBe(true);
    expect(fromDef("disabled", config!.agents.disabled).selfEvolution).toBe(false);
    expect(toEntry(fromDef("disabled", config!.agents.disabled)).selfEvolution).toBeUndefined();
  });

  // spec 358 phase 2 — Agent Studio no longer creates the deprecated isolate config tier
  describe("deprecated transcript isolation (Studio)", () => {
    it("toEntry never writes isolate: transcript", () => {
      expect(toEntry({ ...BASE, isolate: true })).toEqual({ cmd: "claude" });
      expect(toEntry({ ...BASE, cmd: "codex", isolate: true }).isolate).toBeUndefined();
    });
    it("fromDef loads legacy isolate without round-tripping it back to tachyon.yml", () => {
      const { config, warnings } = parseConfig("agents:\n  rev:\n    cmd: claude\n    isolate: transcript\n");
      expect(warnings[0]).toContain("is deprecated");
      const state = fromDef("rev", config!.agents.rev);
      expect(state.isolate).toBe(false);
      expect(toEntry(state)).toEqual({ cmd: "claude" });
    });
  });

  // spec 226/228/229 — isolated harness in the Studio form
  describe("isolated harness (Studio)", () => {
    const HARNESS = {
      harness: true,
      harnessMcp: "tavily:\n  command: npx\n  args: [\"-y\", \"tavily-mcp\"]\n  env:\n    TAVILY_API_KEY: ${TAVILY_API_KEY}",
      harnessRules: "rules/researcher.md",
      harnessSkills: "skills/research",
      harnessHooks: "",
    };

    it("toEntry builds a harness block (mcp YAML + rules + skills) for an agent", () => {
      const entry = toEntry({ ...BASE, ...HARNESS }) as any;
      expect(entry.harness.inherit).toBe("workspace");
      expect(entry.harness.mcp.tavily.command).toBe("npx");
      expect(entry.harness.mcp.tavily.env.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");
      expect(entry.harness.rules).toEqual(["rules/researcher.md"]);
      expect(entry.harness.skills).toEqual(["skills/research"]);
      expect(entry.harness.hooks).toBeUndefined(); // blank → omitted
    });

    it("toEntry omits harness when the toggle is off (clean yml)", () => {
      expect(toEntry({ ...BASE }).harness).toBeUndefined();
    });

    it("validateForm: harness on codex is accepted, unsupported agents are blocking", () => {
      expect(validateForm({ ...BASE, harness: true, cmd: "codex", harnessMcp: HARNESS.harnessMcp }, []).some((i) => i.blocking)).toBe(false);
      const issues = validateForm({ ...BASE, ...HARNESS, cmd: "npx -y @sourcegraph/amp" }, []);
      expect(issues.some((i) => i.code === "harness-claude-only" && i.blocking)).toBe(true);
    });

    it("Agent Studio recognizes grok/hermes/opencode as harness-capable (form visibility + validateForm)", () => {
      expect(harnessRuntimeOf("grok")).toBe("grok");
      expect(harnessRuntimeOf("hermes --tui")).toBe("hermes");
      expect(harnessRuntimeOf("opencode")).toBe("opencode");
      expect(harnessRuntimeOf("agy")).toBeUndefined();

      for (const cmd of ["grok", "hermes", "opencode"]) {
        const ok = validateForm({ ...BASE, harness: true, cmd, harnessMcp: HARNESS.harnessMcp, harnessRules: "" }, []);
        expect(ok.filter((i) => i.blocking)).toEqual([]);
        const blocked = validateForm({
          ...BASE,
          harness: true,
          cmd,
          harnessMcp: HARNESS.harnessMcp,
          harnessRules: "rules/x.md",
        }, []);
        expect(blocked.some((i) => i.code === "harness-home-config-only" && i.blocking)).toBe(true);
      }
    });

    it("spec 311: Agent Studio recognizes Codex as harness-capable, accepts instructions/skills/hooks, and still blocks rules", () => {
      expect(harnessRuntimeOf("codex --yolo")).toBe("codex");
      expect(harnessRuntimeOf("claude --model sonnet")).toBe("claude");
      expect(harnessRuntimeOf("opencode")).toBe("opencode");

      const accepted = validateForm({
        ...BASE,
        harness: true,
        cmd: "codex",
        harnessMcp: HARNESS.harnessMcp,
        harnessInstructions: "agents/researcher.md",
        harnessSkills: "skills/research",
        harnessHooks: "SessionStart:\n  - matcher: startup\n    hooks:\n      - type: command\n        command: ./guard.sh",
      }, []);
      expect(accepted.filter((i) => i.blocking)).toEqual([]);

      const entry = toEntry({ ...BASE, harness: true, cmd: "codex", harnessInstructions: "agents/researcher.md", harnessSkills: "skills/research" }) as any;
      expect(entry.harness.instructions).toEqual(["agents/researcher.md"]);
      expect(entry.harness.skills).toEqual(["skills/research"]);

      const issues = validateForm({ ...BASE, harness: true, cmd: "codex", harnessMcp: HARNESS.harnessMcp, harnessRules: "rules/researcher.md" }, []);
      expect(issues.some((i) => i.code === "codex-harness-mcp-only" && i.blocking)).toBe(true);
    });

    it("validateForm: an empty harness (toggle on, nothing declared) is blocking", () => {
      const issues = validateForm({ ...BASE, harness: true }, []);
      expect(issues.some((i) => i.code === "harness-empty" && i.blocking)).toBe(true);
    });

    it("validateForm: malformed mcp/hooks YAML is blocking", () => {
      expect(validateForm({ ...BASE, harness: true, harnessMcp: "just: [a, b" }, []).some((i) => i.code === "harness-mcp-invalid")).toBe(true);
      expect(validateForm({ ...BASE, harness: true, harnessHooks: ": : :" }, []).some((i) => i.code === "harness-hooks-invalid")).toBe(true);
    });

    it("codex B1: the form is intentionally shallow (a YAML-valid but loadConfig-invalid mcp passes validateForm — Workspace re-validates the full config before writing)", () => {
      // a server missing `command` parses as a YAML mapping → validateForm lets it through...
      const state = { ...BASE, harness: true, harnessMcp: "bad:\n  args: [\"x\"]" };
      expect(blockingErrors(validateForm(state, []))).toEqual([]);
      // ...but the resulting entry, wrapped as a full config, is rejected by parseConfig — which is the
      // guard Workspace.studioSubmit runs before persisting (so the file is never left broken).
      const entry = toEntry(state) as any;
      const { errors } = parseConfig(`agents:\n  researcher:\n    cmd: claude\n    harness:\n      mcp:\n        bad:\n          args: ["x"]\n`);
      expect(errors.length).toBeGreaterThan(0);
      expect(entry.harness.mcp.bad).toBeTruthy(); // toEntry itself doesn't deep-validate
    });

    it("fromDef round-trips a harness agent (mcp/rules back to editable text)", () => {
      const { config } = parseConfig(
        "agents:\n  researcher:\n    cmd: claude\n    harness:\n      inherit: none\n      mcp:\n        tavily:\n          command: npx\n      rules: [\"r.md\"]\n",
      );
      const state = fromDef("researcher", config!.agents.researcher);
      expect(state.harness).toBe(true);
      expect(state.harnessInherit).toBe("none");
      expect(state.harnessMcp).toContain("tavily");
      expect(state.harnessRules).toBe("r.md");
      // and back out to the same entry shape
      expect(toEntry(state)).toMatchObject({ harness: { inherit: "none", rules: ["r.md"] } });
    });
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

describe("quickAddChips (catalog merge)", () => {
  it("majors are always visible; undetected ones carry the install hint", () => {
    const chips = quickAddChips(["claude"]);
    const majors = AGENT_CATALOG.filter((e) => e.alwaysVisible).map((e) => e.bin);
    for (const bin of majors) expect(chips.map((c) => c.bin)).toContain(bin);
    expect(chips.find((c) => c.bin === "claude")).toMatchObject({ detected: true, installHint: undefined });
    const codex = chips.find((c) => c.bin === "codex")!;
    expect(codex.detected).toBe(false);
    expect(codex.installHint).toContain("npm install");
    const agy = chips.find((c) => c.bin === "agy")!;
    expect(agy).toMatchObject({ label: "Antigravity CLI", detected: false });
    expect(agy.installHint).toContain("antigravity.google/cli/install.sh");
    // gemini/aider are long-tail (legacy / less common) — not in the always-visible row
    expect(chips.map((c) => c.bin)).not.toContain("gemini");
    expect(chips.map((c) => c.bin)).not.toContain("aider");
  });

  it("long-tail CLIs appear only when detected", () => {
    expect(quickAddChips([]).map((c) => c.bin)).not.toContain("qwen");
    const withQwen = quickAddChips(["qwen"]);
    expect(withQwen.find((c) => c.bin === "qwen")).toMatchObject({ detected: true });
    expect(quickAddChips(["gemini"]).find((c) => c.bin === "gemini")).toMatchObject({
      detected: true,
      label: expect.stringContaining("legacy"),
    });
    expect(quickAddChips(["aider"]).find((c) => c.bin === "aider")).toMatchObject({ detected: true });
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
