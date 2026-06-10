import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "../../src/bridge/Bridge.js";
import { loadOrCreateToken, tokenMatches } from "../../src/bridge/token.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import {
  buildClaudeMcpJson,
  buildOpencodeJson,
  codexSnippet,
  buildOffers,
  claudeAlreadyRegistered,
  TOKEN_ENV_REF_CLAUDE,
} from "../../src/registration/adapters.js";

const URL_ = "http://127.0.0.1:43210/mcp";

describe("token store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-token-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates once, persists, and is distinct per workspace", () => {
    const a1 = loadOrCreateToken(dir, "aaaa1111");
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(dir, "aaaa1111")).toBe(a1); // stable across reads
    expect(loadOrCreateToken(dir, "bbbb2222")).not.toBe(a1);
    const mode = fs.statSync(path.join(dir, "bridge-token-aaaa1111")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tokenMatches is exact and rejects absent/wrong values", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secret2", "secret")).toBe(false);
    expect(tokenMatches(undefined, "secret")).toBe(false);
    expect(tokenMatches("", "secret")).toBe(false);
  });
});

describe("Bridge auth enforcement (live HTTP)", () => {
  const TOKEN = "a".repeat(64);

  function minimalDeps() {
    const exec = async (): Promise<ExecResult> => ({ stdout: "", stderr: "" });
    const tmux = new TmuxService(exec);
    const manager = new AgentManager({
      tmux,
      wsHash: "deadbeef",
      workspaceRoot: "/tmp",
      getConfig: () => undefined,
      getMaxAgents: () => 8,
    });
    return { manager, tmux, pins: new PinStore(fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-auth-pins-"))), notify: () => {} };
  }

  it("rejects missing/wrong bearer with 401 and accepts the right one end-to-end", async () => {
    const bridge = new Bridge(minimalDeps(), { token: TOKEN });
    await bridge.start();
    try {
      const noAuth = await fetch(bridge.url!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(noAuth.status).toBe(401);

      const wrong = await fetch(bridge.url!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: "{}",
      });
      expect(wrong.status).toBe(401);

      // Full MCP handshake with the right token — the real client path.
      const client = new Client({ name: "authed", version: "0.0.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(bridge.url!), {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.length).toBe(13);
      await client.close();
    } finally {
      await bridge.dispose();
    }
  });

  it("no token configured (settings.auth: false) keeps the Bridge open", async () => {
    const bridge = new Bridge(minimalDeps());
    await bridge.start();
    try {
      const client = new Client({ name: "open", version: "0.0.1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!)));
      expect((await client.listTools()).tools.length).toBe(13);
      await client.close();
    } finally {
      await bridge.dispose();
    }
  });
});

describe("env injection into spawned sessions", () => {
  it("spawn passes TACHYON_BRIDGE_URL/TOKEN via -e; agent-declared env wins", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      calls.push(args);
      if (args[2] === "has-session" || args[2] === "list-panes") throw new Error("none");
      return { stdout: "", stderr: "" };
    };
    const config = parseConfig("agents:\n  a:\n    cmd: x\n    env:\n      TACHYON_BRIDGE_URL: \"custom\"\n").config;
    const manager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: workspaceHash("/repo"),
      workspaceRoot: "/repo",
      getConfig: () => config,
      getMaxAgents: () => 8,
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:41931/mcp", TACHYON_BRIDGE_TOKEN: "tok123" }),
    });
    await manager.spawn("a");
    const spawnArgs = calls.find((c) => c.includes("new-session"))!;
    expect(spawnArgs).toContain("TACHYON_BRIDGE_TOKEN=tok123");
    expect(spawnArgs).toContain("TACHYON_BRIDGE_URL=custom"); // declared env overrides injected
    expect(spawnArgs).not.toContain("TACHYON_BRIDGE_URL=http://127.0.0.1:41931/mcp");
  });
});

describe("auth-aware registration", () => {
  it("claude entry carries the env-var header reference (no literal secret)", () => {
    const out = JSON.parse(buildClaudeMcpJson(undefined, URL_, true));
    expect(out.mcpServers.tachyon.headers.Authorization).toBe(TOKEN_ENV_REF_CLAUDE);
    expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{64}/);
    expect(claudeAlreadyRegistered(JSON.stringify(out), URL_, true)).toBe(true);
    // an auth-less legacy entry is NOT up to date once auth is on
    const legacy = buildClaudeMcpJson(undefined, URL_, false);
    expect(claudeAlreadyRegistered(legacy, URL_, true)).toBe(false);
  });

  it("opencode entry and codex snippet reference the env var", () => {
    const oc = JSON.parse(buildOpencodeJson(undefined, URL_, true));
    expect(oc.mcp.tachyon.headers.Authorization).toContain("TACHYON_BRIDGE_TOKEN");
    expect(codexSnippet(URL_, true)).toContain('bearer_token_env_var = "TACHYON_BRIDGE_TOKEN"');
  });

  it("buildOffers threads the auth flag into upToDate and notes", () => {
    const current = buildClaudeMcpJson(undefined, URL_, true);
    const offers = buildOffers(URL_, { claudeMcpJson: current }, true);
    const claude = offers.find((o) => o.runtime === "claude-code")!;
    expect(claude.upToDate).toBe(true);
    expect(claude.notes).toContain("TACHYON_BRIDGE_TOKEN");
    const generic = offers.find((o) => o.runtime === "generic")!;
    expect(generic.notes).toContain("Authorization");
  });
});

describe("settings.auth config", () => {
  it("parses the flag and rejects non-booleans", () => {
    const base = "agents:\n  a:\n    cmd: x\n";
    expect(parseConfig(`${base}settings:\n  auth: false\n`).config?.settings.auth).toBe(false);
    expect(parseConfig(base).config?.settings.auth).toBeUndefined(); // default decided by the extension (true)
    expect(parseConfig(`${base}settings:\n  auth: "no"\n`).errors[0]).toContain("settings.auth");
  });
});
