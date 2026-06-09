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
});
