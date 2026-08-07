import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifyTail, classifyAttentionTail, compileExtraPatterns, parseRateLimitInfo, TAIL_WINDOW } from "../../src/attention/patterns.js";
import {
  AttentionMonitor,
  PATTERN_STABLE_MS,
  THROTTLE_NOTIFY_DELAY_MS,
  MAX_WORKING_STALL_MS,
  extractAwaitingHumanQuestion,
  type AttentionSettings,
  type AgentAttention,
} from "../../src/attention/AttentionMonitor.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { LifecycleMonitor } from "../../src/agents/LifecycleMonitor.js";

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

describe("classifyAttentionTail (spec 306)", () => {
  it("classifies a provider-error line as kind=error", () => {
    const m = classifyAttentionTail("Error: rate limit exceeded, please try again later");
    expect(m).not.toBeNull();
    expect(m?.kind).toBe("error");
  });

  it("does not misfire on a bare 429/529 or unqualified API Error (false-positive guard)", () => {
    expect(classifyAttentionTail("server listening on port 429")).toBeNull();
    expect(classifyAttentionTail("build 529 passed")).toBeNull();
    expect(classifyAttentionTail("API Error: file not found")).toBeNull();
    expect(classifyAttentionTail('{"type":"error","error":{"name":"APIError","data":{"message":"Incorrect API key provided","statusCode":401}}}')).toBeNull();
  });

  it("a genuine prompt still classifies as kind=prompt", () => {
    const m = classifyAttentionTail("Continue? [y/n]");
    expect(m?.kind).toBe("prompt");
  });

  it("bottom-most match wins regardless of category — a newer prompt beats an older error", () => {
    const pane = ["Rate limit hit, retrying...", "some other log line", "Switch provider? [y/n]"].join("\n");
    const m = classifyAttentionTail(pane);
    expect(m?.kind).toBe("prompt");
    expect(m?.line).toContain("[y/n]");
  });

  it("an older prompt does not beat a newer error", () => {
    const pane = ["Continue? [y/n]", "some other log line", "rate limit exceeded"].join("\n");
    const m = classifyAttentionTail(pane);
    expect(m?.kind).toBe("error");
  });

  it("a single line matching both categories ties to error", () => {
    const m = classifyAttentionTail("Rate limit exceeded — continue? [y/n]");
    expect(m?.kind).toBe("error");
  });

  it("requires error context for usage-limit mentions (t-a1d121)", () => {
    expect(classifyAttentionTail("You have 3 usage limit resets remaining today")).toBeNull();
    expect(classifyAttentionTail("You have 3 usage limit resets available")).toBeNull();
    expect(classifyAttentionTail("Usage limit reached. Please try again later")?.kind).toBe("error");
    expect(classifyAttentionTail("Error: hit usage limit for this provider")?.kind).toBe("error");
  });

  it("classifies opencode JSON APIError 429/5xx status lines as provider errors", () => {
    expect(classifyAttentionTail('{"type":"error","error":{"name":"APIError","data":{"message":"rate limit exceeded","statusCode":429}}}')?.kind).toBe("error");
    expect(classifyAttentionTail('{"type":"error","error":{"name":"APIError","data":{"message":"upstream failed","statusCode":500}}}')?.kind).toBe("error");
  });

  it("parses real runtime rate-limit reset hints", () => {
    const now = new Date("2026-07-06T14:00:00-03:00").getTime();
    const claude = parseRateLimitInfo("Claude usage limit reached. Your 5-hour limit resets at 3pm.", now);
    expect(claude).toMatchObject({ runtime: "claude", scope: "5h" });
    expect(new Date(claude?.resetAt ?? 0).getHours()).toBe(15);

    const codex = parseRateLimitInfo("You've reached your weekly usage limit. Please try again in 2 hours 15 minutes.", now);
    expect(codex).toMatchObject({ scope: "weekly", resetAt: now + 135 * 60_000 });
  });
});

describe("classifyAttentionTail — stall detection (t-d65be2)", () => {
  it("classifies the real incident text as kind=stall", () => {
    const m = classifyAttentionTail("API Error: Connection closed mid-response");
    expect(m?.kind).toBe("stall");
  });

  it("classifies the captured Claude server-error mid-response line as kind=stall", () => {
    const line = "API Error: Server error mid-response. The response above may be incomplete.";
    expect(classifyAttentionTail(line)).toMatchObject({ kind: "stall", line });
  });

  it("classifies the real Claude CLI pane line, bullet-prefixed, as kind=stall", () => {
    const line = "⏺ API Error: Server error mid-response. The response above may be incomplete.";
    expect(classifyAttentionTail(line)).toMatchObject({ kind: "stall", line });
  });

  it("classifies other transport-drop signatures as kind=stall", () => {
    expect(classifyAttentionTail("Error: socket hang up")?.kind).toBe("stall");
    expect(classifyAttentionTail("FetchError: request failed, ECONNRESET")?.kind).toBe("stall");
  });

  it("does not misfire on an unqualified 'API Error' (false-positive guard)", () => {
    expect(classifyAttentionTail("API Error: file not found")).toBeNull();
    expect(classifyAttentionTail("connection closed the ticket")).toBeNull();
    expect(classifyAttentionTail('The agent wrote: "API Error: Server error mid-response. The response above may be incomplete."')).toBeNull();
  });

  it("classifies the captured opencode UnknownError message as a turn-ending runtime error", () => {
    const pane = [
      "Error: {",
      '  "name": "UnknownError",',
      '  "data": {',
      '    "message": "Unexpected server error. Check server logs for details.",',
      '    "ref": "err_7b6cbec9"',
      "  }",
      "}",
    ].join("\n");
    expect(classifyAttentionTail(pane)).toMatchObject({
      kind: "stall",
      line: '"message": "Unexpected server error. Check server logs for details.",',
    });
  });

  it("a rate-limit error still wins as kind=error, not stall — they use different recovery paths", () => {
    const m = classifyAttentionTail("Error: rate limit exceeded, please try again later");
    expect(m?.kind).toBe("error");
  });
});

interface FakeAgent {
  content: string;
  escaped?: string;
  cpu: number | null;
  settings: AttentionSettings;
  cmd?: string;
  awaitingHumanOnIdle?: boolean;
}

function makeMonitor(agents: Record<string, FakeAgent>) {
  let now = 1_000_000;
  const events: Array<{ agent: string; state: string; notify: boolean; attention: AgentAttention }> = [];
  const monitor = new AttentionMonitor(
    {
      runningAgents: async () => Object.keys(agents),
      capturePane: async (a) => agents[a].content,
      capturePaneEscaped: async (a) => agents[a].escaped ?? agents[a].content,
      cpuTicks: async (a) => agents[a].cpu,
      settingsOf: (a) => agents[a].settings,
      initialTurnState: () => false,
      cmdOf: (a) => agents[a].cmd ?? null,
      awaitingHumanOnIdle: (a) => agents[a].awaitingHumanOnIdle ?? false,
      now: () => now,
    },
    (agent, att: AgentAttention, notify) => events.push({ agent, state: att.state, notify, attention: att }),
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
  it("t-8168a7 review: reload seeds a finished stationary pane from durable turn evidence", async () => {
    let now = 1_000_000;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["reloaded"],
      capturePane: async () => "prior assistant output\n$ ",
      cpuTicks: async () => null,
      settingsOf: () => SETTINGS,
      initialTurnState: () => true,
      now: () => now,
    });

    await monitor.tick(); // first observation after extension reload: already stationary
    now += 9_000;
    await monitor.tick();

    expect(monitor.stateOf("reloaded")?.state).toBe("idle");
    expect(monitor.hasStartedTurn("reloaded")).toBe(true);
    expect(monitor.stateOf("reloaded")?.unseen).toBe(true);
  });

  it("t-8168a7: distinguishes an untouched prompt from a turn that later finishes", async () => {
    const f = makeMonitor({ claude: { content: "$ ", cpu: null, settings: SETTINGS } });
    await f.advance(0); // untouched prompt baseline
    await f.advance(9_000);

    expect(f.monitor.stateOf("claude")?.state).toBe("idle");
    expect(f.monitor.hasStartedTurn("claude")).toBe(false);
    expect(f.monitor.stateOf("claude")?.unseen).toBe(false);

    f.agents.claude.content = "working on the task";
    await f.advance(1);
    expect(f.monitor.hasStartedTurn("claude")).toBe(true);

    await f.advance(9_000);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");
    expect(f.monitor.stateOf("claude")?.unseen).toBe(true);
  });

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

  it("exposes output stability metadata and changes episodeKey on output", async () => {
    const f = makeMonitor({ claude: { content: "first", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    const first = f.monitor.stateOf("claude");
    expect(first).toMatchObject({ contentSince: 1_000_000, outputStableSince: 1_000_000 });
    expect(first?.episodeKey).toBeDefined();

    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.episodeKey).toBe(first?.episodeKey);

    f.agents.claude.content = "second";
    await f.advance(1000);
    const second = f.monitor.stateOf("claude");
    expect(second?.outputStableSince).toBe(1_002_000);
    expect(second?.episodeKey).not.toBe(first?.episodeKey);
  });

  it("silence + flat cpu => idle; sustained cpu utilization means thinking, not idle", async () => {
    const f = makeMonitor({ quietagent: { content: "$ ", cpu: 500, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(4000); // 4s stable < silenceSec
    expect(f.monitor.stateOf("quietagent")?.state).toBe("working");
    await f.advance(5000); // 9s stable >= 8s, cpu flat (first read becomes baseline)
    await f.advance(3000); // confirm with flat cpu
    expect(f.monitor.stateOf("quietagent")?.state).toBe("idle");

    // CPU starts advancing above the utilization threshold with the same frozen pane -> back to working
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

  it("sporadic 1-2 jiffie CPU blips do not force idle panes back to working (t-285503)", async () => {
    const f = makeMonitor({ claude: { content: "done", cpu: 10, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(9000); // first stable CPU read establishes the baseline
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");

    f.agents.claude.cpu = 11;
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");

    f.agents.claude.cpu = 13;
    await f.advance(2000);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(0);
  });

  it("raw pane text changes, including timer redraws, reset output stability and count as activity", async () => {
    const f = makeMonitor({ tui: { content: "done\nWorked for 1s", cpu: 10, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("tui")?.state).toBe("idle");

    f.agents.tui.content = "done\nWorked for 10s";
    await f.advance(1000);
    expect(f.monitor.stateOf("tui")).toMatchObject({ state: "working", outputStableSince: 1_010_000 });
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(1);
  });

  it("human typing confined to a runtime composer does not mark an idle agent working (t-f30324)", async () => {
    const f = makeMonitor({ codex: { content: "done\n\n❯ ", cpu: 10, settings: SETTINGS, cmd: "codex" } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("codex")).toMatchObject({ state: "idle", composerOccupied: false });

    f.agents.codex.content = "done\n\n❯ h";
    await f.advance(1000);
    f.agents.codex.content = "done\n\n❯ hello";
    await f.advance(1000);

    expect(f.monitor.stateOf("codex")).toMatchObject({ state: "idle", outputStableSince: 1_000_000, composerOccupied: true });
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(0);
  });

  it("SDD 403: Pi framed editor tracks empty, single-line and multi-line drafts as composer-only changes", async () => {
    const frame = "─".repeat(80);
    const pane = (editor: string) => `done\n${frame}\n${editor}\n${frame}\n~/repo (main)\n0.0%/4.1k (auto) measure`;
    const f = makeMonitor({ pi: { content: pane(" "), cpu: 10, settings: SETTINGS, cmd: "pi" } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("pi")).toMatchObject({ state: "idle", composerOccupied: false });

    f.agents.pi.content = pane("draft");
    await f.advance(1000);
    expect(f.monitor.stateOf("pi")).toMatchObject({ state: "idle", outputStableSince: 1_000_000, composerOccupied: true });

    f.agents.pi.content = pane("draft\nsecond line");
    await f.advance(1000);
    expect(f.monitor.stateOf("pi")).toMatchObject({ state: "idle", composerOccupied: true });
    expect(f.events.filter((event) => event.state === "working")).toHaveLength(0);
  });

  it("SDD 403: Pi output above the frame remains runtime activity and incomplete/oversized frames never guess", async () => {
    const frame = "─".repeat(80);
    const footer = `${frame}\n~/repo (main)\n0.0%/4.1k (auto) measure`;
    const f = makeMonitor({ pi: { content: `done\n${frame}\n \n${footer}`, cpu: 10, settings: SETTINGS, cmd: "pi" } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("pi")?.state).toBe("idle");

    f.agents.pi.content = `done\nnew assistant output\n${frame}\ndraft\n${footer}`;
    await f.advance(1000);
    expect(f.monitor.stateOf("pi")).toMatchObject({ state: "working", composerOccupied: true });

    await f.advance(9000);
    f.agents.pi.content = `done\n${frame}\n${Array.from({ length: 17 }, (_, i) => `line-${i}`).join("\n")}\n${footer}`;
    await f.advance(1000);
    expect(f.monitor.stateOf("pi")).toMatchObject({ state: "working", composerOccupied: false });
  });

  it("clears composerOccupied when a runtime composer draft is erased (t-f45313)", async () => {
    const f = makeMonitor({ claude: { content: "done\n\n> ", cpu: 10, settings: SETTINGS, cmd: "claude" } });
    await f.advance(0);
    await f.advance(9000);

    f.agents.claude.content = "done\n\n> draft";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")).toMatchObject({ state: "idle", composerOccupied: true });

    f.agents.claude.content = "done\n\n> ";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")).toMatchObject({ state: "idle", composerOccupied: false });
    expect(f.events.at(-1)).toMatchObject({ agent: "claude", state: "idle", notify: false });
  });

  it("does not let a residual shell counter hide an unsubmitted Claude draft (t-2b5db1)", async () => {
    const f = makeMonitor({
      claude: {
        content: "⏵⏵ accept edits on · 1 shell · ← for agents\n❯ instrução pendente",
        escaped: "\x1b[39m⏵⏵ accept edits on · 1 shell · ← for agents\n\x1b[39m❯ instrução pendente\x1b[0m",
        cpu: 10,
        settings: SETTINGS,
        cmd: "claude",
      },
    });
    await f.advance(0);
    await f.advance(9000); // stable silence establishes the CPU baseline
    await f.advance(1000); // residual shell is still present, but the human draft owns the composer

    expect(f.monitor.stateOf("claude")).toMatchObject({ state: "idle", composerOccupied: true });
  });

  it("output changes above the runtime composer still mark the agent working (t-f30324)", async () => {
    const f = makeMonitor({ codex: { content: "done\n\n❯ ", cpu: 10, settings: SETTINGS, cmd: "codex" } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("codex")?.state).toBe("idle");

    f.agents.codex.content = "done\nnew agent output\n\n❯ h";
    await f.advance(1000);

    expect(f.monitor.stateOf("codex")).toMatchObject({ state: "working", outputStableSince: 1_010_000 });
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(1);
  });

  it("composer-looking diffs without a runtime profile keep the raw content-diff behavior", async () => {
    const f = makeMonitor({ tui: { content: "done\n\n❯ ", cpu: 10, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("tui")?.state).toBe("idle");

    f.agents.tui.content = "done\n\n❯ h";
    await f.advance(1000);

    expect(f.monitor.stateOf("tui")).toMatchObject({ state: "working", outputStableSince: 1_010_000 });
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(1);
  });
});

describe("AttentionMonitor — provider throttle (spec 306)", () => {
  it("stable provider-error text => throttled (no notify yet — anti-spam delay hasn't elapsed)", async () => {
    const f = makeMonitor({ claude: { content: "Error: rate limit exceeded, please try again later", cpu: 100, settings: SETTINGS, cmd: "claude" } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");
    expect(f.monitor.stateOf("claude")?.matchedLine).toContain("rate limit");
    expect(f.monitor.stateOf("claude")?.rateLimit?.runtime).toBe("claude");
    expect(f.events.filter((e) => e.notify)).toHaveLength(0);
  });

  it("a newer bottom-most prompt beats an older error still in the tail (bottom-most-match rule)", async () => {
    const pane = ["Rate limit hit, retrying...", "some other log line", "Switch provider? [y/n]"].join("\n");
    const f = makeMonitor({ claude: { content: pane, cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
  });

  it("a transient throttle that self-resolves before the delay never notifies", async () => {
    const f = makeMonitor({ claude: { content: "overloaded, retrying...", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");

    f.agents.claude.content = "back to work";
    await f.advance(THROTTLE_NOTIFY_DELAY_MS / 2); // well before the anti-spam delay
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
    expect(f.events.filter((e) => e.notify)).toHaveLength(0);
  });

  it("a sustained throttle fires exactly one notify past the anti-spam delay, then never again for the same episode", async () => {
    const f = makeMonitor({ claude: { content: "overloaded, retrying...", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");
    expect(f.events.filter((e) => e.notify)).toHaveLength(0);

    await f.advance(THROTTLE_NOTIFY_DELAY_MS + 100);
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);
    expect(f.events.filter((e) => e.notify)[0].state).toBe("throttled");

    // further ticks past the threshold: no re-notify for the same episode
    await f.advance(5000);
    await f.advance(5000);
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);
  });

  it("an agent dropped mid-throttle never fires a stale sustained notify", async () => {
    const f = makeMonitor({ claude: { content: "overloaded, retrying...", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");

    delete (f.agents as Record<string, FakeAgent>).claude;
    await f.advance(THROTTLE_NOTIFY_DELAY_MS + 100);
    expect(f.monitor.stateOf("claude")).toBeUndefined();
    expect(f.events.filter((e) => e.notify)).toHaveLength(0);
  });
});

describe("AttentionMonitor — stall detection (t-d65be2)", () => {
  // A stall (turn-ending connection drop) reuses needs-input rather than a new state: the
  // existing machinery already pokes the parent once per episode (pokeParentOnNeedsInput,
  // t-8605be) with the matched line, and write_input's busy check (working/throttled only)
  // already leaves needs-input unblocked for a rescue — exactly what a stall needs.
  it("stable connection-drop text => needs-input, notifies immediately (not gated by the throttle anti-spam delay)", async () => {
    const f = makeMonitor({ claude: { content: "API Error: Connection closed mid-response", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
    expect(f.monitor.stateOf("claude")?.matchedLine).toContain("Connection closed");
    expect(f.events.filter((e) => e.notify)).toHaveLength(1); // immediate, unlike throttled
  });

  it("a stall does not re-notify on further ticks of the same episode", async () => {
    const f = makeMonitor({ claude: { content: "API Error: Connection closed mid-response", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    await f.advance(3000);
    await f.advance(3000);
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);
  });

  it("a rescue that types into the pane clears the stall on the next content change", async () => {
    const f = makeMonitor({ claude: { content: "API Error: Connection closed mid-response", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");

    f.agents.claude.content = "continuing...";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
  });
});

describe("AttentionMonitor — awaiting-human latch (t-35d95a)", () => {
  it("flagAwaitingHuman latches state+reason, is a no-op for an untracked agent, and does not touch AttentionState", async () => {
    const f = makeMonitor({ claude: { content: "$ ", cpu: 100, settings: SETTINGS } });
    f.monitor.flagAwaitingHuman("ghost", "should be a no-op"); // never ticked -> no snapshot yet
    expect(f.monitor.isAwaitingHuman("ghost")).toBe(false);

    await f.advance(0);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
    f.monitor.flagAwaitingHuman("claude", "ou queres ajustar o design antes?");

    const attention = f.monitor.stateOf("claude");
    expect(attention?.awaitingHuman).toBe(true);
    expect(attention?.awaitingHumanReason).toBe("ou queres ajustar o design antes?");
    expect(attention?.state).toBe("working"); // untouched — not a new AttentionState
    expect(f.monitor.awaitingHumanAgents()).toEqual(new Set(["claude"]));
  });

  it("fires the onChange notify exactly once per episode, even across repeated calls", async () => {
    const f = makeMonitor({ claude: { content: "$ ", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    f.monitor.flagAwaitingHuman("claude", "first reason");
    f.monitor.flagAwaitingHuman("claude", "updated reason");
    f.monitor.flagAwaitingHuman("claude", "updated again");

    const notifies = f.events.filter((e) => e.notify);
    expect(notifies).toHaveLength(1);
    expect(f.monitor.stateOf("claude")?.awaitingHumanReason).toBe("updated again"); // latest reason still latched
  });

  it("a composer-only change does NOT clear the latch (mirrors stalled's composer-exempt semantics, t-f30324)", async () => {
    const f = makeMonitor({ codex: { content: "done\n\n❯ ", cpu: 10, settings: SETTINGS, cmd: "codex" } });
    await f.advance(0);
    await f.advance(9000);
    expect(f.monitor.stateOf("codex")?.state).toBe("idle");
    f.monitor.flagAwaitingHuman("codex", "waiting on you");

    f.agents.codex.content = "done\n\n❯ hello"; // human typing in the composer only
    await f.advance(1000);
    expect(f.monitor.stateOf("codex")?.awaitingHuman).toBe(true);
    expect(f.monitor.stateOf("codex")?.awaitingHumanReason).toBe("waiting on you");
  });

  it("real agent output clears the latch automatically — the same point `stalled` clears (t-f30324)", async () => {
    const f = makeMonitor({ codex: { content: "done\n\n❯ ", cpu: 10, settings: SETTINGS, cmd: "codex" } });
    await f.advance(0);
    await f.advance(9000);
    f.monitor.flagAwaitingHuman("codex", "waiting on you");
    expect(f.monitor.stateOf("codex")?.awaitingHuman).toBe(true);

    f.agents.codex.content = "done\nnew agent output\n\n❯ h"; // output ABOVE the composer region
    await f.advance(1000);
    expect(f.monitor.stateOf("codex")?.awaitingHuman).toBe(false);
    expect(f.monitor.stateOf("codex")?.awaitingHumanReason).toBeUndefined();
    expect(f.monitor.awaitingHumanAgents().size).toBe(0);

    // the one-shot re-arms for a fresh episode after the clear.
    f.monitor.flagAwaitingHuman("codex", "again");
    expect(f.events.filter((e) => e.notify)).toHaveLength(2);
  });

  it("a recognized needs-input/error pattern does not clear the awaiting-human latch", async () => {
    const f = makeMonitor({ claude: { content: "working...", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    f.monitor.flagAwaitingHuman("claude", "waiting on you");

    f.agents.claude.content = "Continue? [y/n]";
    await f.advance(1000); // register the change (matchSince starts here)
    expect(f.monitor.stateOf("claude")?.awaitingHuman).toBe(true); // same-turn output is not the human response boundary
    await f.advance(PATTERN_STABLE_MS + 100); // stable past the debounce window -> needs-input
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
    expect(f.monitor.stateOf("claude")?.awaitingHuman).toBe(true);
  });

  it("answering a recognized needs-input prompt clears the awaiting-human latch on the next working edge", async () => {
    const f = makeMonitor({ claude: { content: "working...", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    f.monitor.flagAwaitingHuman("claude", "waiting on you");

    f.agents.claude.content = "Continue? [y/n]";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.awaitingHuman).toBe(true);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
    expect(f.monitor.stateOf("claude")?.awaitingHuman).toBe(true);

    f.agents.claude.content = "y\nresuming work";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
    expect(f.monitor.stateOf("claude")?.awaitingHuman).toBe(false);
    expect(f.monitor.stateOf("claude")?.awaitingHumanReason).toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ agent: "claude", state: "working", notify: false });
    expect(f.events.at(-1)?.attention.awaitingHuman).toBe(false);
  });
});

describe("AttentionMonitor — derived prose-question awaiting-human (t-10771a)", () => {
  it("extracts a bottom-of-pane prose question but ignores mechanical prompts", () => {
    expect(extractAwaitingHumanQuestion("I can do either path.\nWhich approach do you want me to take?")).toBe("Which approach do you want me to take?");
    expect(extractAwaitingHumanQuestion("Continue? [y/n]")).toBeUndefined();
    expect(extractAwaitingHumanQuestion("$ git status ?")).toBeUndefined();
  });

  it("auto-latches when an eligible agent goes idle on a prose question", async () => {
    const f = makeMonitor({
      grok: { content: "I found two reasonable fixes.\nShould I keep this minimal or expand coverage?", cpu: 0, settings: SETTINGS, awaitingHumanOnIdle: true },
    });
    await f.advance(0);
    await f.advance(9000);

    expect(f.monitor.stateOf("grok")).toMatchObject({
      state: "idle",
      awaitingHuman: true,
      awaitingHumanReason: "Should I keep this minimal or expand coverage?",
    });
    expect(f.events.filter((e) => e.notify && e.attention.awaitingHuman)).toHaveLength(1);
  });

  it("does not auto-latch ineligible agents, leaving ad-hoc/subagent noise to explicit tools", async () => {
    const f = makeMonitor({
      child: { content: "Can I delete the generated file?", cpu: 0, settings: SETTINGS, awaitingHumanOnIdle: false },
    });
    await f.advance(0);
    await f.advance(9000);

    expect(f.monitor.stateOf("child")).toMatchObject({ state: "idle", awaitingHuman: false });
    expect(f.events.some((e) => e.attention.awaitingHuman)).toBe(false);
  });
});

describe("AttentionMonitor — working heartbeat cap (t-d65be2 AGRAVANTE)", () => {
  it("advancing CPU with a frozen pane keeps 'working' up to the cap, then decays to idle regardless of CPU", async () => {
    const f = makeMonitor({ claude: { content: "frozen pane", cpu: 0, settings: SETTINGS } });
    await f.advance(0); // baseline snapshot, initial state defaults to "working"

    // First crossing of silenceSec has no prior CPU reading to compare against, so it always
    // establishes the baseline as idle (existing behavior — see "silence + flat cpu" above).
    await f.advance(9000);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");

    // CPU keeps ticking every round after that (simulates a wedged subprocess / retry loop)
    // while the pane itself never changes — before the incident fix this stayed "working"
    // indefinitely off that alone.
    let stableMs = 9000;
    const STEP = 5 * 60_000; // 5 min steps
    while (stableMs + STEP < MAX_WORKING_STALL_MS) {
      f.agents.claude.cpu = (f.agents.claude.cpu ?? 0) + 30_000;
      await f.advance(STEP);
      stableMs += STEP;
      expect(f.monitor.stateOf("claude")?.state).toBe("working");
    }

    // One more step crosses MAX_WORKING_STALL_MS — CPU is STILL advancing, but the heartbeat
    // cap must win: a pane frozen this long can't still be "working" (t-d65be2 AGRAVANTE).
    f.agents.claude.cpu = (f.agents.claude.cpu ?? 0) + 30_000;
    await f.advance(STEP);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle"); // never stuck in "working" forever
  });

  it("flat CPU still decays to idle well before the cap (unchanged existing behavior)", async () => {
    const f = makeMonitor({ quietagent: { content: "$ ", cpu: 500, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(9000);
    await f.advance(3000);
    expect(f.monitor.stateOf("quietagent")?.state).toBe("idle");
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
    expect(parseConfig("agents:\n  a:\n    cmd: x\n    kind: robot\n").warnings[0]).toContain("kind");
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
    expect(parseConfig("agents:\n  a:\n    cmd: x\n    attention: 5\n").warnings[0]).toContain("agents.a.attention");
    expect(
      parseConfig("agents:\n  a:\n    cmd: x\n    attention:\n      silenceSec: 0\n").warnings[0],
    ).toContain("silenceSec");
    expect(
      parseConfig("agents:\n  a:\n    cmd: x\n    attention:\n      nope: 1\n").warnings[0],
    ).toContain("unknown key 'nope'");
  });
});

describe("AttentionMonitor — compaction detection (spec 216)", () => {
  function makeCompactionMonitor(cmd: string) {
    let now = 1_000_000;
    const fired: string[] = [];
    const agent = { content: "working…" };
    const monitor = new AttentionMonitor(
      {
        runningAgents: async () => ["a"],
        capturePane: async () => agent.content,
        cpuTicks: async () => 100,
        settingsOf: () => SETTINGS,
        cmdOf: () => cmd,
        now: () => now,
      },
      undefined,
      (name) => fired.push(name),
    );
    return {
      fired,
      set: (c: string) => { agent.content = c; },
      advance: async (ms: number) => { now += ms; await monitor.tick(); },
    };
  }

  it("fires onCompaction once per banner episode, re-fires after it clears", async () => {
    const f = makeCompactionMonitor("claude");
    await f.advance(0); // baseline snapshot, no detection
    f.set("Compacting conversation history…");
    await f.advance(1000);
    expect(f.fired).toEqual(["a"]);
    f.set("Compacting conversation history…\n…summarizing"); // still showing → no re-fire
    await f.advance(1000);
    expect(f.fired).toEqual(["a"]);
    f.set("done — back to work"); // cleared
    await f.advance(1000);
    f.set("Compacting conversation history… (again)"); // a later compaction
    await f.advance(1000);
    expect(f.fired).toEqual(["a", "a"]);
  });

  it("never fires for a runtime without a detector (documented gap)", async () => {
    const f = makeCompactionMonitor("gemini -i x");
    await f.advance(0);
    f.set("Compacting conversation");
    await f.advance(1000);
    expect(f.fired).toEqual([]);
  });
});

describe("AttentionMonitor — selective capture via window activity (t-4ecf9a)", () => {
  function makeActivityMonitor(
    agents: Record<string, FakeAgent & { activity?: number | null }>,
    opts: { feedLive?: boolean } = {},
  ) {
    let now = 1_000_000;
    const captures: string[] = [];
    let feedLive = opts.feedLive ?? true;
    const monitor = new AttentionMonitor({
      runningAgents: async () => Object.keys(agents),
      capturePane: async (a) => {
        captures.push(a);
        return agents[a].content;
      },
      cpuTicks: async (a) => agents[a].cpu,
      settingsOf: (a) => agents[a].settings,
      cmdOf: (a) => agents[a].cmd ?? null,
      windowActivity: (a) => {
        if (!feedLive) return null;
        const v = agents[a].activity;
        return v === undefined ? null : v;
      },
      now: () => now,
    });
    return {
      monitor,
      captures,
      agents,
      setFeedLive: (live: boolean) => {
        feedLive = live;
      },
      advance: async (ms: number) => {
        now += ms;
        await monitor.tick();
      },
      now: () => now,
    };
  }

  it("skips capture when activity timestamp is unchanged (before silence)", async () => {
    const f = makeActivityMonitor({
      a: { content: "working…", cpu: 10, settings: SETTINGS, activity: 1000 },
    });
    await f.advance(0); // baseline capture
    expect(f.captures).toEqual(["a"]);

    await f.advance(1000); // same activity, under silenceSec
    await f.advance(1000);
    expect(f.captures).toEqual(["a"]); // no re-capture
    expect(f.monitor.stateOf("a")?.state).toBe("working");
  });

  it("captures when activity timestamp advances (output push)", async () => {
    const f = makeActivityMonitor({
      a: { content: "line1", cpu: 10, settings: SETTINGS, activity: 1000 },
    });
    await f.advance(0);
    f.captures.length = 0;

    f.agents.a.content = "line2";
    f.agents.a.activity = 1001;
    await f.advance(1000);
    expect(f.captures).toEqual(["a"]);
    expect(f.monitor.stateOf("a")?.state).toBe("working");
    expect(f.monitor.stateOf("a")?.episodeKey).toBeDefined();
  });

  it("confirmatory capture once when silence threshold is crossed, then skips", async () => {
    const f = makeActivityMonitor({
      a: { content: "done", cpu: null, settings: SETTINGS, activity: 50 },
    });
    await f.advance(0);
    f.captures.length = 0;

    // Still under silence (8s): skip
    await f.advance(5000);
    expect(f.captures).toEqual([]);

    // Cross silence: one confirmatory capture, then idle
    await f.advance(4000);
    expect(f.captures).toEqual(["a"]);
    expect(f.monitor.stateOf("a")?.state).toBe("idle");

    // Further ticks with same activity: no more captures
    f.captures.length = 0;
    await f.advance(3000);
    await f.advance(3000);
    expect(f.captures).toEqual([]);
    expect(f.monitor.stateOf("a")?.state).toBe("idle");
  });

  it("polls every tick when activity feed is down (engine fallback)", async () => {
    const f = makeActivityMonitor(
      { a: { content: "x", cpu: 1, settings: SETTINGS, activity: 10 } },
      { feedLive: false },
    );
    await f.advance(0);
    await f.advance(1000);
    await f.advance(1000);
    expect(f.captures).toEqual(["a", "a", "a"]);
  });

  it("falls back to full polling mid-run when feed goes down", async () => {
    const f = makeActivityMonitor({
      a: { content: "x", cpu: 1, settings: SETTINGS, activity: 10 },
    });
    await f.advance(0);
    f.captures.length = 0;
    await f.advance(1000);
    expect(f.captures).toEqual([]); // selective skip

    f.setFeedLive(false);
    await f.advance(1000);
    await f.advance(1000);
    expect(f.captures).toEqual(["a", "a"]);
  });

  it("only captures agents whose activity changed", async () => {
    const f = makeActivityMonitor({
      hot: { content: "a", cpu: 1, settings: SETTINGS, activity: 1 },
      cold: { content: "b", cpu: 1, settings: SETTINGS, activity: 1 },
    });
    await f.advance(0);
    f.captures.length = 0;

    f.agents.hot.content = "a2";
    f.agents.hot.activity = 2;
    await f.advance(1000);
    expect(f.captures).toEqual(["hot"]);
  });
});

/**
 * SDD 477 / t-5bfb72 — the auth-required agent state.
 *
 * The incident: an agent lost its provider login mid-run and Tachyon read it as ordinary idleness, so
 * a coordinator could keep assigning work and restarting forever. These tests pin the two directions
 * that matter — the state is REACHED from a measured signal on a quiet pane, and it is NOT reached
 * from any of the shapes that would park a healthy agent.
 */
const CLAUDE_LOGIN_TURN = "Not logged in · Please run /login";
const CLAUDE_LOGIN_FOOTER = "Not logged in · Run /login";

/** A quiet Claude pane whose last real output is the turn-attached login error. */
function loggedOutPane(notice = CLAUDE_LOGIN_TURN): string {
  return [`● ${notice}`, "", "╭──────────────────────────────╮", "│ >                            │", "╰──────────────────────────────╯"].join("\n");
}

/** Drive a pane from fresh snapshot to "idle long enough for the latch to be decidable". */
async function settleIdle(f: ReturnType<typeof makeMonitor>): Promise<void> {
  await f.advance(0); // baseline snapshot
  await f.advance(SETTINGS.silenceSec * 1000 + 1000); // → idle, auth stability window opens
  await f.advance(PATTERN_STABLE_MS + 100); // → stability window satisfied
}

describe("AttentionMonitor — auth-required (SDD 477)", () => {
  it("a measured signal on a quiet pane latches auth-required, naming runtime and action", async () => {
    const f = makeMonitor({ claude: { content: loggedOutPane(), cpu: 0, settings: SETTINGS, cmd: "claude" } });
    await settleIdle(f);

    const attention = f.monitor.stateOf("claude");
    // The state stays idle — this is an independent latch, not a new AttentionState.
    expect(attention?.state).toBe("idle");
    expect(attention?.authRequired?.runtime).toBe("claude");
    expect(attention?.authRequired?.humanAction).toContain("/login");
    expect(attention?.authRequired?.matchedLine).toContain("Please run /login");
    expect(f.monitor.isAuthRequired("claude")).toBe(true);
    expect(f.monitor.authRequiredAgents()).toEqual(new Set(["claude"]));

    // One attention event per episode, and it keeps holding on later quiet ticks.
    expect(f.events.filter((e) => e.notify && e.attention.authRequired)).toHaveLength(1);
    await f.advance(30_000);
    expect(f.monitor.isAuthRequired("claude")).toBe(true);
    expect(f.events.filter((e) => e.notify && e.attention.authRequired)).toHaveLength(1);
  });

  /**
   * t-73ea6a — Grok's auth error reaches the overlay end to end, on the real captured pane. The unit
   * around `classifyAuthRequired` proves the matcher; this proves the WIRING, which is what gap 4 of
   * the parity verdict said was missing: measurable, and not consumed.
   */
  it("grok: the measured in-pane auth error latches once, and holds without re-notifying", async () => {
    const pane = fs.readFileSync(
      path.resolve(__dirname, "../fixtures/grok-composer/post-turn.pane.txt"),
      "utf8",
    );
    const f = makeMonitor({ grok: { content: pane, cpu: 0, settings: SETTINGS, cmd: "grok" } });
    await settleIdle(f);

    const attention = f.monitor.stateOf("grok");
    expect(attention?.state).toBe("idle"); // an independent latch, not a new state
    expect(attention?.authRequired?.runtime).toBe("grok");
    expect(attention?.authRequired?.humanAction).toContain("grok login --device-code");
    expect(attention?.authRequired?.matchedLine).toMatch(/incorrect api key provided/i);
    expect(f.monitor.isAuthRequired("grok")).toBe(true);

    // No loop: one notification for the episode, and it keeps holding on later quiet ticks.
    expect(f.events.filter((e) => e.notify && e.attention.authRequired)).toHaveLength(1);
    await f.advance(30_000);
    expect(f.events.filter((e) => e.notify && e.attention.authRequired)).toHaveLength(1);
    expect(f.monitor.isAuthRequired("grok")).toBe(true);
  });

  /**
   * The release condition the task names: a genuine new turn. An unauthenticated runtime cannot
   * produce one, so this is what tells "the human fixed it" apart from "the error is still on screen".
   */
  it("grok: a real turn after authentication releases the latch", async () => {
    const pane = fs.readFileSync(
      path.resolve(__dirname, "../fixtures/grok-composer/post-turn.pane.txt"),
      "utf8",
    );
    const f = makeMonitor({ grok: { content: pane, cpu: 0, settings: SETTINGS, cmd: "grok" } });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("grok")).toBe(true);

    // The human logs in and the agent actually answers: new output, none of it the failure.
    f.agents.grok.content = ["  <workspace>", "", "     ❯ probe line 7", "", "     Done.", ""].join("\n");
    f.agents.grok.cpu = 40;
    await f.advance(1000);
    expect(f.monitor.isAuthRequired("grok")).toBe(false);
  });

  /** A grok pane that never failed must never latch — the signal is turn-attached, not chrome. */
  it("grok: a healthy pane does not latch", async () => {
    const healthy = [
      "  <workspace>",
      "",
      "     ❯ probe line 6",
      "",
      "     All good.",
      "",
      "╭───────────────────────────────╮",
      "│ ❯                             │",
      "╰───────────────────────────────╯",
      "Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    const f = makeMonitor({ grok: { content: healthy, cpu: 0, settings: SETTINGS, cmd: "grok" } });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("grok")).toBe(false);
  });

  it("the debounce must elapse — a single tick of the signal is not evidence", async () => {
    const f = makeMonitor({ claude: { content: loggedOutPane(), cpu: 0, settings: SETTINGS, cmd: "claude" } });
    await f.advance(0);
    await f.advance(SETTINGS.silenceSec * 1000 + 1000);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
  });

  it("a working agent never latches, however the bytes got on screen", async () => {
    // The exact failure this guards: an agent READING the measured signals (this repository stores
    // them verbatim) while perfectly authenticated. Its pane keeps moving, so it is never idle.
    const f = makeMonitor({ claude: { content: "opening authRequired.test.ts", cpu: 100, settings: SETTINGS, cmd: "claude" } });
    await f.advance(0);
    for (let i = 0; i < 5; i++) {
      f.agents.claude.content = `${loggedOutPane()}\n reading fixture line ${i}`;
      await f.advance(3000);
    }
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
  });

  it("Claude's TUI footer never latches, even on a quiet pane", async () => {
    // Measured on a fully functional agent mid-task. A detector keyed on it parks healthy agents.
    const f = makeMonitor({
      claude: { content: `● Propagating… (3m 43s)\n\n❯ \n  ? for shortcuts        ${CLAUDE_LOGIN_FOOTER}`, cpu: 0, settings: SETTINGS, cmd: "claude" },
    });
    await settleIdle(f);
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
  });

  it("a signal buried in scrollback never latches", async () => {
    const scrolled = [loggedOutPane(), ...Array.from({ length: 20 }, (_, i) => `  ${i}. later output`)].join("\n");
    const f = makeMonitor({ claude: { content: scrolled, cpu: 0, settings: SETTINGS, cmd: "claude" } });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
  });

  it("a runtime with no measured profile never latches", async () => {
    // opencode emits nothing when unauthenticated (it answers on a fallback model) — t-0338fc.
    const f = makeMonitor({ oc: { content: loggedOutPane(), cpu: 0, settings: SETTINGS, cmd: "opencode" } });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("oc")).toBe(false);
  });

  it("a neighbouring failure on the same pane never becomes auth-required", async () => {
    const f = makeMonitor({
      claude: { content: `Error: rate limit exceeded, please try again later\n${loggedOutPane()}`, cpu: 0, settings: SETTINGS, cmd: "claude" },
    });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
  });

  it("a real new turn releases the hold; a login that did not take re-latches", async () => {
    const f = makeMonitor({ claude: { content: loggedOutPane(), cpu: 0, settings: SETTINGS, cmd: "claude" } });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("claude")).toBe(true);

    // Explicit restart after a human login: the agent produces a turn, which it could not do while
    // unauthenticated. That edge — and only that edge — is the release.
    f.agents.claude.content = "● Working on the task again…";
    await f.advance(3000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
    expect(f.monitor.stateOf("claude")?.authRequired).toBeUndefined();

    // If the login had NOT actually been fixed, the runtime answers the same notice and the hold
    // comes back — the release is self-correcting in both directions.
    f.agents.claude.content = loggedOutPane("Login expired · Please run /login");
    await f.advance(3000); // the notice arrives — still a moving pane
    await f.advance(SETTINGS.silenceSec * 1000 + 1000); // it goes quiet again → re-latch
    expect(f.monitor.isAuthRequired("claude")).toBe(true);
    expect(f.events.filter((e) => e.notify && e.attention.authRequired)).toHaveLength(2);
  });

  it("the hold suppresses automatic restart, and clearing it restores the configured policy", async () => {
    // The composition Workspace wires: LifecycleMonitor.policyOf consults the auth latch, so a
    // crash-restart loop cannot run against an agent only a human can unblock.
    const f = makeMonitor({ claude: { content: loggedOutPane(), cpu: 0, settings: SETTINGS, cmd: "claude" } });
    await settleIdle(f);
    expect(f.monitor.isAuthRequired("claude")).toBe(true);

    const restarts: string[] = [];
    const states = new Map<string, { dead: boolean; exitCode?: number }>([["claude", { dead: false }]]);
    const lifecycle = new LifecycleMonitor(
      {
        agentStates: async () => new Map(states),
        // Verbatim shape of the Workspace wiring.
        policyOf: (agent) => (f.monitor.isAuthRequired(agent) ? "never" : "on-crash"),
        scheduleRestart: (agent) => restarts.push(agent),
        now: () => Date.now(),
      },
      {},
    );
    await lifecycle.tick();
    states.set("claude", { dead: true, exitCode: 1 });
    await lifecycle.tick();
    expect(restarts).toEqual([]);

    // Human logs in and restarts explicitly: the agent takes a turn, the latch drops, and the
    // configured on-crash policy is in force again with nobody having to re-enable it.
    f.agents.claude.content = "● back to work";
    await f.advance(3000);
    expect(f.monitor.isAuthRequired("claude")).toBe(false);
    states.set("claude", { dead: false });
    await lifecycle.tick();
    states.set("claude", { dead: true, exitCode: 1 });
    await lifecycle.tick();
    expect(restarts).toEqual(["claude"]);
  });
});
