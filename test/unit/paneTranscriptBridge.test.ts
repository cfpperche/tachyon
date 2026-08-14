import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "@tachyon/engine/bridge/Bridge.js";
import { AgentManager } from "@tachyon/engine/agents/AgentManager.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { PinStore } from "@tachyon/engine/pins/PinStore.js";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { ValidationStore } from "@tachyon/engine/validations/ValidationStore.js";
import { ensurePaneTranscriptFile } from "@tachyon/engine/agents/paneTranscript.js";

/**
 * t-6a6a00 — end-to-end Bridge coverage for the durable pipe-pane transcript READ path
 * (postmortemTailFor / read_output / list_agents' outputCapabilities), using a REAL writable
 * workspace root for both AgentManager and Bridge (unlike bridge.test.ts's shared fixture, which
 * intentionally uses a symbolic "/repo" root for AgentManager — fine for tmux-arg assertions, but
 * unusable here since the durable transcript is a real on-disk file).
 */

function fakeTmuxExec() {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
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
        return { stdout: [...sessions].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, exec };
}

describe("Bridge durable pane-transcript read path (t-6a6a00)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pipepane-bridge-"));
  const hash = workspaceHash(ws);
  const { sessions, exec } = fakeTmuxExec();
  const tmux = new TmuxService(exec);
  const config = parseConfig("agents:\n  worker:\n    cmd: sh\n").config;
  const manager = new AgentManager({ tmux, wsHash: hash, workspaceRoot: ws, getConfig: () => config });
  const pins = new PinStore(ws);
  const tasks = new TaskStore(ws);
  const validations = new ValidationStore(ws);
  const bridge = new Bridge({
    workspaceRoot: ws,
    manager,
    tmux,
    pins,
    tasks,
    validations,
    notify: () => {},
  });
  let client: Client;

  beforeAll(async () => {
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    client = new Client({ name: "test-agent", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!)));
    await manager.spawn("worker");
  });

  afterAll(async () => {
    await client.close();
    await bridge.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("read_output falls back to the durable transcript when no live session and nothing is retained in memory", async () => {
    const session = sessionName(hash, "worker");
    expect(sessions.has(session)).toBe(true);
    await manager.kill("worker"); // declared agent — kill stops it but keeps its ledger-less row listable
    expect(sessions.has(session)).toBe(false);

    // Simulate what a real tmux pipe-pane would have written continuously to the durable file
    // (the fake executor above never runs a real shell, so nothing gets piped to disk for real).
    const file = ensurePaneTranscriptFile(ws, "worker");
    fs.writeFileSync(file, "\x1b[32mgreen\x1b[0m durable output line\n", "utf8");

    const result = await client.callTool({ name: "read_output", arguments: { name: "worker" } });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed).toMatchObject({ postmortem: true, source: "durable" });
    expect(parsed.output).toBe("green durable output line"); // ANSI stripped
  });

  it("list_agents surfaces postmortem availability via the durable transcript (outputCapabilities)", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    const list = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Array<{ name: string; capabilities?: { canReadOutput: boolean; readOutputState: string } }>;
    const worker = list.find((a) => a.name === "worker");
    expect(worker?.capabilities).toMatchObject({ canReadOutput: true, readOutputState: "postmortem" });
  });

  it("read_output redacts a known secret found in the durable transcript (SECURITY: read-time redaction)", async () => {
    const secret = "s".repeat(40);
    const file = ensurePaneTranscriptFile(ws, "worker");
    fs.writeFileSync(file, `TACHYON_BRIDGE_TOKEN=${secret}\n`, "utf8");
    const result = await client.callTool({ name: "read_output", arguments: { name: "worker" } });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.output).not.toContain(secret);
    expect(parsed.output).toContain("[redacted]");
  });
});
