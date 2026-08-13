/**
 * t-181925 / C-06 — manager wires turn binding into ingestChatReply.
 *
 * Pre-fix defect: any reply cleared the single global wait (late reply after a
 * new send, or after an agent switch, could resolve the wrong turn). These tests
 * exercise the production door on IdeBrowserBridgeManager.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { IdeBrowserBridgeManager } from "../../src/webview/ide-browser-bridge/manager.js";
import { tailDmChat } from "../../src/webview/ide-browser-bridge/designModeChat.js";

/** Private fields/methods reached only from these binding tests (t-181925). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MgrHarness = any;

function fakeLog(): vscode.OutputChannel {
  return {
    appendLine: () => {},
    append: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    name: "test",
    replace: () => {},
  } as unknown as vscode.OutputChannel;
}

describe("designMode chat reply turn binding (manager, t-181925)", () => {
  let root: string;
  let mgr: MgrHarness;

  beforeEach(() => {
    // Constructor subscribes to debug session end; unit mock has no debug export.
    (vscode as unknown as { debug: unknown }).debug = {
      onDidTerminateDebugSession: () => ({ dispose() {} }),
      onDidStartDebugSession: () => ({ dispose() {} }),
      activeDebugSession: undefined,
      startDebugging: async () => false,
      stopDebugging: async () => {},
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-turn-mgr-"));
    mgr = new IdeBrowserBridgeManager(root, fakeLog());
  });

  afterEach(async () => {
    try {
      await mgr.stop();
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("late reply for a prior turn does not resolve the current wait", async () => {
    // Human sent turn-1, then turn-2 — wait is for turn-2.
    mgr.beginChatReplyWait("alice", "dm-turn-2");
    expect(mgr.chatWait?.turnId).toBe("dm-turn-2");

    const late = await mgr.ingestChatReply(
      "answer that belonged to turn 1",
      "alice",
      "dm-turn-1",
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/does not match pending turn 'dm-turn-2'/);
    // Wait still outstanding — this is the whole fix.
    expect(mgr.chatWait?.turnId).toBe("dm-turn-2");
    expect(tailDmChat(root, 10).items).toHaveLength(0);

    const ok = await mgr.ingestChatReply("answer for turn 2", "alice", "dm-turn-2");
    expect(ok.ok).toBe(true);
    expect(mgr.chatWait).toBeNull();
    const tail = tailDmChat(root, 10);
    expect(tail.items).toHaveLength(1);
    expect(tail.items[0]).toMatchObject({ role: "agent", text: "answer for turn 2", agent: "alice" });
  });

  it("reply without turnId is rejected while a wait is outstanding", async () => {
    mgr.beginChatReplyWait("alice", "dm-turn-9");
    const bare = await mgr.ingestChatReply("orphan body", "alice");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toMatch(/turnId required/i);
    expect(mgr.chatWait?.turnId).toBe("dm-turn-9");
  });

  it("agent switch does not retarget the in-flight wait poll target", async () => {
    mgr.beginChatReplyWait("alice", "dm-turn-5");
    mgr.designAgent = "bob"; // UI switch mid-flight
    const seen: string[] = [];
    mgr.readAgentAttention = async (agent: string) => {
      seen.push(agent);
      return { state: "working", running: true };
    };
    await mgr.pollChatAgentState();
    expect(seen).toEqual(["alice"]);
    expect(mgr.chatWait).toMatchObject({ turnId: "dm-turn-5", agent: "alice", sawBusy: true });
  });

  it("matching reply clears wait; subsequent orphan reply does not invent a second resolve", async () => {
    mgr.beginChatReplyWait("alice", "dm-turn-4");
    const first = await mgr.ingestChatReply("done", "alice", "dm-turn-4");
    expect(first.ok).toBe(true);
    expect(mgr.chatWait).toBeNull();

    const second = await mgr.ingestChatReply("extra", "alice", "dm-turn-4");
    expect(second.ok).toBe(true);
    // Still no wait — orphan records but does not clear anything that is not there.
    expect(mgr.chatWait).toBeNull();
    expect(tailDmChat(root, 10).items).toHaveLength(2);
  });

  it("does not bind a wait to a turn that was already working before delivery", async () => {
    mgr.readAgentAttention = async () => ({ state: "working", running: true });
    mgr.beginChatReplyWait("alice", "dm-turn-new", true);
    await mgr.pollChatAgentState();
    expect(mgr.chatWait).toMatchObject({ sawBusy: false, awaitPostDeliveryStart: true });

    mgr.readAgentAttention = async () => ({ state: "idle", running: true });
    await mgr.pollChatAgentState();
    expect(mgr.chatWait).toMatchObject({ sawBusy: false, awaitPostDeliveryStart: false });

    mgr.readAgentAttention = async () => ({ state: "working", running: true });
    await mgr.pollChatAgentState();
    expect(mgr.chatWait).toMatchObject({ sawBusy: true, awaitPostDeliveryStart: false });
  });

  it("persists an unconfirmed human send without presenting it as sent", async () => {
    const pushed: Array<Record<string, unknown>> = [];
    mgr.listRunningAgents = async () => ["alice"];
    mgr.designAgent = "alice";
    mgr.getWorkspace = () => ({
      activity: {
        sendAgentInput: async () => ({ status: "submit-unconfirmed", reason: "still-staged", attempts: 4 }),
      },
    });
    mgr.session.cdp.pushDesignModeChat = async (payload: Record<string, unknown>) => { pushed.push(payload); };

    await mgr.sendChatMessage("please review this");

    const events = tailDmChat(root, 10).items;
    expect(events[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "please review this",
      activeAgent: "alice",
      delivery: "pending",
    });
    expect(events[1]).toMatchObject({
      kind: "delivery",
      status: "submit-unconfirmed",
    });
    expect(pushed).not.toContainEqual(expect.objectContaining({
      type: "working",
      phase: "sent",
    }));
    expect(mgr.chatWait).toBeNull();
  });

  it("stores an edit reply as one structured event with a readable fallback", async () => {
    mgr.beginChatReplyWait("alice", "dm-turn-edit");
    const result = await mgr.ingestChatReply(
      "Done — the button now has more room.",
      "alice",
      "dm-turn-edit",
      {
        summary: "Increase button padding",
        files: ["src/button.css"],
        patch: "diff --git a/src/button.css b/src/button.css\n@@ -1 +1 @@\n-padding: 4px\n+padding: 8px",
      },
    );

    expect(result.ok).toBe(true);
    const [event] = tailDmChat(root, 10).items;
    expect(event).toMatchObject({
      kind: "edit",
      role: "agent",
      reply: "Done — the button now has more room.",
      summary: "Increase button padding",
      files: ["src/button.css"],
    });
    expect(event && "text" in event ? event.text : "").toContain("+padding: 8px");
  });
});
