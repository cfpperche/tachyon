import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge, derivePort, DERIVED_PORT_BASE, DERIVED_PORT_SPAN } from "../../src/bridge/Bridge.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/**
 * True end-to-end: a real MCP client (the official SDK) talking streamable-HTTP to a
 * real Bridge over loopback — only tmux itself is faked at the executor level.
 */

const WS = "/repo";
const HASH = workspaceHash(WS);

function fakeTmuxExec() {
  const sessions = new Map<string, string>(); // name -> last input
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
        return { stdout: `$ fake output for ${target()}\n`, stderr: "" };
      case "send-keys": {
        if (args.includes("-l")) sessions.set(target(), args[args.length - 1]);
        return { stdout: "", stderr: "" };
      }
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, exec };
}

describe("Bridge end-to-end over streamable HTTP", () => {
  const { sessions, exec } = fakeTmuxExec();
  const notifications: Array<{ message: string; level: string }> = [];
  const config = parseConfig("agents:\n  claude:\n    cmd: claude\nsettings:\n  maxAgents: 2\n").config;
  const tmux = new TmuxService(exec);
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    getMaxAgents: () => 8,
  });
  const pinsRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tachyon-bridge-pins-"));
  const pins = new PinStore(pinsRoot);
  const bridge = new Bridge({
    manager,
    tmux,
    pins,
    notify: (message, level) => notifications.push({ message, level }),
    attentionOf: (agent) => (agent === "claude" ? "needs-input" : undefined),
  });
  let client: Client;

  beforeAll(async () => {
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    client = new Client({ name: "test-agent", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!)));
  });

  afterAll(async () => {
    await client.close();
    await bridge.dispose();
    fs.rmSync(pinsRoot, { recursive: true, force: true });
  });

  it("exposes exactly the 16 tools (8 agent + 5 pins/notes + 3 commands/runbooks)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "complete_pin",
      "create_pin",
      "get_notes",
      "kill_agent",
      "list_agents",
      "list_commands",
      "list_pins",
      "notify",
      "read_output",
      "restart_agent",
      "run_command",
      "run_runbook",
      "set_notes",
      "spawn_agent",
      "wait_for_agent",
      "write_input",
    ]);
  });


  it("pins/notes tools round-trip through MCP onto the workspace files", async () => {
    const created = await client.callTool({ name: "create_pin", arguments: { text: "flaky test found", agent: "claude" } });
    expect(created.isError).toBeFalsy();
    const id = /p-[0-9a-f]{6}/.exec(JSON.stringify(created.content))?.[0];
    expect(id).toBeTruthy();

    const listed = await client.callTool({ name: "list_pins", arguments: {} });
    const pinsJson = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
    expect(pinsJson[0]).toMatchObject({ id, text: "flaky test found", by: "claude", done: false });
    // the file door agrees with the tool door
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "pins.json"), "utf8")).toContain("flaky test found");

    await client.callTool({ name: "complete_pin", arguments: { id } });
    expect(pins.list()[0].done).toBe(true);

    await client.callTool({ name: "set_notes", arguments: { text: "claude=auth, codex=tests" } });
    const notes = await client.callTool({ name: "get_notes", arguments: {} });
    expect(JSON.stringify(notes.content)).toContain("claude=auth");

    const bad = await client.callTool({ name: "complete_pin", arguments: { id: "p-ffffff" } });
    expect(bad.isError).toBe(true);
  });

  it("spawn_agent (declared) creates the tmux session", async () => {
    const result = await client.callTool({ name: "spawn_agent", arguments: { name: "claude" } });
    expect(result.isError).toBeFalsy();
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
  });

  it("spawn_agent (ad-hoc) + maxAgents guardrail + lineage", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "helper", cmd: "echo hi", parent: "claude" } });
    expect(sessions.has(`tachyon-${HASH}-helper`)).toBe(true);
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{ name: string; parent?: string }>;
    expect(parsed.find((a) => a.name === "helper")?.parent).toBe("claude");

    const blocked = await client.callTool({ name: "spawn_agent", arguments: { name: "third", cmd: "echo no" } });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("maxAgents limit reached (2)");
  });

  it("read_output returns the sibling's pane text", async () => {
    const result = await client.callTool({ name: "read_output", arguments: { name: "claude" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("fake output");
  });

  it("write_input lands in the sibling's session", async () => {
    await client.callTool({ name: "write_input", arguments: { name: "claude", text: "hello sibling" } });
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("hello sibling");
  });

  it("list_agents reports running + declared + attention state", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const list = JSON.parse(text) as Array<{ name: string; running: boolean; attention?: string }>;
    expect(list.find((a) => a.name === "claude")?.running).toBe(true);
    expect(list.find((a) => a.name === "claude")?.attention).toBe("needs-input");
  });

  it("notify reaches the human callback", async () => {
    await client.callTool({ name: "notify", arguments: { message: "need a decision", level: "warn" } });
    expect(notifications).toContainEqual({ message: "need a decision", level: "warn" });
  });

  it("kill_agent tears down; errors are structured isError results", async () => {
    await client.callTool({ name: "kill_agent", arguments: { name: "helper" } });
    expect(sessions.has(`tachyon-${HASH}-helper`)).toBe(false);
    const result = await client.callTool({ name: "kill_agent", arguments: { name: "helper" } });
    expect(result.isError).toBe(true);
  });

  it("wait_for_agent: immediate met on current state, gone for unknown agents", async () => {
    // claude's attentionOf is stubbed to needs-input in deps
    const met = await client.callTool({ name: "wait_for_agent", arguments: { name: "claude", until: "needs-input", timeoutSec: 1 } });
    expect(JSON.parse((met.content as Array<{ text: string }>)[0].text)).toMatchObject({ met: true, state: "needs-input" });

    const gone = await client.callTool({ name: "wait_for_agent", arguments: { name: "nope", until: "dead", timeoutSec: 1 } });
    expect(JSON.parse((gone.content as Array<{ text: string }>)[0].text)).toMatchObject({ met: true, state: "gone" });
  });

  it("rejects non-Bridge paths and non-POST methods", async () => {
    const notFound = await fetch(`http://127.0.0.1:${bridge.port}/other`, { method: "POST" });
    expect(notFound.status).toBe(404);
    const wrongMethod = await fetch(bridge.url!, { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("stable Bridge port", () => {
  it("derivePort is deterministic and in range", () => {
    const a = derivePort("e5d08dd8");
    expect(a).toBe(derivePort("e5d08dd8"));
    expect(a).toBeGreaterThanOrEqual(DERIVED_PORT_BASE);
    expect(a).toBeLessThan(DERIVED_PORT_BASE + DERIVED_PORT_SPAN);
    expect(derivePort("00000000")).toBe(DERIVED_PORT_BASE);
    expect(derivePort("abcdef12")).not.toBe(derivePort("12fedcba"));
  });

  it("binds the preferred port, and falls back when it is taken", async () => {
    const deps = {
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      notify: () => {},
    };
    const first = new Bridge(deps);
    const port = await first.start(); // ephemeral — gives us a known-taken port
    expect(first.usedFallback).toBe(false);

    const second = new Bridge(deps);
    const fallbackPort = await second.start(port); // preferred is busy
    expect(second.usedFallback).toBe(true);
    expect(fallbackPort).not.toBe(port);

    await second.dispose();
    await first.dispose();

    // Port now free again — a fresh Bridge binds it exactly.
    const third = new Bridge(deps);
    expect(await third.start(port)).toBe(port);
    expect(third.usedFallback).toBe(false);
    await third.dispose();
  });
});
