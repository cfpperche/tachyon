import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";

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
    expect(config?.layouts.pair.grid).toBe("2up");
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

  it("validates layouts: grid enum, agent references", () => {
    const base = `agents:\n  a:\n    cmd: x\n`;
    expect(parseConfig(`${base}layouts:\n  l:\n    grid: 5up\n    agents: [a]\n`).errors[0]).toContain("grid");
    expect(parseConfig(`${base}layouts:\n  l:\n    grid: 2up\n    agents: [ghost]\n`).errors[0]).toContain(
      "unknown agent 'ghost'",
    );
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

  // spec 226 — isolated harness validation (H4/H7/H9)
  describe("harness:", () => {
    const harnessYml = (body: string) => `agents:\n  researcher:\n    cmd: claude\n    harness:\n${body}`;
    const mcpBlock = `      inherit: workspace\n      mcp:\n        fal-ai:\n          command: npx\n          args: ["-y", "@fal-ai/mcp"]\n          env:\n            FAL_KEY: \${FAL_KEY}\n`;

    it("parses a valid claude harness with mcp + ${VAR} env", () => {
      const { config, errors } = parseConfig(harnessYml(mcpBlock));
      expect(errors).toEqual([]);
      const h = config?.agents.researcher.harness;
      expect(h?.inherit).toBe("workspace");
      expect(h?.mcp["fal-ai"].command).toBe("npx");
      expect(h?.mcp["fal-ai"].args).toEqual(["-y", "@fal-ai/mcp"]);
      expect(h?.mcp["fal-ai"].env).toEqual({ FAL_KEY: "${FAL_KEY}" });
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

    it("rejects harness on a non-claude agent (v1)", () => {
      expect(parseConfig(`agents:\n  c:\n    cmd: codex\n    harness:\n      mcp:\n        s:\n          command: x\n`).errors.some((e) => e.includes("only supported for claude agents"))).toBe(true);
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

    it("rejects not-yet-built keys skills/rules/hooks (H9)", () => {
      expect(parseConfig(harnessYml(`      mcp:\n        s:\n          command: x\n      skills: ["./s"]\n`)).errors.some((e) => e.includes("skills: not supported in v1"))).toBe(true);
    });

    it("rejects an empty mcp map", () => {
      expect(parseConfig(harnessYml(`      mcp: {}\n`)).errors.some((e) => e.includes("non-empty mapping of server"))).toBe(true);
    });
  });
});
