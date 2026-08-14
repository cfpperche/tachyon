import { describe, expect, it } from "vitest";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { LEGACY_AGENTS_BLOCK_WARNING, parseProfileAwareConfigSyntax } from "@tachyon/engine/config/agentProfileConfigLoader.js";
import { validateTerminalForm, type FormState } from "@tachyon/engine/webview/formLogic.js";
import { blankTerminalFields } from "../../packages/webview-ui/src/webview/terminal-studio-shell/domain.js";
import { buildStarterYaml, type DetectedProject } from "../../apps/vscode-extension/src/init/initLogic.js";

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
  ["worktree", "    worktree: true\n"],
  ["branch", "    branch: tachyon/dev\n"],
  ["worktreeSetup", "    worktreeSetup: npm ci\n"],
  ["harness", "    harness: {}\n"],
  ["isolate", "    isolate: transcript\n"],
  ["subagents", "    subagents: [child]\n"],
];

describe("door: terminals: in tachyon.yml", () => {
  it.each(AGENT_ONLY_KEYS)("reports '%s' as an unknown terminal key and names where the entry belongs", (key, yaml) => {
    const { warnings } = parseConfig(`terminals:\n  dev:\n    cmd: npm run dev\n${yaml}`);
    const refusal = warnings.find((error) => error.includes(`unknown key '${key}'`));
    expect(refusal, `'${key}' must be unknown for a terminal`).toBeDefined();
    expect(refusal).toContain("terminals.dev");
    expect(refusal).toContain("Agent Studio");
  });

  it("no longer points at the retired inline shape", () => {
    // The old text said "declare it under agents: with kind: agent" — advice the product refuses,
    // which is the failure mode this door exists to stop.
    const { warnings } = parseConfig("terminals:\n  dev:\n    cmd: npm run dev\n    worktree: true\n");
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) expect(warning).not.toContain("with kind: agent");
  });

  it("does not let direct parseConfig callers turn an agent projection into a terminal", () => {
    const { config, warnings } = parseConfig("agents:\n  dev:\n    cmd: npm run dev\n    kind: terminal\n    worktree: true\n");
    expect(config?.agents.dev).toMatchObject({ kind: "agent", worktree: true });
    expect(warnings).toEqual([]);
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

/**
 * t-ae221c — this door MOVED rather than closing. `agents:` used to be refused when it held anything
 * but a canonical pointer; the roster is `.tachyon/agents/` now, so nothing under `agents:` can
 * declare an agent whatever it says. The fail-closed property is therefore stronger than the refusal
 * it replaces — an inline definition is not rejected, it is unreachable — and the read stays
 * forgiving (t-48dd8d) so the file a human already wrote keeps loading.
 */
describe("door: agents: in tachyon.yml (retired, and inert)", () => {
  it.each([
    ["an inline definition", "agents:\n  rev:\n    cmd: claude\n"],
    ["a canonical pointer", "agents:\n  rev:\n    profile: .tachyon/agents/rev/agent.yml\n"],
    ["a shape nothing ever wrote", "agents:\n  rev:\n    anything: at all\n"],
  ])("loads with a warning and declares no agent for %s", (_label, yaml) => {
    const { errors, warnings, config } = parseProfileAwareConfigSyntax(yaml);
    expect(errors).toEqual([]);
    expect(warnings).toContain(LEGACY_AGENTS_BLOCK_WARNING);
    expect(config?.agents).toEqual({});
  });
});

describe("door: Terminal Studio commit", () => {
  const terminalForm = (cmd: string): FormState => ({ ...blankTerminalFields(), name: "dev", cmd } as FormState);

  it.each(["claude", "codex", "grok", "pi", "npx claude", "/usr/local/bin/codex"])(
    "refuses the attested runtime command %s",
    (cmd) => {
      const issue = validateTerminalForm(terminalForm(cmd), []).find((i) => i.code === "terminal-cmd-is-attested-runtime");
      expect(issue, `${cmd} must be refused by Terminal Studio`).toBeDefined();
      expect(issue?.blocking).toBe(true);
    },
  );

  it("accepts a generic command", () => {
    for (const cmd of ["npm run dev", "bash", "cargo run", "python main.py"]) {
      expect(validateTerminalForm(terminalForm(cmd), []).some((i) => i.code === "terminal-cmd-is-attested-runtime")).toBe(false);
    }
  });

  it("does not refuse a runtime Tachyon does not attest — that entry has no agent door yet", () => {
    // `opencode`/`gemini` are resumable but unattested (SDD 478 M1): Agent Studio cannot mint a
    // canonical profile for them, so sending an author there would be a dead end.
    for (const cmd of ["opencode", "gemini", "qwen"]) {
      expect(validateTerminalForm(terminalForm(cmd), []).some((i) => i.code === "terminal-cmd-is-attested-runtime")).toBe(false);
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
