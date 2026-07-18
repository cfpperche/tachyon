import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import tachyonPiBridge from "../../src/pi-bridge-extension/index.js";
import { projectMcpContent, projectMcpTool } from "../../src/pi-bridge-extension/toolProjection.js";

describe("Pi Bridge extension projection", () => {
  it("projects MCP metadata/schema into a native Pi tool and forwards arguments + cancellation", async () => {
    const signal = new AbortController().signal;
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "fleet ok" }],
      structuredContent: { count: 2 },
    }));
    const inputSchema = {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    };
    const projected = projectMcpTool(
      { name: "list_agents", title: "List agents", description: "Read the fleet", inputSchema },
      { callTool },
      (schema) => schema,
    );

    expect(projected).toMatchObject({
      name: "list_agents",
      label: "List agents",
      description: "Read the fleet",
      parameters: inputSchema,
    });
    await expect(projected.execute("call-1", { agent: "pi" }, signal)).resolves.toEqual({
      content: [{ type: "text", text: "fleet ok" }],
      details: { bridgeTool: "list_agents", structuredContent: { count: 2 } },
    });
    expect(callTool).toHaveBeenCalledWith(
      { name: "list_agents", arguments: { agent: "pi" } },
      undefined,
      { signal },
    );
  });

  it("preserves images, serializes other MCP content, and uses structured content as a fallback", () => {
    expect(projectMcpContent({ content: [
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///x" } },
    ] })).toEqual([
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ type: "resource", resource: { uri: "file:///x" } }) },
    ]);
    expect(projectMcpContent({ structuredContent: { ok: true } })).toEqual([
      { type: "text", text: JSON.stringify({ ok: true }, null, 2) },
    ]);
  });

  it("surfaces missing process-scoped configuration without aborting Pi startup", async () => {
    const priorUrl = process.env.TACHYON_BRIDGE_URL;
    const priorAgentToken = process.env.TACHYON_AGENT_BRIDGE_TOKEN;
    const priorToken = process.env.TACHYON_BRIDGE_TOKEN;
    delete process.env.TACHYON_BRIDGE_URL;
    delete process.env.TACHYON_AGENT_BRIDGE_TOKEN;
    delete process.env.TACHYON_BRIDGE_TOKEN;
    const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const notify = vi.fn();
    try {
      await tachyonPiBridge({
        registerCommand: (name, command) => commands.set(name, command as never),
        registerTool: vi.fn(),
        on: (event, handler) => handlers.set(event, handler as never),
      });
      await commands.get("tachyon-bridge-status")!.handler("", { ui: { notify } });
      expect(notify).toHaveBeenCalledWith(
        "Tachyon Bridge: disconnected (TACHYON_BRIDGE_URL is missing)",
        "warning",
      );
      expect(handlers.has("session_shutdown")).toBe(true);
    } finally {
      if (priorUrl === undefined) delete process.env.TACHYON_BRIDGE_URL; else process.env.TACHYON_BRIDGE_URL = priorUrl;
      if (priorAgentToken === undefined) delete process.env.TACHYON_AGENT_BRIDGE_TOKEN; else process.env.TACHYON_AGENT_BRIDGE_TOKEN = priorAgentToken;
      if (priorToken === undefined) delete process.env.TACHYON_BRIDGE_TOKEN; else process.env.TACHYON_BRIDGE_TOKEN = priorToken;
    }
  });

  it("SDD 405 records exact Pi ownership on every session_start without requiring Bridge connectivity", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-owner-"));
    const owners = path.join(temp, "activity", "session-owners.jsonl");
    const prior = {
      url: process.env.TACHYON_BRIDGE_URL,
      owner: process.env.TACHYON_PI_SESSION_OWNER_FILE,
      agent: process.env.TACHYON_AGENT_NAME,
    };
    delete process.env.TACHYON_BRIDGE_URL;
    process.env.TACHYON_PI_SESSION_OWNER_FILE = owners;
    process.env.TACHYON_AGENT_NAME = "pi-a";
    const handlers = new Map<string, (...args: any[]) => unknown>();
    try {
      await tachyonPiBridge({
        registerCommand: vi.fn(), registerTool: vi.fn(),
        on: (event, handler) => handlers.set(event, handler as never),
      });
      handlers.get("session_start")!({ reason: "fork" }, {
        ui: { setStatus: vi.fn() },
        sessionManager: {
          getSessionId: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          getSessionFile: () => "/private/pi-a/sessions/fork.jsonl",
          getCwd: () => "/workspace",
        },
      });
      expect(JSON.parse(fs.readFileSync(owners, "utf8").trim())).toMatchObject({
        agent: "pi-a",
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        transcriptPath: "/private/pi-a/sessions/fork.jsonl",
        cwd: "/workspace",
        source: "pi:fork",
        ts: expect.any(String),
      });
    } finally {
      if (prior.url === undefined) delete process.env.TACHYON_BRIDGE_URL; else process.env.TACHYON_BRIDGE_URL = prior.url;
      if (prior.owner === undefined) delete process.env.TACHYON_PI_SESSION_OWNER_FILE; else process.env.TACHYON_PI_SESSION_OWNER_FILE = prior.owner;
      if (prior.agent === undefined) delete process.env.TACHYON_AGENT_NAME; else process.env.TACHYON_AGENT_NAME = prior.agent;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("turns MCP isError results into native tool failures with the Bridge message", async () => {
    const projected = projectMcpTool(
      { name: "verify_task", inputSchema: { type: "object" } },
      { callTool: async () => ({ isError: true, content: [{ type: "text", text: "verification blocked" }] }) },
      (schema) => schema,
    );
    await expect(projected.execute("call-2", {})).rejects.toThrow("verification blocked");
  });
});
