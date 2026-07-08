import { describe, it, expect } from "vitest";
import { parseConfig, inferKind, composeCommand, resolveBinary } from "../../src/config/loadConfig.js";

const VALID = `
agents:
  claude:
    cmd: claude
    autostart: true
  dev:
    cmd: npm run dev
    cwd: app
    env:
      PORT: "3000"
    watch: "src/**/*.ts"
layouts:
  pair:
    grid: 2up
    agents: [claude, dev]
settings:
  maxAgents: 4
`;

describe("parseConfig", () => {
  it("parses a full valid config with defaults applied", () => {
    const { config, errors } = parseConfig(VALID);
    expect(errors).toEqual([]);
    expect(config).toBeDefined();
    expect(config?.agents.claude.autostart).toBe(true);
    expect(config?.agents.claude.watch).toEqual([]);
    expect(config?.agents.dev.autostart).toBe(false);
    expect(config?.agents.dev.watch).toEqual(["src/**/*.ts"]);
    expect(config?.agents.dev.env).toEqual({ PORT: "3000" });
    expect((config as unknown as { layouts?: unknown }).layouts).toBeUndefined(); // spec 234 — layouts: tolerated but not parsed
    expect(config?.settings.maxAgents).toBe(4);
  });

  it("normalizes watch lists", () => {
    const { config } = parseConfig(`agents:\n  a:\n    cmd: x\n    watch: ["a/**", "b/**"]\n`);
    expect(config?.agents.a.watch).toEqual(["a/**", "b/**"]);
  });

  it("rejects invalid YAML", () => {
    const { config, errors } = parseConfig("agents: [unclosed");
    expect(config).toBeUndefined();
    expect(errors[0]).toContain("invalid YAML");
  });

  it("rejects a non-mapping document", () => {
    expect(parseConfig("- just\n- a list\n").errors[0]).toContain("YAML mapping");
  });

  it("requires a non-empty agents section", () => {
    expect(parseConfig("agents: {}\n").errors[0]).toContain("non-empty");
    expect(parseConfig("layouts: {}\n").errors.some((e) => e.includes("agents"))).toBe(true);
  });

  it("requires cmd and validates field types with paths in messages", () => {
    const { errors } = parseConfig(`agents:\n  bad:\n    cwd: 3\n`);
    expect(errors.some((e) => e.includes("agents.bad.cmd"))).toBe(true);

    const { errors: e2 } = parseConfig(`agents:\n  a:\n    cmd: x\n    autostart: "yes"\n`);
    expect(e2[0]).toContain("agents.a.autostart");

    const { errors: e3 } = parseConfig(`agents:\n  a:\n    cmd: x\n    env:\n      N: 1\n`);
    expect(e3[0]).toContain("agents.a.env");
  });

  it("rejects invalid agent names and unknown keys", () => {
    expect(parseConfig(`agents:\n  "1bad":\n    cmd: x\n`).errors[0]).toContain("invalid name");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\n    nope: 1\n`).errors[0]).toContain("unknown key 'nope'");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\ntypo: 1\n`).errors[0]).toContain("unknown top-level key 'typo'");
  });

  it("spec 352 — parses subagents and derives child-side declaredOwner metadata", () => {
    const { config, errors } = parseConfig(`agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer, tester]\n  reviewer:\n    cmd: codex\n  tester:\n    cmd: claude\n`);
    expect(errors).toEqual([]);
    expect(config?.agents.claude.subagents).toEqual(["reviewer", "tester"]);
    expect(config?.declaredOwner).toEqual({ reviewer: "claude", tester: "claude" });
    expect(config?.agents.reviewer).not.toHaveProperty("declaredOwner");
  });

  it("spec 352 — subagents are optional and existing configs derive an empty ownership map", () => {
    const { config, errors } = parseConfig(`agents:\n  a:\n    cmd: x\n`);
    expect(errors).toEqual([]);
    expect(config?.agents.a.subagents).toBeUndefined();
    expect(config?.declaredOwner).toEqual({});
  });

  it("spec 352 — validates dangling, terminal, multi-owner, self, direct-cycle, and deep-tree refs", () => {
    const cases: Array<[string, string]> = [
      ["agents:\n  owner:\n    cmd: claude\n    subagents: [ghost]\n", "agents.owner.subagents: 'ghost' is not declared"],
      ["agents:\n  owner:\n    cmd: claude\n    subagents: [dev]\n  dev:\n    cmd: npm run dev\n    kind: terminal\n", "agents.owner.subagents: 'dev' resolves to a terminal"],
      ["agents:\n  a:\n    cmd: claude\n    subagents: [child]\n  b:\n    cmd: codex\n    subagents: [child]\n  child:\n    cmd: claude\n", "agents.b.subagents: 'child' is already declared as a subagent of 'a'"],
      ["agents:\n  a:\n    cmd: claude\n    subagents: [a]\n", "agents.a.subagents: 'a' cannot reference itself"],
      ["agents:\n  a:\n    cmd: claude\n    subagents: [b]\n  b:\n    cmd: codex\n    subagents: [a]\n", "agents.a.subagents: 'b' creates a direct ownership cycle with 'a'"],
      ["agents:\n  a:\n    cmd: claude\n    subagents: [b]\n  b:\n    cmd: codex\n    subagents: [c]\n  c:\n    cmd: claude\n", "agents.a.subagents: 'b' declares its own subagents"],
    ];
    for (const [yaml, expected] of cases) {
      expect(parseConfig(yaml).errors.some((e) => e.includes(expected))).toBe(true);
    }
  });

  it("spec 352 — rejects subagents on terminal entries and malformed lists before semantic validation", () => {
    expect(parseConfig(`agents:\n  dev:\n    cmd: npm run dev\n    kind: terminal\n    subagents: [a]\n`).errors.some((e) => e.includes("'subagents' applies only to agents"))).toBe(true);
    expect(parseConfig(`terminals:\n  dev:\n    cmd: npm run dev\n    subagents: [a]\n`).errors.some((e) => e.includes("'subagents' applies only to agents"))).toBe(true);
    expect(parseConfig(`agents:\n  a:\n    cmd: claude\n    subagents: ghost\n`).errors.some((e) => e.includes("subagents: must be a non-empty list"))).toBe(true);
  });

  it("tolerates a legacy layouts: block + settings.layout (feature retired — recognized, ignored, no error)", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    // a stale/garbage layouts block + a settings.layout pointing at a ghost layout must NOT error.
    const { config, errors } = parseConfig(`${base}layouts:\n  l:\n    grid: 5up\n    agents: [ghost]\n  junk: not-even-a-mapping\nsettings:\n  layout: ghost\n`);
    expect(errors).toEqual([]);
    expect(config).toBeDefined();
    expect((config as unknown as { layouts?: unknown }).layouts).toBeUndefined();
    expect((config?.settings as { layout?: unknown }).layout).toBeUndefined();
  });

  it("validates settings.maxAgents", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    expect(parseConfig(`${base}settings:\n  maxAgents: 0\n`).errors[0]).toContain("maxAgents");
    expect(parseConfig(`${base}settings:\n  maxAgents: 2.5\n`).errors[0]).toContain("maxAgents");
    expect(parseConfig(`${base}settings:\n  other: 1\n`).errors[0]).toContain("unknown key 'other'");
  });

  it("parses settings.tmux: bool -> on/off, number -> string, string literal", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    const { config, errors } = parseConfig(`${base}settings:\n  tmux:\n    mouse: false\n    history-limit: 50000\n    mode-keys: vi\n`);
    expect(errors).toEqual([]);
    expect(config?.settings.tmux).toEqual({ mouse: "off", "history-limit": "50000", "mode-keys": "vi" });
  });

  it("rejects a bad tmux option name and the reserved remain-on-exit", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    expect(parseConfig(`${base}settings:\n  tmux:\n    "Bad Key": on\n`).errors[0]).toContain("invalid option name");
    expect(parseConfig(`${base}settings:\n  tmux:\n    remain-on-exit: off\n`).errors[0]).toContain("reserved");
  });

  it("validates settings.bridgePort", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    expect(parseConfig(`${base}settings:\n  bridgePort: 45123\n`).config?.settings.bridgePort).toBe(45123);
    expect(parseConfig(`${base}settings:\n  bridgePort: 80\n`).errors[0]).toContain("bridgePort");
    expect(parseConfig(`${base}settings:\n  bridgePort: 99999\n`).errors[0]).toContain("bridgePort");
    expect(parseConfig(`${base}settings:\n  bridgePort: "4000"\n`).errors[0]).toContain("bridgePort");
  });

  // spec 210 — worktree config surface
  it("parses agent worktree/branch/worktreeSetup (string normalized to a list)", () => {
    const { config, errors } = parseConfig(
      `agents:\n  rev:\n    cmd: claude\n    worktree: true\n    branch: feature/auth\n    worktreeSetup: pnpm install\n`,
    );
    expect(errors).toEqual([]);
    const a = config?.agents.rev;
    expect(a?.worktree).toBe(true);
    expect(a?.branch).toBe("feature/auth");
    expect(a?.worktreeSetup).toEqual(["pnpm install"]);
  });

  it("accepts a worktreeSetup list and keeps it ordered", () => {
    const { config } = parseConfig(
      `agents:\n  rev:\n    cmd: claude\n    worktree: true\n    worktreeSetup:\n      - pnpm install\n      - cp a b\n`,
    );
    expect(config?.agents.rev.worktreeSetup).toEqual(["pnpm install", "cp a b"]);
  });

  it("validates agent worktree fields (type + branch chars)", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    expect(parseConfig(`${base.replace("cmd: x", 'cmd: x\n    worktree: "yes"')}`).errors[0]).toContain("worktree: must be a boolean");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\n    branch: "bad branch"\n`).errors[0]).toContain("branch: must not contain whitespace");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\n    branch: "feat/..hack"\n`).errors[0]).toContain("'..'");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\n    worktreeSetup: []\n`).errors[0]).toContain("worktreeSetup");
  });

  it("parses settings.worktree.{base,branch} and requires {agent} in the template", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    const ok = parseConfig(`${base}settings:\n  worktree:\n    base: ~/.cache/tachyon/worktrees\n    branch: "tachyon/{agent}"\n`);
    expect(ok.errors).toEqual([]);
    expect(ok.config?.settings.worktree).toEqual({ base: "~/.cache/tachyon/worktrees", branch: "tachyon/{agent}" });
    expect(parseConfig(`${base}settings:\n  worktree:\n    branch: "tachyon/fixed"\n`).errors[0]).toContain("{agent}");
    expect(parseConfig(`${base}settings:\n  worktree:\n    nope: 1\n`).errors[0]).toContain("unknown key 'nope'");
  });

  // spec 214 — verify-gate config surface
  it("parses agent verify + global settings.worktree.verify (trimmed)", () => {
    const { config, errors } = parseConfig(
      `agents:\n  rev:\n    cmd: claude\n    worktree: true\n    verify: "  npm test  "\nsettings:\n  worktree:\n    verify: ci\n`,
    );
    expect(errors).toEqual([]);
    expect(config?.agents.rev.verify).toBe("npm test");
    expect(config?.settings.worktree?.verify).toBe("ci");
  });

  it("rejects an empty / non-string verify (agent + global)", () => {
    expect(parseConfig(`agents:\n  a:\n    cmd: x\n    verify: "   "\n`).errors[0]).toContain("verify");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\n    verify: 3\n`).errors[0]).toContain("verify");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  worktree:\n    verify: ""\n`).errors[0]).toContain("settings.worktree.verify");
  });

  it("parses workspace settings.verify without touching spec-214 worktree verify", () => {
    const { config, errors } = parseConfig(
      `agents:\n  a:\n    cmd: x\nsettings:\n  verify:\n    full: "  npm run test:all  "\n    typecheck: " npm run typecheck "\n  worktree:\n    verify: ci\n`,
    );
    expect(errors).toEqual([]);
    expect(config?.settings.verify).toEqual({ full: "npm run test:all", typecheck: "npm run typecheck" });
    expect(config?.settings.worktree?.verify).toBe("ci");
  });

  it("validates workspace settings.verify shape and command values", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    expect(parseConfig(`${base}settings:\n  verify: nope\n`).errors[0]).toContain("settings.verify");
    expect(parseConfig(`${base}settings:\n  verify:\n    full: ""\n`).errors[0]).toContain("settings.verify.full");
    expect(parseConfig(`${base}settings:\n  verify:\n    typecheck: 3\n`).errors[0]).toContain("settings.verify.typecheck");
    expect(parseConfig(`${base}settings:\n  verify:\n    extra: true\n`).errors[0]).toContain("settings.verify: unknown key 'extra'");
  });

  // spec 215 — the terminals: block
  it("parses terminals: into the agents record as kind:terminal (attention off), all fields supported", () => {
    const { config, errors } = parseConfig(
      `agents:\n  claude:\n    cmd: claude\nterminals:\n  dev:\n    cmd: npm run dev\n    watch: src/**\n    restart: on-crash\n  shell:\n    cmd: bash\n`,
    );
    expect(errors).toEqual([]);
    expect(config?.agents.claude.kind).toBe("agent");
    const dev = config?.agents.dev;
    expect(dev).toMatchObject({ kind: "terminal", cmd: "npm run dev", watch: ["src/**"], restart: "on-crash" });
    expect(dev?.attention.enabled).toBe(false); // terminals default attention off
    expect(config?.agents.shell.kind).toBe("terminal");
  });

  it("a terminals-only config is valid (agents: optional when terminals: has entries)", () => {
    const { config, errors } = parseConfig(`terminals:\n  dev:\n    cmd: npm run dev\n`);
    expect(errors).toEqual([]);
    expect(config?.agents.dev.kind).toBe("terminal");
  });

  it("rejects kind / instructions inside terminals: (kind implied, no AI) — single clear error, no 'unknown key' dup", () => {
    const k = parseConfig(`terminals:\n  dev:\n    cmd: x\n    kind: agent\n`).errors;
    expect(k.some((e) => e.includes("remove 'kind'"))).toBe(true);
    expect(k.some((e) => e.includes("unknown key 'kind'"))).toBe(false); // #4 review fix: not double-reported
    expect(parseConfig(`terminals:\n  dev:\n    cmd: x\n    instructions: hi\n`).errors[0]).toContain("instructions");
    expect(parseConfig(`terminals:\n  dev:\n    cmd: x\n    nope: 1\n`).errors[0]).toContain("unknown key 'nope'");
  });

  it("rejects an agents↔terminals name collision (one namespace)", () => {
    const { errors } = parseConfig(`agents:\n  dev:\n    cmd: claude\nterminals:\n  dev:\n    cmd: npm run dev\n`);
    expect(errors[0]).toContain("already declared under agents");
  });

  it("still requires at least one entry across both blocks", () => {
    expect(parseConfig(`terminals: {}\n`).errors.some((e) => e.includes("agents"))).toBe(true);
    expect(parseConfig(`agents: {}\n`).errors[0]).toContain("non-empty");
  });

  it("backward compatible: a terminal declared the old way (agents: + kind: terminal) is identical", () => {
    const viaTerminals = parseConfig(`terminals:\n  dev:\n    cmd: npm run dev\n`).config?.agents.dev;
    const viaAgents = parseConfig(`agents:\n  dev:\n    cmd: npm run dev\n    kind: terminal\n`).config?.agents.dev;
    expect(viaTerminals).toEqual(viaAgents);
  });

  // spec 216 — role + anchor/bridgeGuidance settings
  it("parses a valid agent role", () => {
    const { config, errors } = parseConfig(`agents:\n  rev:\n    cmd: claude\n    role: reviewer\n`);
    expect(errors).toEqual([]);
    expect(config?.agents.rev.role).toBe("reviewer");
  });
  it("rejects an unknown role", () => {
    const { errors } = parseConfig(`agents:\n  a:\n    cmd: claude\n    role: architect\n`);
    expect(errors.some((e) => e.includes("role: must be one of"))).toBe(true);
  });
  it("rejects role under terminals:", () => {
    const { errors } = parseConfig(`terminals:\n  dev:\n    cmd: npm run dev\n    role: coder\n`);
    expect(errors.some((e) => e.includes("'role' applies only to agents"))).toBe(true);
  });
  it("rejects role on an agents: entry with kind: terminal (old-style)", () => {
    const { errors } = parseConfig(`agents:\n  dev:\n    cmd: npm run dev\n    kind: terminal\n    role: coder\n`);
    expect(errors.some((e) => e.includes("'role' applies only to agents"))).toBe(true);
  });
  it("no role = no role field (today's behavior)", () => {
    const { config } = parseConfig(`agents:\n  a:\n    cmd: claude\n`);
    expect(config?.agents.a.role).toBeUndefined();
  });
  it("parses settings.anchor.auto and settings.bridgeGuidance", () => {
    const { config, errors } = parseConfig(`agents:\n  a:\n    cmd: claude\nsettings:\n  anchor:\n    auto: true\n  bridgeGuidance: false\n`);
    expect(errors).toEqual([]);
    expect(config?.settings.anchor?.auto).toBe(true);
    expect(config?.settings.bridgeGuidance).toBe(false);
  });
  it("rejects bad anchor/bridgeGuidance types and unknown anchor keys", () => {
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  anchor:\n    auto: "yes"\n`).errors.some((e) => e.includes("anchor.auto: must be a boolean"))).toBe(true);
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  bridgeGuidance: 1\n`).errors.some((e) => e.includes("bridgeGuidance: must be a boolean"))).toBe(true);
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  anchor:\n    foo: true\n`).errors.some((e) => e.includes("anchor: unknown key 'foo'"))).toBe(true);
  });

  // spec 219 — settings.clipboard enum
  it("parses settings.clipboard auto/off and rejects other values", () => {
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  clipboard: auto\n`).config?.settings.clipboard).toBe("auto");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  clipboard: off\n`).config?.settings.clipboard).toBe("off");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  clipboard: yes\n`).errors.some((e) => e.includes("clipboard: must be 'auto' or 'off'"))).toBe(true);
  });

  // spec 245 — settings.handoff (path + nudgeEvery)
  it("parses settings.handoff.path + nudgeEvery and rejects bad values", () => {
    const ok = parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  handoff:\n    path: docs/HANDOFF.md\n    nudgeEvery: 1h\n`);
    expect(ok.config?.settings.handoff).toEqual({ path: "docs/HANDOFF.md", nudgeEvery: "1h" });
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  handoff:\n    nudgeEvery: off\n`).config?.settings.handoff?.nudgeEvery).toBe("off");
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  handoff:\n    path: ""\n`).errors.some((e) => e.includes("handoff.path: must be a non-empty string"))).toBe(true);
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  handoff:\n    nudgeEvery: soon\n`).errors.some((e) => e.includes("handoff.nudgeEvery"))).toBe(true);
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  handoff:\n    bogus: 1\n`).errors.some((e) => e.includes("handoff: unknown key 'bogus'"))).toBe(true);
  });

  // spec 312 — silent persistence hooks kill switch
  it("parses settings.persistence.silentHooks and rejects bad values", () => {
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  persistence:\n    silentHooks: false\n`).config?.settings.persistence).toEqual({ silentHooks: false });
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  persistence:\n    silentHooks: yes\n`).errors.some((e) => e.includes("persistence.silentHooks: must be a boolean"))).toBe(true);
    expect(parseConfig(`agents:\n  a:\n    cmd: x\nsettings:\n  persistence:\n    bogus: true\n`).errors.some((e) => e.includes("persistence: unknown key 'bogus'"))).toBe(true);
  });

  // spec 358 phase 2 — deprecated transcript isolation config remains read-compatible
  describe("deprecated isolate: transcript", () => {
    it("loads on a claude agent with an actionable warning", () => {
      const { config, errors, warnings } = parseConfig("agents:\n  reviewer:\n    cmd: claude\n    isolate: transcript\n");
      expect(errors).toEqual([]);
      expect(config?.agents.reviewer.isolate).toBe("transcript");
      expect(warnings).toEqual([
        "agents.reviewer: isolate: transcript is deprecated — codex is private-home by default; use harness:{} for a private claude config home",
      ]);
    });
    it("rejects an unknown value", () => {
      const { errors } = parseConfig("agents:\n  reviewer:\n    cmd: claude\n    isolate: full\n");
      expect(errors.some((e) => /isolate: deprecated; the only legacy-compatible value is 'transcript'/.test(e))).toBe(true);
    });
    it("loads on a codex agent with the same warning", () => {
      const { config, errors, warnings } = parseConfig("agents:\n  c:\n    cmd: codex\n    isolate: transcript\n");
      expect(errors).toEqual([]);
      expect(config?.agents.c.isolate).toBe("transcript");
      expect(warnings[0]).toContain("codex is private-home by default");
    });
    it("rejects non-claude/codex agents", () => {
      const { errors } = parseConfig("agents:\n  c:\n    cmd: opencode\n    isolate: transcript\n");
      expect(errors.some((e) => /deprecated legacy mode is only compatible with claude\/codex agents/.test(e))).toBe(true);
    });
    it("rejects terminals", () => {
      const { errors } = parseConfig("terminals:\n  sh:\n    cmd: claude\n    isolate: transcript\n");
      expect(errors.some((e) => /'isolate' applies only to agents/.test(e))).toBe(true);
    });
    it("rejects a user-set env.CLAUDE_CONFIG_DIR (Tachyon owns the home)", () => {
      const { errors } = parseConfig("agents:\n  r:\n    cmd: claude\n    isolate: transcript\n    env:\n      CLAUDE_CONFIG_DIR: /tmp/x\n");
      expect(errors.some((e) => /isolate: remove 'env.CLAUDE_CONFIG_DIR'/.test(e))).toBe(true);
    });
    it("rejects a user-set env.CODEX_HOME (Tachyon owns the home)", () => {
      const { errors } = parseConfig("agents:\n  r:\n    cmd: codex\n    isolate: transcript\n    env:\n      CODEX_HOME: /tmp/x\n");
      expect(errors.some((e) => /isolate: remove 'env.CODEX_HOME'/.test(e))).toBe(true);
    });
  });

  // spec 226 — isolated harness validation (H4/H7/H9)
  describe("harness:", () => {
    const harnessYml = (body: string) => `agents:\n  researcher:\n    cmd: claude\n    harness:\n${body}`;
    const mcpBlock = `      inherit: workspace\n      mcp:\n        fal-ai:\n          command: npx\n          args: ["-y", "@fal-ai/mcp"]\n          env:\n            FAL_KEY: \${FAL_KEY}\n`;

    it("parses a valid claude harness with mcp + ${VAR} env", () => {
      const { config, errors } = parseConfig(harnessYml(mcpBlock));
      expect(errors).toEqual([]);
      const h = config?.agents.researcher.harness;
      expect(h?.inherit).toBe("workspace");
      expect(h?.mcp?.["fal-ai"].command).toBe("npx");
      expect(h?.mcp?.["fal-ai"].args).toEqual(["-y", "@fal-ai/mcp"]);
      expect(h?.mcp?.["fal-ai"].env).toEqual({ FAL_KEY: "${FAL_KEY}" });
    });

    it("defaults inherit to workspace", () => {
      const { config } = parseConfig(harnessYml(`      mcp:\n        s:\n          command: x\n`));
      expect(config?.agents.researcher.harness?.inherit).toBe("workspace");
    });

    it("accepts inherit: none", () => {
      const { config, errors } = parseConfig(harnessYml(`      inherit: none\n      mcp:\n        s:\n          command: x\n`));
      expect(errors).toEqual([]);
      expect(config?.agents.researcher.harness?.inherit).toBe("none");
    });

    it("rejects inherit: global (v1 follow pass)", () => {
      expect(parseConfig(harnessYml(`      inherit: global\n      mcp:\n        s:\n          command: x\n`)).errors.some((e) => e.includes("inherit: 'global' is not supported"))).toBe(true);
    });

    it("rejects a literal (non-${VAR}) env value (H7 — no secret on disk)", () => {
      expect(parseConfig(harnessYml(`      mcp:\n        s:\n          command: x\n          env:\n            FAL_KEY: sk-literal-secret\n`)).errors.some((e) => e.includes("exact ${VAR} reference"))).toBe(true);
    });

    it("accepts harness on a codex agent", () => {
      const { config, errors } = parseConfig(`agents:\n  c:\n    cmd: codex\n    harness:\n      mcp:\n        s:\n          command: x\n`);
      expect(errors).toEqual([]);
      expect(config?.agents.c.harness?.mcp?.s.command).toBe("x");
    });

    it("spec 358: accepts an empty claude harness as a private config-home opt-in", () => {
      const { config, errors } = parseConfig(`agents:\n  c:\n    cmd: claude\n    harness: {}\n`);
      expect(errors).toEqual([]);
      expect(config?.agents.c.harness).toEqual({ inherit: "workspace" });
    });

    it("spec 311: accepts codex harness instructions/skills/hooks without requiring mcp", () => {
      const { config, errors } = parseConfig(`agents:\n  c:\n    cmd: codex\n    harness:\n      instructions: ["agents/researcher.md"]\n      skills: ["skills/research"]\n      hooks:\n        SessionStart:\n          - matcher: startup\n            hooks: [{ type: command, command: "./guard.sh" }]\n`);
      expect(errors).toEqual([]);
      expect(config?.agents.c.harness?.instructions).toEqual(["agents/researcher.md"]);
      expect(config?.agents.c.harness?.skills).toEqual(["skills/research"]);
      expect(config?.agents.c.harness?.hooks?.SessionStart).toBeTruthy();
    });

    it("spec 311: rejects codex harness rules and points to instructions", () => {
      const { errors } = parseConfig(`agents:\n  c:\n    cmd: codex\n    harness:\n      rules: ["r.md"]\n      mcp:\n        s:\n          command: x\n`);
      expect(errors.some((e) => e.includes("use 'instructions'"))).toBe(true);
    });

    it("rejects a codex harness with no accepted capability", () => {
      const { errors } = parseConfig(`agents:\n  c:\n    cmd: codex\n    harness:\n      inherit: none\n`);
      expect(errors.some((e) => e.includes("declare at least one"))).toBe(true);
    });

    it("rejects codex harness env aliases because Codex env_vars forwards keys", () => {
      const { errors } = parseConfig(`agents:\n  c:\n    cmd: codex\n    harness:\n      mcp:\n        s:\n          command: x\n          env:\n            API_KEY: \${SECRET}\n`);
      expect(errors.some((e) => e.includes("codex requires the env key to match its reference"))).toBe(true);
    });

    it("rejects harness on a non-claude/codex/opencode agent (v1)", () => {
      expect(parseConfig(`agents:\n  c:\n    cmd: gemini\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("only supported for claude/codex/opencode agents"))).toBe(true);
    });

    it("spec t-e2ebe3: accepts harness on an opencode agent (XDG layout)", () => {
      const { config, errors } = parseConfig(`agents:\n  oc:\n    cmd: opencode\n    harness:\n      mcp:\n        s:\n          command: x\n`);
      expect(errors).toEqual([]);
      expect(config?.agents.oc.harness?.mcp?.s.command).toBe("x");
    });

    it("spec t-e2ebe3: rejects opencode harness with XDG_*_HOME env plumbing (H4)", () => {
      for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG"]) {
        const env: Record<string, string> = {};
        env[k] = `/tmp/${k.toLowerCase()}`;
        const { errors } = parseConfig(`agents:\n  oc:\n    cmd: opencode\n    env:\n${Object.entries(env).map(([kk, vv]) => `      ${kk}: ${vv}\n`).join("")}    harness:\n      mcp:\n        s:\n          command: x\n`);
        expect(errors.some((e) => e.includes(`remove 'env.${k}'`))).toBe(true);
      }
    });

    it("spec t-e2ebe3: accepts an empty opencode harness as a private XDG-home opt-in (private-home + Bridge only)", () => {
      const { config, errors } = parseConfig(`agents:\n  oc:\n    cmd: opencode\n    harness: {}\n`);
      expect(errors).toEqual([]);
      expect(config?.agents.oc.harness).toEqual({ inherit: "workspace" });
    });

    it("spec t-e2ebe3: rejects opencode harness rules/instructions in v1", () => {
      expect(parseConfig(`agents:\n  oc:\n    cmd: opencode\n    harness:\n      rules: ["r.md"]\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("opencode does not support 'rules'/'instructions'"))).toBe(true);
      expect(parseConfig(`agents:\n  oc:\n    cmd: opencode\n    harness:\n      instructions: ["a.md"]\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("opencode does not support 'rules'/'instructions'"))).toBe(true);
    });

    it("rejects harness on a terminal entry", () => {
      expect(parseConfig(`terminals:\n  t:\n    cmd: claude\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("applies only to agents"))).toBe(true);
    });

    it("rejects a cmd that already owns the harness plumbing (H4)", () => {
      expect(parseConfig(`agents:\n  r:\n    cmd: claude --strict-mcp-config\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("Tachyon manages MCP config"))).toBe(true);
    });

    it("rejects the equals-form of a reserved flag too (H4 — --settings=path)", () => {
      expect(parseConfig(`agents:\n  r:\n    cmd: claude --settings=/tmp/x.json\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("Tachyon manages MCP config"))).toBe(true);
      expect(parseConfig(`agents:\n  r:\n    cmd: claude --mcp-config=/tmp/x.json\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("Tachyon manages MCP config"))).toBe(true);
    });

    it("rejects a user-declared env.CLAUDE_CONFIG_DIR (H4)", () => {
      expect(parseConfig(`agents:\n  r:\n    cmd: claude\n    env:\n      CLAUDE_CONFIG_DIR: /tmp/x\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("Tachyon owns the config home"))).toBe(true);
    });

    it("rejects a user-declared env.CODEX_HOME (spec 298)", () => {
      expect(parseConfig(`agents:\n  r:\n    cmd: codex\n    env:\n      CODEX_HOME: /tmp/x\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("Tachyon owns the config home"))).toBe(true);
    });


    it("rejects an empty mcp map", () => {
      expect(parseConfig(harnessYml(`      mcp: {}\n`)).errors.some((e) => e.includes("non-empty mapping of server"))).toBe(true);
    });

    it("spec 236: rejects the reserved Bridge server names (tachyon / tachyon_bridge)", () => {
      expect(parseConfig(harnessYml(`      mcp:\n        tachyon:\n          command: x\n`)).errors.some((e) => e.includes("reserved for the Tachyon Bridge"))).toBe(true);
      expect(parseConfig(harnessYml(`      mcp:\n        tachyon_bridge:\n          command: x\n`)).errors.some((e) => e.includes("reserved for the Tachyon Bridge"))).toBe(true);
    });

    // spec 228 — hooks/rules/skills + at-least-one
    it("parses hooks/rules/skills and mcp becomes optional (spec 228)", () => {
      const { config, errors } = parseConfig(
        harnessYml(`      rules: ["./rules/r.md"]\n      skills: ["./skills/s"]\n      hooks:\n        SessionStart:\n          - hooks: [{ type: command, command: "echo hi" }]\n`),
      );
      expect(errors).toEqual([]);
      const h = config?.agents.researcher.harness;
      expect(h?.mcp).toBeUndefined();
      expect(h?.rules).toEqual(["./rules/r.md"]);
      expect(h?.skills).toEqual(["./skills/s"]);
      expect(h?.hooks).toBeTruthy();
    });

    it("accepts a rules-only harness (no mcp)", () => {
      const { config, errors } = parseConfig(harnessYml(`      rules: "./r.md"\n`));
      expect(errors).toEqual([]);
      expect(config?.agents.researcher.harness?.rules).toEqual(["./r.md"]);
    });

    it("rejects an empty harness (no capability declared)", () => {
      expect(parseConfig(harnessYml(`      inherit: none\n`)).errors.some((e) => e.includes("at least one of mcp"))).toBe(true);
    });

    it("rejects bad rules/skills/hooks shapes", () => {
      expect(parseConfig(harnessYml(`      rules: []\n`)).errors.some((e) => e.includes("rules"))).toBe(true);
      expect(parseConfig(harnessYml(`      skills: [1]\n`)).errors.some((e) => e.includes("skills"))).toBe(true);
      expect(parseConfig(harnessYml(`      hooks: {}\n`)).errors.some((e) => e.includes("hooks"))).toBe(true);
    });

    it("still rejects inherit: global (follow pass)", () => {
      expect(parseConfig(harnessYml(`      inherit: global\n      rules: ["./r.md"]\n`)).errors.some((e) => e.includes("'global' is not supported"))).toBe(true);
    });

    it("rejects absolute / traversal rules-skills paths (codex M4)", () => {
      expect(parseConfig(harnessYml(`      rules: ["/etc/passwd"]\n`)).errors.some((e) => e.includes("workspace-relative"))).toBe(true);
      expect(parseConfig(harnessYml(`      skills: ["../../x"]\n`)).errors.some((e) => e.includes("workspace-relative"))).toBe(true);
      expect(parseConfig(harnessYml(`      rules: ["sub/../ok.md"]\n`)).errors.some((e) => e.includes("workspace-relative"))).toBe(true);
    });
  });
});

describe("resolveBinary / inferKind / composeCommand — launcher see-through (spec 246 codex #1/#3)", () => {
  it("resolveBinary sees through npx/bunx/pnpx and env (incl. -u/-C operands)", () => {
    expect(resolveBinary("claude")).toBe("claude");
    expect(resolveBinary("npx claude")).toBe("claude");
    expect(resolveBinary("bunx codex --flag")).toBe("codex");
    expect(resolveBinary("env FOO=1 claude")).toBe("claude");
    expect(resolveBinary("env -u ANTHROPIC_API_KEY claude")).toBe("claude"); // #3: operand skipped
    expect(resolveBinary("env -i -C /tmp BAR=2 agy")).toBe("agy");
    expect(resolveBinary("env -i -C /tmp BAR=2 gemini")).toBe("gemini");
    expect(resolveBinary("/usr/bin/sh -c 'echo'")).toBe("sh");
    expect(resolveBinary("echo hi")).toBe("echo");
  });

  it("inferKind classifies launcher-wrapped AI CLIs as agents (incl. env -u …)", () => {
    expect(inferKind("npx claude")).toBe("agent");
    expect(inferKind("env -u ANTHROPIC_API_KEY claude")).toBe("agent"); // #3: was a false-negative terminal
    expect(inferKind("agy")).toBe("agent");
    expect(inferKind("echo hi")).toBe("terminal");
  });

  it("composeCommand delivers the prompt for a launcher-wrapped AI CLI (#1 — brief was silently dropped)", () => {
    const out = composeCommand({ cmd: "npx claude", instructions: "TASK: ship it" });
    expect(out.startsWith("npx claude ")).toBe(true);
    expect(out).toMatch(/TASK: ship it/);
    expect(composeCommand({ cmd: "agy", instructions: "TASK: inspect" })).toBe("agy --prompt-interactive 'TASK: inspect'");
    // unknown CLI: stored, not delivered (documented)
    expect(composeCommand({ cmd: "echo hi", instructions: "x" })).toBe("echo hi");
  });
});
