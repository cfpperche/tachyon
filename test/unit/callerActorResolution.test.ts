import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "../../src/bridge/Bridge.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { ContinuityStore } from "../../src/continuity/ContinuityStore.js";
import { ProjectHandoffStore } from "../../src/handoff/ProjectHandoffStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * spec 351 (layer B, T4) — per-tool actor resolution + mismatch + self-assign suppression + legacy
 * bypass parity, driven end-to-end through a REAL Bridge with a REAL per-agent token registry (not just
 * the pure resolveActor unit tests in callerIdentity.test.ts).
 */

const WS = "/repo-actor";
const HASH = workspaceHash(WS);
const MASTER = "c".repeat(64);
const SCOPE = { workspaceId: "ws-actor", instanceId: "inst-actor" };

function fakeTmuxExec() {
  const sessions = new Map<string, string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.set(args[args.indexOf("-s") + 1], "");
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions.keys()].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions.keys()].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      case "send-keys":
        if (args.includes("-l")) sessions.set(target(), args[args.length - 1]);
        return { stdout: "", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, exec };
}

describe("Bridge tool-level actor resolution (spec 351 T4)", () => {
  const { exec } = fakeTmuxExec();
  const config = parseConfig("agents:\n  claude:\n    cmd: claude\n  codex:\n    cmd: codex\n").config;
  const tmux = new TmuxService(exec);
  const manager = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => config, getMaxAgents: () => 8 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-actor-"));
  const pins = new PinStore(root);
  const tasks = new TaskStore(root);
  const validations = new ValidationStore(root);
  const continuity = new ContinuityStore(root);
  const handoff = new ProjectHandoffStore(root);
  const notifications: Array<{ message: string; level: string }> = [];
  const taskNotices: Array<{ target: string; line: string }> = [];
  const registry = new CallerIdentityRegistry(Buffer.from("d".repeat(64), "hex"));
  const claudeToken = registry.mint("claude", SCOPE);
  const codexToken = registry.mint("codex", SCOPE);

  const bridge = new Bridge(
    {
      workspaceRoot: root,
      manager,
      tmux,
      pins,
      tasks,
      validations,
      continuity,
      handoff,
      lastActivityAt: () => null,
      notify: (message, level) => notifications.push({ message, level }),
      attentionOf: (agent) => (agent === "claude" || agent === "codex" ? "needs-input" : undefined),
      deliverNotice: async (target, line) => {
        taskNotices.push({ target, line });
        return { status: "notified" };
      },
      attachEvidence: async () => ({ ok: false, reason: "no worktree" }), // not the focus here; kept simple
    },
    { token: MASTER, getRegistry: () => registry, scope: SCOPE, legacyCompatEnabled: true },
  );

  let client: Client;
  let claudeClient: Client;
  let codexClient: Client;

  beforeAll(async () => {
    await bridge.start();
    await manager.spawn("claude");
    await manager.spawn("codex");
    client = new Client({ name: "master", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${MASTER}` } } }));
    claudeClient = new Client({ name: "claude", version: "0.0.1" });
    await claudeClient.connect(new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${claudeToken}` } } }));
    codexClient = new Client({ name: "codex", version: "0.0.1" });
    await codexClient.connect(new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${codexToken}` } } }));
  });

  afterAll(async () => {
    await client.close();
    await claudeClient.close();
    await codexClient.close();
    await bridge.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("spawn_agent: omitted parent resolves to the caller; the right parent is ok; a wrong parent is a caller_mismatch", async () => {
    const omitted = await claudeClient.callTool({ name: "spawn_agent", arguments: { name: "child-a", cmd: "claude", skip_contract_reason: "test fixture" } });
    expect(omitted.isError).toBeFalsy();
    await claudeClient.callTool({ name: "kill_agent", arguments: { name: "child-a" } });

    const right = await claudeClient.callTool({ name: "spawn_agent", arguments: { name: "child-b", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture" } });
    expect(right.isError).toBeFalsy();
    await claudeClient.callTool({ name: "kill_agent", arguments: { name: "child-b" } });

    const wrong = await claudeClient.callTool({ name: "spawn_agent", arguments: { name: "child-c", cmd: "claude", parent: "codex", skip_contract_reason: "test fixture" } });
    expect(wrong.isError).toBe(true);
    expect(JSON.stringify(wrong.content)).toContain("caller_mismatch");
    expect(JSON.stringify(wrong.content)).toContain("claude");
    expect(JSON.stringify(wrong.content)).toContain("codex");
  });

  it("notify_agent: sender is the resolved caller, not whatever the call declares", async () => {
    const spoof = await claudeClient.callTool({ name: "notify_agent", arguments: { to: "codex", summary: "hi", agent: "codex" } });
    // declaring agent:"codex" while authenticated as claude is a mismatch (claiming someone else's identity)
    expect(spoof.isError).toBe(true);
    expect(JSON.stringify(spoof.content)).toContain("caller_mismatch");

    const real = await claudeClient.callTool({ name: "notify_agent", arguments: { to: "codex", summary: "hi", agent: "claude" } });
    expect(real.isError).toBeFalsy();
  });

  it("create_task/create_pin: agent is the resolved caller when omitted; a claimed different identity is denied", async () => {
    const task = await claudeClient.callTool({ name: "create_task", arguments: { title: "t1" } });
    expect(JSON.parse((task.content as Array<{ text: string }>)[0].text).author).toBe("claude");

    const spoofTask = await claudeClient.callTool({ name: "create_task", arguments: { title: "t2", agent: "codex" } });
    expect(spoofTask.isError).toBe(true);

    const pin = await claudeClient.callTool({ name: "create_pin", arguments: { title: "p1" } });
    expect(pin.isError).toBeFalsy();
  });

  it("get_continuity/set_continuity: self-only — omitted resolves to you, claiming a different identity is denied", async () => {
    const set = await claudeClient.callTool({ name: "set_continuity", arguments: { agent: "claude", content: "# Current Goal\ntest" } });
    expect(set.isError).toBeFalsy();
    const spoofSet = await claudeClient.callTool({ name: "set_continuity", arguments: { agent: "codex", content: "# Current Goal\nhijack" } });
    expect(spoofSet.isError).toBe(true);
    const read = await claudeClient.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    expect(JSON.stringify(read.content)).toContain("test");
  });

  it("append_project_handoff_note: the author is the resolved caller", async () => {
    const note = await claudeClient.callTool({
      name: "append_project_handoff_note",
      arguments: { agent: "claude", kind: "completed", summary: "did the thing" },
    });
    expect(note.isError).toBeFalsy();
    const spoof = await claudeClient.callTool({
      name: "append_project_handoff_note",
      arguments: { agent: "codex", kind: "completed", summary: "did the thing" },
    });
    expect(spoof.isError).toBe(true);
  });

  it("update_task self-assign suppression: assigning to yourself fires no notify; assigning to a different LIVE agent still notifies", async () => {
    const created = await claudeClient.callTool({ name: "create_task", arguments: { title: "assign-me" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text) as { id: string };
    await claudeClient.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });

    taskNotices.length = 0;
    const selfAssign = await claudeClient.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude" } });
    expect(selfAssign.isError).toBeFalsy();
    expect(taskNotices.length).toBe(0); // self-assign: no poke

    taskNotices.length = 0;
    const otherAssign = await claudeClient.callTool({ name: "update_task", arguments: { id: task.id, assignee: "codex" } });
    expect(otherAssign.isError).toBeFalsy();
    expect(taskNotices.some((n) => n.target === "codex")).toBe(true); // different live agent: notified
  });

  it("compat OFF rejects the shared token outright (401 legacy_unvalidated) — no agent traffic should still rely on it", async () => {
    const strictBridge = new Bridge(
      { workspaceRoot: root, manager, tmux, pins, tasks, validations, notify: () => {} },
      { token: MASTER, legacyCompatEnabled: false },
    );
    await strictBridge.start();
    try {
      const res = await fetch(strictBridge.url!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${MASTER}` },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason?: string }).reason).toBe("legacy_unvalidated");
    } finally {
      await strictBridge.dispose();
    }
  });

  it("legacy bypass parity: a fabricated (non-live) identity claim passes through verbatim; a REAL live agent's identity cannot be claimed", async () => {
    const fabricated = await client.callTool({ name: "create_pin", arguments: { title: "legacy-pin", agent: "some-made-up-name" } });
    expect(fabricated.isError).toBeFalsy();
    expect(JSON.stringify(fabricated.content)).toContain("pinned as");

    const spoofLive = await client.callTool({ name: "notify_agent", arguments: { to: "codex", summary: "hi", agent: "claude" } });
    expect(spoofLive.isError).toBe(true);
    expect(JSON.stringify(spoofLive.content)).toContain("caller_mismatch");
  });
});
