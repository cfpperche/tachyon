import { describe, expect, it } from "vitest";
import { ACTION_META } from "@tachyon/webview-ui/sidebar/actions";
import { PluginActionBroker } from "../../src/plugins/ui/broker.js";
import type { PluginActionTarget } from "../../src/plugins/ui/broker.js";

describe("plugin UI action broker", () => {
  it("mints opaque generation-stamped handles and resolves them internally", () => {
    const broker = newBroker();
    const handle = broker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 1, wsHash: "ws-1", name: "cx-a" }, 3);

    expect(handle).toBe("pui_tok-1");
    expect(handle).not.toContain("cx-a");
    expect(handle).not.toContain("ws-1");
    expect(broker.generation()).toBe(3);
    expect(broker.resolveHandle(handle, 3)).toEqual({ ok: true, target: { wsHash: "ws-1", agent: "cx-a" }, generation: 3 });
  });

  it("dispatches consented focusAgent on a valid user gesture", async () => {
    const calls: PluginActionTarget[] = [];
    const broker = newBroker({ focusAgent: (target) => { calls.push(target); } });
    const handle = broker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 0, wsHash: "ws-2", name: "cx-b" }, 4);

    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 4, userGesture: true })).resolves.toEqual({
      ok: true,
      action: "focusAgent",
      target: { wsHash: "ws-2", agent: "cx-b" },
    });
    expect(calls).toEqual([{ wsHash: "ws-2", agent: "cx-b" }]);
  });

  it("rejects every first-party sidebar ActionId instead of widening into privileged dispatch", async () => {
    const calls: PluginActionTarget[] = [];
    const broker = newBroker({ focusAgent: (target) => { calls.push(target); } });
    const handle = broker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 0, name: "cx-c" }, 1);

    for (const action of Object.keys(ACTION_META)) {
      await expect(broker.dispatchAction({ action, handle, generation: 1, userGesture: true })).resolves.toMatchObject({
        ok: false,
        code: "unsupported_action",
      });
    }
    expect(calls).toEqual([]);
  });

  it("rejects raw authority fields even when a valid handle is also present", async () => {
    const calls: PluginActionTarget[] = [];
    const broker = newBroker({ focusAgent: (target) => { calls.push(target); } });
    const handle = broker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 0, wsHash: "ws-3", name: "cx-d" }, 1);

    const attempts = [
      { action: "focusAgent", handle, generation: 1, userGesture: true, agent: "cx-d" },
      { action: "focusAgent", handle, generation: 1, userGesture: true, name: "cx-d" },
      { action: "focusAgent", handle, generation: 1, userGesture: true, wsHash: "ws-3" },
      { action: "focusAgent", handle, generation: 1, userGesture: true, path: "/secret/worktree" },
      { action: "focusAgent", handle, generation: 1, userGesture: true, worktree: "branch-secret" },
    ];

    for (const request of attempts) {
      await expect(broker.dispatchAction(request)).resolves.toMatchObject({ ok: false, code: "raw_authority_rejected" });
    }
    expect(calls).toEqual([]);
  });

  it("rejects stale generations, revoked handles, out-of-allowlist actions, and malformed requests without side effects", async () => {
    const calls: PluginActionTarget[] = [];
    const broker = newBroker({ focusAgent: (target) => { calls.push(target); }, allowedActions: [] });
    const handle = broker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 0, name: "cx-e" }, 2);

    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 2, userGesture: true })).resolves.toMatchObject({
      ok: false,
      code: "action_not_allowed",
    });

    const allowedBroker = newBroker({ focusAgent: (target) => { calls.push(target); }, tokenPrefix: "allowed" });
    const stale = allowedBroker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 0, name: "cx-f" }, 5);
    allowedBroker.bumpGeneration(6);

    await expect(allowedBroker.dispatchAction({ action: "focusAgent", handle: stale, generation: 5, userGesture: true })).resolves.toMatchObject({
      ok: false,
      code: "stale_generation",
    });

    allowedBroker.expireHandle(stale);
    await expect(allowedBroker.dispatchAction({ action: "focusAgent", handle: stale, generation: 6, userGesture: true })).resolves.toMatchObject({
      ok: false,
      code: "unknown_handle",
    });
    await expect(allowedBroker.dispatchAction({ action: "focusAgent", handle: 123, generation: 6, userGesture: true })).resolves.toMatchObject({
      ok: false,
      code: "malformed",
    });
    expect(calls).toEqual([]);
  });

  it("refuses auto-fire and flood focus attempts", async () => {
    let now = 1_000;
    const calls: PluginActionTarget[] = [];
    const broker = newBroker({
      focusAgent: (target) => { calls.push(target); },
      minFocusIntervalMs: 500,
      now: () => now,
    });
    const handle = broker.mintHandle({ kind: "agent", fleetIndex: 0, agentIndex: 0, name: "cx-g" }, 1);

    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 1 })).resolves.toMatchObject({
      ok: false,
      code: "user_gesture_required",
    });
    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 1, userGesture: true })).resolves.toMatchObject({ ok: true });
    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 1, userGesture: true })).resolves.toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 1, userGesture: true, rateLimited: true })).resolves.toMatchObject({
      ok: false,
      code: "rate_limited",
    });

    now += 501;
    await expect(broker.dispatchAction({ action: "focusAgent", handle, generation: 1, userGesture: true })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([{ agent: "cx-g" }, { agent: "cx-g" }]);
  });

  it("keeps broker.ts free of vscode and privileged command dispatch names", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/plugins/ui/broker.ts", "utf8"));

    expect(source).not.toMatch(/from ["']vscode["']/);
    expect(source).not.toMatch(/\bACTION_CMD\b/);
    expect(source).not.toMatch(/\bexecuteCommand\b/);
  });
});

function newBroker(opts: Partial<{
  allowedActions: string[];
  focusAgent: (target: PluginActionTarget) => void;
  minFocusIntervalMs: number;
  now: () => number;
  tokenPrefix: string;
}> = {}): PluginActionBroker {
  let i = 0;
  const prefix = opts.tokenPrefix ?? "tok";
  return new PluginActionBroker({
    pluginId: "plugin.demo",
    sessionId: "session.1",
    allowedActions: opts.allowedActions ?? ["focusAgent"],
    focusAgent: opts.focusAgent ?? (() => undefined),
    minFocusIntervalMs: opts.minFocusIntervalMs ?? 0,
    now: opts.now,
    randomToken: () => `${prefix}-${++i}`,
  });
}
