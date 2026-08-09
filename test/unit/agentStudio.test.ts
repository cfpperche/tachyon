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
  type FormState,
} from "../../src/webview/formLogic.js";
import { detectInstalledClis } from "../../src/webview/cliDetect.js";
import { isAttestedRuntime } from "../../src/runtime/attestedRuntimes.js";
import { composeCommand, shellQuote, instructionsDeliverable, parseConfig } from "../../src/config/loadConfig.js";
import { upsertAgent } from "../../src/config/YamlConfigEditor.js";

const BASE: FormState = {
  name: "revisor",
  cmd: "claude",
  kind: "agent",
  instructions: "",
  selfEvolution: false,
  watch: "",
  steps: "",
  cwd: "",
  autostart: false,
  restartOnCrash: false,
  attention: true,
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

  // t-aa06a8 — the isolated-harness AUTHORING door is gone. The form section rendered under
  // `showHarness && !canonical` and `canonical` is true for every agent Agent Studio can load, the
  // canonical profile schema has no `harness` key, and `Workspace.studioSubmit` refuses `kind:
  // "agent"` outright — so the fields had no reader, no destination and no writer. These guards keep
  // the WRITER dead: `toEntry` is the one function that turned form state into a `harness:` block.
  //
  // Both cases were watched RED against the pre-change `formLogic.ts` (restored from git into the
  // worktree for one run): `toEntry` emitted the block for the forced state, and `fromDef` returned
  // `harness: true`. A case built on `BASE` alone would have been green on both trees — `BASE` never
  // set the toggle — which is why the write case forces the field on rather than trusting the type.
  describe("isolated harness authoring is retired (t-aa06a8)", () => {
    it("toEntry never writes a harness block, even for a stale form state that still carries one", () => {
      // The cast is the point: an older client (or an older persisted patch) can still hand us these
      // keys. `FormState` no longer declares them, and `toEntry` must drop them rather than write.
      const stale = { harness: true, harnessInherit: "none", harnessMcp: "tavily:\n  command: npx" };
      for (const cmd of ["claude", "codex", "opencode", "grok", "hermes"]) {
        expect(toEntry({ ...BASE, cmd, ...stale } as FormState)).not.toHaveProperty("harness");
      }
    });

    it("fromDef does not resurrect a declared harness into the form", () => {
      // loadConfig still PARSES this block (the legacy inline reader is untouched, and HarnessManager
      // consumes what it produces) — the form simply no longer carries it in either direction.
      const { config } = parseConfig(
        "agents:\n  researcher:\n    cmd: claude\n    harness:\n      inherit: none\n      mcp:\n        tavily:\n          command: npx\n      rules: [\"r.md\"]\n",
      );
      expect((config!.agents.researcher as any).harness).toMatchObject({ inherit: "none" });
      const state = fromDef("researcher", config!.agents.researcher);
      expect(state).not.toHaveProperty("harness");
      expect(toEntry(state)).not.toHaveProperty("harness");
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
