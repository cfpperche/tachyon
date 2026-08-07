import { describe, it, expect } from "vitest";
import { LifecycleMonitor, RESTART_DELAYS_MS } from "../../src/agents/LifecycleMonitor.js";
import type { RestartPolicy } from "../../src/config/loadConfig.js";
import { parseConfig } from "../../src/config/loadConfig.js";

function makeLifecycle(policies: Record<string, RestartPolicy>) {
  let now = 1_000_000;
  const states = new Map<string, { dead: boolean; exitCode?: number }>();
  const restarts: Array<{ agent: string; delayMs: number }> = [];
  const events: string[] = [];
  const monitor = new LifecycleMonitor(
    {
      agentStates: async () => new Map(states),
      policyOf: (agent) => policies[agent] ?? "never",
      scheduleRestart: (agent, delayMs) => restarts.push({ agent, delayMs }),
      now: () => now,
    },
    {
      onCrash: (agent, code, willRestart, delayMs) =>
        events.push(`crash:${agent}:${code}:${willRestart}${delayMs !== undefined ? `:${delayMs}` : ""}`),
      onCleanExit: (agent) => events.push(`clean:${agent}`),
      onGiveUp: (agent, attempts) => events.push(`giveup:${agent}:${attempts}`),
      onGone: (agent) => events.push(`gone:${agent}`),
    },
  );
  return {
    monitor,
    states,
    restarts,
    events,
    advance: async (ms: number) => {
      now += ms;
      await monitor.tick();
    },
  };
}

describe("LifecycleMonitor", () => {
  it("clean exit (0) fires onCleanExit and never restarts", async () => {
    const f = makeLifecycle({ a: "on-crash" });
    f.states.set("a", { dead: false });
    await f.advance(0);
    f.states.set("a", { dead: true, exitCode: 0 });
    await f.advance(3000);
    expect(f.events).toEqual(["clean:a"]);
    expect(f.restarts).toEqual([]);
  });

  it("crash with policy never: event only, no restart, fired once", async () => {
    const f = makeLifecycle({ a: "never" });
    f.states.set("a", { dead: false });
    await f.advance(0);
    f.states.set("a", { dead: true, exitCode: 1 });
    await f.advance(3000);
    await f.advance(3000); // still dead — no re-fire
    expect(f.events).toEqual(["crash:a:1:false"]);
    expect(f.restarts).toEqual([]);
  });

  it("on-crash: backoff 2s/4s/8s then give-up inside the window", async () => {
    const f = makeLifecycle({ a: "on-crash" });
    const crashAndRecover = async (code: number) => {
      f.states.set("a", { dead: true, exitCode: code });
      await f.advance(3000);
      f.states.set("a", { dead: false }); // simulated restart succeeded
      await f.advance(3000);
    };
    f.states.set("a", { dead: false });
    await f.advance(0);

    await crashAndRecover(1);
    await crashAndRecover(1);
    await crashAndRecover(1);
    expect(f.restarts.map((r) => r.delayMs)).toEqual(RESTART_DELAYS_MS);

    f.states.set("a", { dead: true, exitCode: 1 }); // 4th crash within 60s
    await f.advance(3000);
    expect(f.events.at(-1)).toBe("giveup:a:3");
    expect(f.restarts).toHaveLength(3); // no 4th restart
  });

  it("window expiry and manual resetBackoff both re-arm the policy", async () => {
    const f = makeLifecycle({ a: "on-crash" });
    f.states.set("a", { dead: false });
    await f.advance(0);
    for (let i = 0; i < 3; i++) {
      f.states.set("a", { dead: true, exitCode: 9 });
      await f.advance(2000);
      f.states.set("a", { dead: false });
      await f.advance(2000);
    }
    expect(f.restarts).toHaveLength(3);

    // 61s later the window is clear — first delay again
    f.states.set("a", { dead: true, exitCode: 9 });
    await f.advance(61_000);
    expect(f.restarts.at(-1)?.delayMs).toBe(RESTART_DELAYS_MS[0]);

    f.monitor.resetBackoff("a");
    f.states.set("a", { dead: false });
    await f.advance(1000);
    f.states.set("a", { dead: true, exitCode: 9 });
    await f.advance(1000);
    expect(f.restarts.at(-1)?.delayMs).toBe(RESTART_DELAYS_MS[0]);
  });

  it("a vanished session (intentional kill) fires onGone (silent in the UI) after two consecutive absent ticks", async () => {
    const f = makeLifecycle({ a: "on-crash" });
    f.states.set("a", { dead: false });
    await f.advance(0);
    f.states.delete("a"); // killSession removes the whole session
    await f.advance(3000);
    expect(f.events).toEqual([]); // one absent tick isn't enough — t-3a3a14b
    await f.advance(3000);
    expect(f.events).toEqual(["gone:a"]);
    expect(f.restarts).toEqual([]);
  });

  it("a single missing tick (upstream hiccup) does NOT fire onGone if the agent reappears — t-3a3a14b", async () => {
    // Regression for the confirmed mechanism: a transient tmux list-panes error (raced by
    // a tachyon.yml edit triggering kills/reconcile) made a live agent disappear from
    // agentStates() for exactly one tick before reappearing on the next.
    const f = makeLifecycle({ a: "never" });
    f.states.set("a", { dead: false });
    await f.advance(0);
    f.states.delete("a"); // simulated transient list-panes blip
    await f.advance(1000);
    expect(f.events).toEqual([]);
    f.states.set("a", { dead: false }); // agent was alive the whole time
    await f.advance(1000);
    expect(f.events).toEqual([]); // never treated as gone, no false death-poke
  });

  it("a dead pane discovered on first tick (activation) counts as a crash, once", async () => {
    const f = makeLifecycle({ a: "never" });
    f.states.set("a", { dead: true, exitCode: 137 });
    await f.advance(0);
    await f.advance(3000);
    expect(f.events).toEqual(["crash:a:137:false"]);
  });
});

describe("restart config", () => {
  it("parses the policy and defaults to never", () => {
    const { config } = parseConfig(
      "agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n    restart: on-crash\n",
    );
    expect(config?.agents.a.restart).toBe("never");
    expect(config?.agents.b.restart).toBe("on-crash");
  });

  it("rejects invalid policies", () => {
    expect(parseConfig("agents:\n  a:\n    cmd: x\n    restart: always\n").warnings[0]).toContain(
      "agents.a.restart",
    );
  });
});
