import { describe, it, expect } from "vitest";
import {
  asAgent,
  parseConfig,
  ATTENTION_DEFAULT_SILENCE_SEC,
  type AgentEntry,
  type ManagedEntryDef,
  type TerminalEntry,
} from "@tachyon/engine/config/loadConfig.js";

/**
 * SDD 478 M2 — `ManagedEntryDef` is a discriminated union, so an agent-only capability on a terminal
 * is a COMPILE error rather than something a validator has to remember to reject. Before the split,
 * seventeen agent-only fields were structurally present on every terminal and only five were refused;
 * `worktree`, `branch`, `worktreeSetup`, `verify` and `harness` were declarable and silently unread.
 *
 * The `@ts-expect-error` lines below are the mechanical check: each one FAILS THE BUILD if the
 * property ever becomes representable on the Terminal arm again, because tsc reports an unused
 * expect-error directive. They are not runtime assertions and cannot rot into passing silently.
 */
describe("ManagedEntry union — agent-only capabilities are unrepresentable on a Terminal (SDD 478 M2)", () => {
  const terminal: TerminalEntry = {
    kind: "terminal",
    cmd: "npm run dev",
    autostart: false,
    watch: [],
    attention: { enabled: false, silenceSec: ATTENTION_DEFAULT_SILENCE_SEC, patterns: [] },
    restart: "never",
  };

  it("does not type-check an agent-only field on the Terminal arm", () => {
    // @ts-expect-error a terminal has no isolated harness
    terminal.harness = { inherit: "none" };
    // @ts-expect-error a terminal has no worktree
    terminal.worktree = true;
    // @ts-expect-error a terminal has no branch
    terminal.branch = "tachyon/x";
    // @ts-expect-error a terminal has no worktree setup
    terminal.worktreeSetup = ["npm ci"];
    // @ts-expect-error a terminal has no verify gate
    terminal.verify = "npm test";
    // @ts-expect-error a terminal has no transcript to isolate
    terminal.isolate = "transcript";
    // @ts-expect-error a terminal receives no brief
    terminal.instructions = "be helpful";
    // @ts-expect-error ownership can only target agents
    terminal.subagents = ["child"];
    // @ts-expect-error a terminal is never backed by a canonical profile
    terminal.profileLifecycle = { enabled: true, agentId: "x", canonicalSha256: "y", authorityRevision: "r" };
    expect(terminal.kind).toBe("terminal");
  });

  it("reaches an agent-only capability only through the narrowing", () => {
    const entry: ManagedEntryDef = terminal;
    // @ts-expect-error the union itself grants nothing — narrowing is the only way in
    entry.harness;
    expect(asAgent(entry)).toBeUndefined();

    const agent: AgentEntry = { ...terminal, kind: "agent", harness: { inherit: "none" } };
    expect(asAgent(agent)?.harness).toEqual({ inherit: "none" });
  });

  it("parses an agent's declared capabilities onto the Agent arm", () => {
    const { config, errors } = parseConfig(
      "agents:\n  rev:\n    cmd: claude\n    worktree: true\n    harness: {}\n",
    );
    expect(errors).toEqual([]);
    const agent = asAgent(config?.agents.rev);
    expect(agent?.worktree).toBe(true);
    expect(agent?.harness).toEqual({ inherit: "workspace" });
  });

  it("parses a terminal with no agent-only property on it at all", () => {
    // `worktree`, `branch`, and `worktreeSetup` were the load-bearing finding of the SDD 478
    // inventory: declarable on a terminal, never read, never refused — validation that drifted per
    // field. The union removed the field, so a parsed terminal cannot carry one; M6 then made
    // DECLARING one a refusal rather than a silent drop (failClosedDoors.test.ts owns those cases,
    // which is why this one declares none — a refused config parses to no entry to inspect).
    const { config, errors } = parseConfig("terminals:\n  dev:\n    cmd: npm run dev\n    autostart: true\n");
    expect(errors).toEqual([]);
    const dev = config?.agents.dev;
    expect(dev?.kind).toBe("terminal");
    expect(asAgent(dev)).toBeUndefined();
    for (const key of ["worktree", "branch", "worktreeSetup", "verify", "harness", "instructions"]) {
      expect(dev, `terminal must not carry '${key}'`).not.toHaveProperty(key);
    }
  });

  it("reports agent-only terminal keys through the unknown-key diagnostic", () => {
    const { warnings } = parseConfig(
      "terminals:\n  dev:\n    cmd: npm run dev\n    harness: {}\n",
    );
    expect(warnings.some((error) => error.includes("unknown key 'harness'") && error.includes("Agent Studio"))).toBe(true);
  });
});
