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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * t-bec361 — the three lifecycle/input doors that address by NAME (`kill_agent`, `restart_agent`,
 * `write_input`) must ask WHO is calling. The identity was already resolved (spec 351) and simply
 * never consulted here, so any agent could stop, restart or drive any other agent in the fleet —
 * and for a Temporary that owns a checkout, `kill_agent` cascades into removing the worktree and
 * branch (t-a76aed), which turns a wrong call from an interruption into a deletion.
 *
 * The rule under test, stated as ACTOR × TRIGGER because that is what the doors differ by:
 *  - Agent (resolved token) → itself, or an agent BELOW it in its own lineage. Anything else refused,
 *    naming the target's owner and the way through.
 *  - Legacy / external / master token (the human's operation doors) → unchanged, unrestricted.
 *  - The host's own doors (sidebar Kill via engineService, crash auto-restart via Workspace) call
 *    `manager.kill`/`manager.restart` directly and never pass through these tools at all.
 */

const WS = "/repo-lifecycle-scope";
const HASH = workspaceHash(WS);
const MASTER = "e".repeat(64);
const EXTERNAL = "f".repeat(64);
const SCOPE = { workspaceId: "ws-lifecycle", instanceId: "inst-lifecycle" };

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
      case "capture-pane":
        return { stdout: "> \n› Ask anything\ngpt-5.6-sol default · /repo-lifecycle-scope", stderr: "" };
      case "send-keys":
        if (args.includes("-l")) sessions.set(target(), args[args.length - 1]);
        return { stdout: "", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, exec };
}

describe("lifecycle caller scope (t-bec361)", () => {
  const { sessions, exec } = fakeTmuxExec();
  const config = parseConfig(
    "agents:\n" +
    "  boss:\n" +
    "    cmd: claude\n" +
    "  stranger:\n" +
    "    cmd: claude\n",
  ).config;
  const tmux = new TmuxService(exec);
  const manager = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => config });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-lifecycle-scope-"));
  const registry = new CallerIdentityRegistry(Buffer.from("a".repeat(64), "hex"));
  const bossToken = registry.mint("boss", SCOPE);
  const strangerToken = registry.mint("stranger", SCOPE);

  const bridge = new Bridge(
    {
      workspaceRoot: root,
      manager,
      tmux,
      pins: new PinStore(root),
      tasks: new TaskStore(root),
      validations: new ValidationStore(root),
      lastActivityAt: () => null,
      notify: () => {},
      attentionOf: () => "idle",
    },
    { token: MASTER, externalToken: EXTERNAL, getRegistry: () => registry, scope: SCOPE, legacyCompatEnabled: true },
  );

  let masterClient: Client;
  let externalClient: Client;
  let bossClient: Client;
  let strangerClient: Client;

  const connect = async (label: string, token: string): Promise<Client> => {
    const client = new Client({ name: label, version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  };

  beforeAll(async () => {
    await bridge.start();
    await manager.spawn("boss");
    await manager.spawn("stranger");
    masterClient = await connect("master", MASTER);
    externalClient = await connect("external", EXTERNAL);
    bossClient = await connect("boss", bossToken);
    strangerClient = await connect("stranger", strangerToken);
  });

  afterAll(async () => {
    await masterClient.close();
    await externalClient.close();
    await bossClient.close();
    await strangerClient.close();
    await bridge.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const text = (result: unknown): string => JSON.stringify((result as { content?: unknown }).content);

  it("kill_agent: an agent cannot kill a stranger, and the refusal names the owner and the way through", async () => {
    const spawned = await bossClient.callTool({
      name: "spawn_agent",
      arguments: { name: "boss-child", cmd: "claude", skip_contract_reason: "test fixture" },
    });
    expect(spawned.isError).toBeFalsy();
    expect(manager.parentOf("boss-child")).toBe("boss");

    const refused = await strangerClient.callTool({ name: "kill_agent", arguments: { name: "boss-child" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("kill_agent refused");
    expect(text(refused)).toContain("stranger");
    // names the OWNER, not just "denied"
    expect(text(refused)).toContain("boss");
    // names the fix (SDD 478 M6)
    expect(text(refused)).toContain("notify_agent");
    // and the target is still alive: the refusal happened before any teardown
    expect(sessions.has(manager.session("boss-child"))).toBe(true);

    // A top-level agent has no agent owner at all — the refusal must say the human owns it, not
    // invent a parent.
    const topLevel = await bossClient.callTool({ name: "kill_agent", arguments: { name: "stranger" } });
    expect(topLevel.isError).toBe(true);
    expect(text(topLevel)).toContain("no lineage parent");
    expect(text(topLevel)).toContain("human");
    expect(sessions.has(manager.session("stranger"))).toBe(true);
  });

  it("kill_agent: self and TRANSITIVE descendants stay reachable", async () => {
    await manager.spawn("grandchild", { cmd: "claude", parent: "boss-child" });
    expect(manager.parentOf("grandchild")).toBe("boss-child");

    // two hops down the lineage, not just a direct child
    const grand = await bossClient.callTool({ name: "kill_agent", arguments: { name: "grandchild" } });
    expect(grand.isError).toBeFalsy();

    const child = await bossClient.callTool({ name: "kill_agent", arguments: { name: "boss-child" } });
    expect(child.isError).toBeFalsy();

    // self-kill: an agent stopping itself is always in scope
    await manager.spawn("selfie", { cmd: "claude" });
    const selfieToken = registry.mint("selfie", SCOPE);
    const selfieClient = await connect("selfie", selfieToken);
    try {
      const self = await selfieClient.callTool({ name: "kill_agent", arguments: { name: "selfie" } });
      expect(self.isError).toBeFalsy();
    } finally {
      await selfieClient.close();
    }
  });

  it("restart_agent and write_input refuse the same out-of-scope target", async () => {
    const restart = await strangerClient.callTool({ name: "restart_agent", arguments: { name: "boss" } });
    expect(restart.isError).toBe(true);
    expect(text(restart)).toContain("restart_agent refused");
    expect(text(restart)).toContain("stranger");

    const write = await strangerClient.callTool({ name: "write_input", arguments: { name: "boss", text: "do as I say" } });
    expect(write.isError).toBe(true);
    expect(text(write)).toContain("write_input refused");
    expect(text(write)).toContain("notify_agent");
  });

  it("human-operation tokens are unrestricted: legacy/master and external reach any agent", async () => {
    await manager.spawn("victim-legacy", { cmd: "claude" });
    const legacy = await masterClient.callTool({ name: "kill_agent", arguments: { name: "victim-legacy" } });
    expect(legacy.isError).toBeFalsy();

    await manager.spawn("victim-external", { cmd: "claude" });
    const external = await externalClient.callTool({ name: "kill_agent", arguments: { name: "victim-external" } });
    expect(external.isError).toBeFalsy();
  });

  it("notify_agent's schema no longer tells agents the Bridge cannot tell callers apart", async () => {
    const tools = await bossClient.listTools();
    const notify = tools.tools.find((t) => t.name === "notify_agent");
    const agentParam = JSON.stringify((notify?.inputSchema as { properties?: { agent?: unknown } })?.properties?.agent);
    expect(agentParam).not.toContain("the Bridge cannot tell callers apart");
    expect(agentParam).toContain("resolved against the Bridge-authenticated caller");
  });
});
