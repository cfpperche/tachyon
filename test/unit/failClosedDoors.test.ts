import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";
import { parseProfileAwareConfigSyntax } from "../../src/config/agentProfileConfigLoader.js";
import { validateForm, type FormState } from "../../src/webview/formLogic.js";
import { blankTerminalFields } from "../../src/webview/terminal-studio-shell/domain.js";
import { buildStarterYaml, type DetectedProject } from "../../src/init/initLogic.js";

/**
 * SDD 478 M6 — one rule at every door that can create or import a managed entry: a generic command
 * goes to `terminals:`, an attested runtime goes to a canonical profile, and anything ambiguous is
 * REFUSED with the fix in the message.
 *
 * The refusal text is part of the contract, not decoration. The whole cost of the `t-9418ac`
 * incident was three increments spent discovering WHICH block an entry belonged in, so every test
 * below asserts the diagnostic names the destination — not merely that something was rejected.
 */

const AGENT_ONLY_KEYS: ReadonlyArray<[key: string, yaml: string]> = [
  ["instructions", "    instructions: be helpful\n"],
  ["role", "    role: reviewer\n"],
  ["soul", "    soul: true\n"],
  ["selfEvolution", "    selfEvolution: { enabled: true }\n"],
  ["worktree", "    worktree: true\n"],
  ["branch", "    branch: tachyon/dev\n"],
  ["worktreeSetup", "    worktreeSetup: npm ci\n"],
  ["verify", "    verify: npm test\n"],
  ["harness", "    harness: {}\n"],
  ["isolate", "    isolate: transcript\n"],
  ["subagents", "    subagents: [child]\n"],
];

describe("door: terminals: in tachyon.yml", () => {
  it.each(AGENT_ONLY_KEYS)("refuses '%s' and names where the entry belongs", (key, yaml) => {
    const { errors } = parseConfig(`terminals:\n  dev:\n    cmd: npm run dev\n${yaml}`);
    const refusal = errors.find((error) => error.includes(`'${key}' applies only to agents`));
    expect(refusal, `'${key}' must be refused for a terminal`).toBeDefined();
    expect(refusal).toContain("terminals.dev");
    expect(refusal).toContain("Agent Studio");
  });

  it("no longer points at the retired inline shape", () => {
    // The old text said "declare it under agents: with kind: agent" — advice the product refuses,
    // which is the failure mode this door exists to stop.
    const { errors } = parseConfig("terminals:\n  dev:\n    cmd: npm run dev\n    soul: true\n    verify: npm test\n");
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error).not.toContain("with kind: agent");
  });

  it("refuses the same keys under agents: when the entry declares kind: terminal", () => {
    const { errors } = parseConfig("agents:\n  dev:\n    cmd: npm run dev\n    kind: terminal\n    worktree: true\n");
    const refusal = errors.find((error) => error.includes("'worktree' applies only to agents"));
    expect(refusal).toContain("agents.dev");
    expect(refusal).toContain("Agent Studio");
  });

  it("still accepts a generic process with the keys a terminal really has", () => {
    const { config, errors } = parseConfig(
      "terminals:\n  dev:\n    cmd: npm run dev\n    autostart: true\n    watch: src/**\n    restart: on-crash\n    attention: true\n    cwd: ./sub\n",
    );
    expect(errors).toEqual([]);
    expect(config?.agents.dev.kind).toBe("terminal");
    expect(config?.agents.dev.autostart).toBe(true);
    expect(config?.agents.dev.restart).toBe("on-crash");
  });
});

describe("door: agents: in tachyon.yml (already correct — kept verbatim)", () => {
  it("refuses an inline definition and names Agent Studio", () => {
    const { errors } = parseProfileAwareConfigSyntax("agents:\n  rev:\n    cmd: claude\n");
    expect(errors).toEqual([
      "agents.rev: inline agent definitions are no longer supported; create or edit the canonical agent in Agent Studio",
    ]);
  });

  it("accepts a profile pointer", () => {
    const { errors } = parseProfileAwareConfigSyntax("agents:\n  rev:\n    profile: .tachyon/agents/rev/agent.yml\n");
    expect(errors).toEqual([]);
  });
});

describe("door: Terminal Studio commit", () => {
  const terminalForm = (cmd: string): FormState => ({ ...blankTerminalFields(), name: "dev", cmd } as FormState);

  it.each(["claude", "codex", "grok", "pi", "npx claude", "/usr/local/bin/codex"])(
    "refuses the attested runtime command %s",
    (cmd) => {
      const issue = validateForm(terminalForm(cmd), []).find((i) => i.code === "terminal-cmd-is-attested-runtime");
      expect(issue, `${cmd} must be refused by Terminal Studio`).toBeDefined();
      expect(issue?.blocking).toBe(true);
    },
  );

  it("accepts a generic command", () => {
    for (const cmd of ["npm run dev", "bash", "cargo run", "python main.py"]) {
      expect(validateForm(terminalForm(cmd), []).some((i) => i.code === "terminal-cmd-is-attested-runtime")).toBe(false);
    }
  });

  it("does not refuse a runtime Tachyon does not attest — that entry has no agent door yet", () => {
    // `opencode`/`gemini` are resumable but unattested (SDD 478 M1): Agent Studio cannot mint a
    // canonical profile for them, so sending an author there would be a dead end.
    for (const cmd of ["opencode", "gemini", "qwen"]) {
      expect(validateForm(terminalForm(cmd), []).some((i) => i.code === "terminal-cmd-is-attested-runtime")).toBe(false);
    }
  });
});

describe("door: tachyon.init scaffold", () => {
  const project = (over: Partial<DetectedProject> = {}): DetectedProject =>
    ({ files: [], installedClis: ["claude"], ...over } as DetectedProject);

  it("emits a config the product actually loads", () => {
    // It did not: Init wrote an inline `agents:` entry, which the canonical loader refuses — the
    // first config Tachyon generated could not be loaded at all.
    for (const p of [
      project(),
      project({ files: ["package.json"], packageJson: { scripts: { dev: "vite", test: "jest" } } } as Partial<DetectedProject>),
      project({ files: ["Cargo.toml"] }),
      project({ installedClis: [] }),
    ]) {
      const yaml = buildStarterYaml(p);
      expect(parseProfileAwareConfigSyntax(yaml).errors, yaml).toEqual([]);
    }
  });

  it("emits terminals: for generic commands and points at Agent Studio for agents", () => {
    const yaml = buildStarterYaml(project({ files: ["package.json"], packageJson: { scripts: { dev: "vite" } } } as Partial<DetectedProject>));
    expect(yaml).toContain("terminals:");
    expect(yaml).toContain("npm run dev");
    expect(yaml).toContain("Agent Studio");
    expect(yaml).not.toMatch(/^agents:/m);
  });
});
