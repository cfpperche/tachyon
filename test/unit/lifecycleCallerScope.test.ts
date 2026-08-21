import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "@tachyon/bridge/Bridge.js";
import { CallerIdentityRegistry } from "@tachyon/bridge/callerIdentity.js";
import { AgentManager } from "@tachyon/engine/agents/AgentManager.js";
import { SessionLedger } from "@tachyon/engine/resume/SessionLedger.js";
import { TmuxService, workspaceHash, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { parseConfigFixture as parseConfig } from "../helpers/parseConfigFixture.js";
import { PinStore } from "@tachyon/engine/pins/PinStore.js";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { ValidationStore } from "@tachyon/engine/validations/ValidationStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * t-bec361 — the by-name lifecycle/input doors (`kill_agent`, `restart_agent`, `write_input`, and
 * since t-bb1775 `dismiss_agent`) must ask WHO is calling. The identity was already resolved
 * (spec 351) and simply never consulted here, so any agent could stop, restart, drive or (for a
 * stopped Temporary) dismiss any other agent in the fleet — and for a Temporary that owns a
 * checkout, `kill_agent` and `dismiss_agent` cascade into removing the worktree and branch
 * (t-a76aed / t-1cf3c5), which turns a wrong call from an interruption into a deletion.
 *
 * The rule under test, stated as ACTOR × TRIGGER because that is what the doors differ by:
 *  - Agent (resolved token) → itself, an agent BELOW it in its own lineage, or a Saved Agent it
 *    directly owns in the roster. Anything else is refused, naming the target's owner and the way
 *    through. Declared ownership does not become runtime lineage.
 *  - Legacy / external / master token (the human's operation doors) → unchanged, unrestricted.
 *  - The host's own doors (sidebar Kill via engineService, crash auto-restart via Workspace) call
 *    `manager.kill`/`manager.restart` directly and never pass through these tools at all.
 */

// t-eb4b30 — a REAL directory: Temporary listing is the ledger row, so a stopped pane that we
// delete from the fake tmux must still be addressable by dismiss_agent. A string path is enough
// for kill/restart (the session is live) and was the original fixture; dismiss needs the row.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-lifecycle-scope-ws-"));
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
    "    subagents: [owned]\n" +
    "  stranger:\n" +
    "    cmd: claude\n" +
    "  owned:\n" +
    "    cmd: claude\n",
  ).config;
  const tmux = new TmuxService(exec);
  const ledger = new SessionLedger(WS);
  const manager = new AgentManager({ windowMs: 0, tmux, wsHash: HASH, workspaceRoot: WS, ledger, getConfig: () => config });
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
    fs.rmSync(WS, { recursive: true, force: true });
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

  it("Saved roster owner reaches kill_agent, restart_agent, and write_input without gaining lineage", async () => {
    const activated = await bossClient.callTool({ name: "spawn_agent", arguments: { name: "owned" } });
    expect(activated.isError).toBeFalsy();
    expect(manager.parentOf("owned")).toBeUndefined();
    expect(manager.declaredOwnerOf("owned")).toBe("boss");

    const write = await bossClient.callTool({ name: "write_input", arguments: { name: "owned", text: "continue" } });
    expect(write.isError).toBeFalsy();

    const restart = await bossClient.callTool({
      name: "restart_agent",
      arguments: { name: "owned", stop: "force", session: "new" },
    });
    expect(restart.isError).toBeFalsy();
    expect(manager.parentOf("owned")).toBeUndefined();

    const killed = await bossClient.callTool({ name: "kill_agent", arguments: { name: "owned" } });
    expect(killed.isError).toBeFalsy();
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

  it("dismiss_agent: stranger and sibling cannot dismiss a stopped Temporary, and the row remains", async () => {
    const spawnedVictim = await bossClient.callTool({
      name: "spawn_agent",
      arguments: { name: "dismiss-victim", cmd: "claude", skip_contract_reason: "test fixture" },
    });
    expect(spawnedVictim.isError).toBeFalsy();
    const spawnedSibling = await bossClient.callTool({
      name: "spawn_agent",
      arguments: { name: "dismiss-sib", cmd: "claude", skip_contract_reason: "test fixture" },
    });
    expect(spawnedSibling.isError).toBeFalsy();
    expect(manager.parentOf("dismiss-victim")).toBe("boss");
    expect(manager.parentOf("dismiss-sib")).toBe("boss");

    // t-1cf3c5 / t-28bf8f — stop the pane without collecting the row, the state a sibling actually
    // reaches: listed, Temporary, not running, still dismissable.
    sessions.delete(manager.session("dismiss-victim"));

    const sibToken = registry.mint("dismiss-sib", SCOPE);
    const sibClient = await connect("dismiss-sib", sibToken);
    try {
      const sibling = await sibClient.callTool({ name: "dismiss_agent", arguments: { name: "dismiss-victim" } });
      expect(sibling.isError).toBe(true);
      expect(text(sibling)).toContain("dismiss_agent refused");
      expect(text(sibling)).toContain("dismiss-sib");
      expect(text(sibling)).toContain("boss");
      expect(text(sibling)).toContain("lifecycle-scoped");
      // Own enum name — t-bb1775 forbids the retask_agent replaceAll("restart_agent", ...) hack.
      expect(text(sibling)).not.toContain("restart_agent");
      expect(text(sibling)).not.toContain("may restart");
    } finally {
      await sibClient.close();
    }

    const stranger = await strangerClient.callTool({ name: "dismiss_agent", arguments: { name: "dismiss-victim" } });
    expect(stranger.isError).toBe(true);
    expect(text(stranger)).toContain("dismiss_agent refused");
    expect(text(stranger)).toContain("stranger");
    expect(text(stranger)).not.toContain("restart_agent");

    expect((await manager.list()).map((agent) => agent.name)).toContain("dismiss-victim");
  });

  it("dismiss_agent: self and ancestor still dismiss; human-operation tokens stay unrestricted", async () => {
    const spawned = await bossClient.callTool({
      name: "spawn_agent",
      arguments: { name: "dismiss-child", cmd: "claude", skip_contract_reason: "test fixture" },
    });
    expect(spawned.isError).toBeFalsy();
    sessions.delete(manager.session("dismiss-child"));
    const ancestor = await bossClient.callTool({ name: "dismiss_agent", arguments: { name: "dismiss-child" } });
    expect(ancestor.isError).toBeFalsy();
    expect((await manager.list()).map((agent) => agent.name)).not.toContain("dismiss-child");

    const spawnedSelf = await bossClient.callTool({
      name: "spawn_agent",
      arguments: { name: "dismiss-self", cmd: "claude", skip_contract_reason: "test fixture" },
    });
    expect(spawnedSelf.isError).toBeFalsy();
    sessions.delete(manager.session("dismiss-self"));
    const selfToken = registry.mint("dismiss-self", SCOPE);
    const selfClient = await connect("dismiss-self", selfToken);
    try {
      const self = await selfClient.callTool({ name: "dismiss_agent", arguments: { name: "dismiss-self" } });
      expect(self.isError).toBeFalsy();
    } finally {
      await selfClient.close();
    }
    expect((await manager.list()).map((agent) => agent.name)).not.toContain("dismiss-self");

    await manager.spawn("dismiss-legacy", { cmd: "claude" });
    sessions.delete(manager.session("dismiss-legacy"));
    const legacy = await masterClient.callTool({ name: "dismiss_agent", arguments: { name: "dismiss-legacy" } });
    expect(legacy.isError).toBeFalsy();

    await manager.spawn("dismiss-external", { cmd: "claude" });
    sessions.delete(manager.session("dismiss-external"));
    const external = await externalClient.callTool({ name: "dismiss_agent", arguments: { name: "dismiss-external" } });
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
