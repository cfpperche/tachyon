import { describe, it, expect } from "vitest";
import { RuntimeSlackMonitor } from "../../src/workspace/RuntimeSlackMonitor.js";
import { projectRuntimeCondition } from "../../src/runtimeOps/runtimeCondition.js";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";
import type { CollectorEnvelopeV1 } from "../../src/runtimeObservability/types.js";
import type { ProviderQuotaChannelDescriptorV1 } from "../../src/runtimeObservability/service.js";

const CHANNELS: Record<"codex" | "claude", ProviderQuotaChannelDescriptorV1> = {
  codex: {
    provider: "codex",
    source: "cli",
    channel: { acquisition: "control-plane", mechanism: "app-server account/rateLimits/read" },
  },
  claude: {
    provider: "claude",
    source: "cli",
    channel: { acquisition: "rendered-surface", mechanism: "status-line capture" },
  },
};

const SCOPE = {
  codex: { kind: "provider-account" as const, provider: "codex" as const, key: "ps_00112233445566778899" },
  claude: { kind: "provider-account" as const, provider: "claude" as const, key: "ps_aabbccddeeff00112233" },
};

interface WindowInput {
  name: "session" | "weekly";
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

function envelope(
  provider: "codex" | "claude",
  observedAt: string,
  windows: WindowInput[],
  freshness: { state: "fresh" } | { state: "stale"; lastGoodAt: string } = { state: "fresh" },
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: "fixture", version: "1.0.0" },
    generatedAt: observedAt,
    facts: [{
      kind: "provider-quota",
      scope: SCOPE[provider],
      source: "cli",
      confidence: "exact",
      observedAt,
      freshness,
      windows,
    }],
    diagnostics: [],
  };
}

const agent = (name: string, extra: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo => ({
  name,
  session: `s-${name}`,
  running: true,
  lifetime: "temporary",
  resumePolicy: "collected",
  dead: false,
  crashed: false,
  kind: "agent",
  ...extra,
});

function fixture() {
  const observations: Partial<Record<"codex" | "claude", CollectorEnvelopeV1>> = {};
  const entries: ManagedEntryInfo[] = [agent("claude-coordinator"), agent("child", { parent: "claude-coordinator" })];
  const delivered: Array<{ agent: string; line: string }> = [];
  const monitor = new RuntimeSlackMonitor({
    condition: () => projectRuntimeCondition({
      generatedAt: "2026-08-02T18:00:00.000Z",
      channels: [CHANNELS.codex, CHANNELS.claude],
      preferences: {
        codex: { scope: SCOPE.codex, sources: ["cli"] },
        claude: { scope: SCOPE.claude, sources: ["cli"] },
      },
      observations,
    }),
    listEntries: async () => entries,
    deliverNotice: async (target, line) => {
      delivered.push({ agent: target, line });
    },
  });
  return {
    monitor,
    delivered,
    entries,
    observe(provider: "codex" | "claude", observedAt: string, windows: WindowInput[], freshness?: { state: "stale"; lastGoodAt: string }) {
      observations[provider] = envelope(provider, observedAt, windows, freshness ?? { state: "fresh" });
    },
  };
}

const PRESSURED = "2026-08-02T13:00:00.000Z";
const RELIEVED = "2026-08-02T18:05:00.000Z";

describe("RuntimeSlackMonitor", () => {
  it("pokes the coordinator once when a window that was under pressure comes back with room", async () => {
    const f = fixture();
    f.observe("claude", PRESSURED, [{ name: "session", usedPercent: 100, windowMinutes: 300, resetsAt: "2026-08-02T18:00:00.000Z" }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(0);

    f.observe("claude", RELIEVED, [{ name: "session", usedPercent: 3, windowMinutes: 300 }]);
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0].agent).toBe("claude-coordinator");
    expect(f.delivered[0].line).toContain("runtime 'claude' has slack again");
    expect(f.delivered[0].line).toContain("3% used");
    expect(f.delivered[0].line).toContain("down from 100%");
  });

  it("does not repeat while the same relief holds, and re-arms only after pressure returns", async () => {
    const f = fixture();
    f.observe("codex", PRESSURED, [{ name: "session", usedPercent: 96 }]);
    await f.monitor.tick();
    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 5 }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(1);

    // Same relieved state, many more ticks: the state machine is disarmed, so nothing repeats.
    for (let i = 0; i < 5; i++) await f.monitor.tick();
    f.observe("codex", "2026-08-02T19:00:00.000Z", [{ name: "session", usedPercent: 30 }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(1);

    // Pressure again, then relief again: one more line, because the situation actually recurred.
    f.observe("codex", "2026-08-02T22:00:00.000Z", [{ name: "session", usedPercent: 99 }]);
    await f.monitor.tick();
    f.observe("codex", "2026-08-03T03:00:00.000Z", [{ name: "session", usedPercent: 1 }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(2);
  });

  it("quotes a reset time the channel gave, and says so when the channel gave none", async () => {
    const f = fixture();
    f.observe("codex", PRESSURED, [{ name: "session", usedPercent: 97, resetsAt: "2026-08-02T18:00:00.000Z" }]);
    f.observe("claude", PRESSURED, [{ name: "session", usedPercent: 97 }]);
    await f.monitor.tick();
    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 2 }]);
    f.observe("claude", RELIEVED, [{ name: "session", usedPercent: 2 }]);
    await f.monitor.tick();

    const codexLine = f.delivered.find((d) => d.line.includes("'codex'"))?.line ?? "";
    const claudeLine = f.delivered.find((d) => d.line.includes("'claude'"))?.line ?? "";
    expect(codexLine).toContain("the channel named 2026-08-02T18:00:00.000Z as the reset");
    expect(claudeLine).toContain("this channel names no reset time");
    expect(claudeLine).not.toContain("as the reset");
    // The fragile channel stays labelled in the poke, not only in the query.
    expect(claudeLine).toContain("best-effort");
    expect(codexLine).not.toContain("best-effort");
  });

  it("stays silent when the relief was never preceded by an observed pressure", async () => {
    const f = fixture();
    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 4 }]);
    await f.monitor.tick();
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(0);
  });

  it("ignores a stale last-good echo — only a fresh reading may claim slack came back", async () => {
    const f = fixture();
    f.observe("codex", PRESSURED, [{ name: "session", usedPercent: 98 }]);
    await f.monitor.tick();

    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 2 }], { state: "stale", lastGoodAt: PRESSURED });
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(0);

    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 2 }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(1);
  });

  it("tells the agents that delegate, not the children already inside their work", async () => {
    const f = fixture();
    f.entries.push(agent("second-root"), agent("stopped-root", { running: false }));
    f.observe("codex", PRESSURED, [{ name: "session", usedPercent: 100 }]);
    await f.monitor.tick();
    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 0 }]);
    await f.monitor.tick();

    expect(f.delivered.map((d) => d.agent).sort()).toEqual(["claude-coordinator", "second-root"]);
  });

  it("a window the channel stops reporting is dropped, never announced as relieved", async () => {
    const f = fixture();
    f.observe("codex", PRESSURED, [{ name: "session", usedPercent: 100 }, { name: "weekly", usedPercent: 95 }]);
    await f.monitor.tick();

    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 100 }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(0);

    // The weekly window comes back, still pressured: it is a fresh episode, so it does not ring either.
    f.observe("codex", RELIEVED, [{ name: "session", usedPercent: 100 }, { name: "weekly", usedPercent: 96 }]);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(0);
  });
});
