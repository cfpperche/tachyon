import { describe, it, expect } from "vitest";
import { classifyTail, compileExtraPatterns, TAIL_WINDOW } from "../../src/attention/patterns.js";
import {
  AttentionMonitor,
  PATTERN_STABLE_MS,
  type AttentionSettings,
  type AgentAttention,
} from "../../src/attention/AttentionMonitor.js";
import { parseConfig } from "../../src/config/loadConfig.js";

// Captured verbatim from the spec 186 spike — a real Claude Code trust prompt pane.
const CLAUDE_TRUST_PROMPT = `
────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:
 /tmp
 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`;

describe("classifyTail", () => {
  it("matches the real Claude Code trust prompt", () => {
    const match = classifyTail(CLAUDE_TRUST_PROMPT);
    expect(match).not.toBeNull();
  });

  it("matches common shell prompts", () => {
    expect(classifyTail("installing...\nContinue? [y/n] ")).not.toBeNull();
    expect(classifyTail("sudo password: ")).not.toBeNull();
    expect(classifyTail("Do you want to run this command?")).not.toBeNull();
    expect(classifyTail("Are you sure you want to delete 3 files?")).not.toBeNull();
  });

  it("does not match ordinary output", () => {
    expect(classifyTail("compiled successfully in 1.2s\nwaiting for changes")).toBeNull();
    expect(classifyTail("$ npm run dev\n> vite dev\nserver running at :3000")).toBeNull();
    expect(classifyTail("")).toBeNull();
  });

  it("only scans the tail window", () => {
    const oldPrompt = "Continue? [y/n]";
    const filler = Array.from({ length: TAIL_WINDOW + 2 }, (_, i) => `log line ${i}`).join("\n");
    expect(classifyTail(`${oldPrompt}\n${filler}`)).toBeNull();
  });

  it("supports per-agent extra patterns and rejects invalid regexes", () => {
    const extras = compileExtraPatterns(["AGUARDANDO RESPOSTA"]);
    expect(classifyTail("...\naguardando resposta do operador", extras)).not.toBeNull();
    expect(() => compileExtraPatterns(["[unclosed"])).toThrow("invalid attention pattern");
  });
});

interface FakeAgent {
  content: string;
  cpu: number | null;
  settings: AttentionSettings;
}

function makeMonitor(agents: Record<string, FakeAgent>) {
  let now = 1_000_000;
  const events: Array<{ agent: string; state: string; notify: boolean }> = [];
  const monitor = new AttentionMonitor(
    {
      runningAgents: async () => Object.keys(agents),
      capturePane: async (a) => agents[a].content,
      cpuTicks: async (a) => agents[a].cpu,
      settingsOf: (a) => agents[a].settings,
      now: () => now,
    },
    (agent, att: AgentAttention, notify) => events.push({ agent, state: att.state, notify }),
  );
  return {
    monitor,
    events,
    agents,
    advance: async (ms: number) => {
      now += ms;
      await monitor.tick();
    },
  };
}

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

describe("AttentionMonitor", () => {
  it("stable pane + prompt pattern => needs-input, toast once per episode", async () => {
    const f = makeMonitor({ claude: { content: "Continue? [y/n]", cpu: 100, settings: SETTINGS } });
    await f.advance(0); // baseline snapshot
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
    expect(f.monitor.stateOf("claude")?.matchedLine).toContain("[y/n]");
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);

    // further ticks: no extra toast for the same episode
    await f.advance(3000);
    await f.advance(3000);
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);
    expect(f.monitor.needsInputCount()).toBe(1);
  });

  it("activity resets the episode; a new identical prompt toasts again", async () => {
    const f = makeMonitor({ claude: { content: "Continue? [y/n]", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");

    f.agents.claude.content = "user answered, working...";
    await f.advance(3000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
    expect(f.monitor.needsInputCount()).toBe(0);

    f.agents.claude.content = "Continue? [y/n]";
    await f.advance(3000); // new content -> reset
    await f.advance(PATTERN_STABLE_MS + 100); // stable again -> new episode
    expect(f.events.filter((e) => e.notify)).toHaveLength(2);
  });

  it("silence + flat cpu => idle; advancing cpu means thinking, not idle", async () => {
    const f = makeMonitor({ quietagent: { content: "$ ", cpu: 500, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(4000); // 4s stable < silenceSec
    expect(f.monitor.stateOf("quietagent")?.state).toBe("working");
    await f.advance(5000); // 9s stable >= 8s, cpu flat (first read becomes baseline)
    await f.advance(3000); // confirm with flat cpu
    expect(f.monitor.stateOf("quietagent")?.state).toBe("idle");

    // CPU starts advancing with the same frozen pane -> back to working
    f.agents.quietagent.cpu = 900;
    await f.advance(3000);
    expect(f.monitor.stateOf("quietagent")?.state).toBe("working");
  });

  it("null cpu (no /proc) degrades to stability-only idle", async () => {
    const f = makeMonitor({ mac: { content: "$ ", cpu: null, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("mac")?.state).toBe("idle");
  });

  it("disabled agents are not tracked; stopped agents are dropped", async () => {
    const f = makeMonitor({
      dev: { content: "listening :3000", cpu: 1, settings: { ...SETTINGS, enabled: false } },
      claude: { content: "hi", cpu: 1, settings: SETTINGS },
    });
    await f.advance(0);
    expect(f.monitor.stateOf("dev")).toBeUndefined();
    expect(f.monitor.stateOf("claude")).toBeDefined();

    delete (f.agents as Record<string, FakeAgent>).claude;
    await f.advance(3000);
    expect(f.monitor.stateOf("claude")).toBeUndefined();
  });

  it("pattern match needs stability — a redrawing pane never fires", async () => {
    const f = makeMonitor({ tui: { content: "Continue? [y/n] ⠋", cpu: 10, settings: SETTINGS } });
    await f.advance(0);
    for (let i = 0; i < 5; i++) {
      f.agents.tui.content = `Continue? [y/n] ${"⠙⠹⠸⠼⠧"[i]}`; // spinner keeps changing (≠ initial ⠋)
      await f.advance(3000);
    }
    expect(f.monitor.stateOf("tui")?.state).toBe("working");
    expect(f.events.filter((e) => e.notify)).toHaveLength(0);
  });
});

describe("attention config", () => {
  it("defaults: on for kind=agent, off for kind=terminal (inferred)", () => {
    const { config } = parseConfig(
      "agents:\n  claude:\n    cmd: claude\n  dev:\n    cmd: npm run dev\n    watch: 'src/**'\n",
    );
    expect(config?.agents.claude.attention).toEqual({ enabled: true, silenceSec: 8, patterns: [] });
    expect(config?.agents.dev.attention.enabled).toBe(false); // npm dev server infers terminal
  });

  it("kind inference: AI CLIs are agents, everything else terminals; explicit kind wins", () => {
    const { config } = parseConfig(
      [
        "agents:",
        "  a: {cmd: claude}",
        "  b: {cmd: 'npx codex --yolo'}",
        "  c: {cmd: /usr/local/bin/gemini}",
        "  d: {cmd: npm run dev}",
        "  e: {cmd: bash}",
        "  f: {cmd: ./meu-bot.sh, kind: agent}",
        "  g: {cmd: claude, kind: terminal}",
        "",
      ].join("\n"),
    );
    expect(config?.agents.a.kind).toBe("agent");
    expect(config?.agents.b.kind).toBe("agent"); // through npx
    expect(config?.agents.c.kind).toBe("agent"); // full path
    expect(config?.agents.d.kind).toBe("terminal");
    expect(config?.agents.e.kind).toBe("terminal");
    expect(config?.agents.f.kind).toBe("agent"); // explicit override
    expect(config?.agents.g.kind).toBe("terminal"); // explicit override beats inference
    expect(config?.agents.f.attention.enabled).toBe(true); // kind drives the default
    expect(config?.agents.g.attention.enabled).toBe(false);
    expect(parseConfig("agents:\n  a:\n    cmd: x\n    kind: robot\n").errors[0]).toContain("kind");
  });

  it("boolean and object forms parse; watched agent can opt back in", () => {
    const { config } = parseConfig(
      [
        "agents:",
        "  a:",
        "    cmd: x",
        "    attention: false",
        "  b:",
        "    cmd: y",
        "    watch: 'z/**'",
        "    attention:",
        "      silenceSec: 30",
        "      patterns: ['CUSTOM PROMPT']",
        "",
      ].join("\n"),
    );
    expect(config?.agents.a.attention.enabled).toBe(false);
    expect(config?.agents.b.attention).toEqual({ enabled: true, silenceSec: 30, patterns: ["CUSTOM PROMPT"] });
  });

  it("rejects invalid attention shapes with path-qualified errors", () => {
    expect(parseConfig("agents:\n  a:\n    cmd: x\n    attention: 5\n").errors[0]).toContain("agents.a.attention");
    expect(
      parseConfig("agents:\n  a:\n    cmd: x\n    attention:\n      silenceSec: 0\n").errors[0],
    ).toContain("silenceSec");
    expect(
      parseConfig("agents:\n  a:\n    cmd: x\n    attention:\n      nope: 1\n").errors[0],
    ).toContain("unknown key 'nope'");
  });
});
