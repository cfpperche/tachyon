import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "../../src/bridge/Bridge.js";
import { loadOrCreateExternalToken, loadOrCreateToken, tokenMatches } from "../../src/bridge/token.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import {
  buildClaudeMcpJson,
  buildOpencodeJson,
  codexSnippet,
  buildOffers,
  claudeAlreadyRegistered,
  TOKEN_ENV_REF_CLAUDE,
} from "../../src/registration/adapters.js";
import { makeTempDir } from "../helpers/tempDir.js";

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

  it("creates a stable external token distinct from the legacy master token", () => {
    const master = loadOrCreateToken(dir, "external1111");
    const external = loadOrCreateExternalToken(dir, "external1111", master);
    expect(external).toMatch(/^[0-9a-f]{64}$/);
    expect(external).not.toBe(master);
    expect(loadOrCreateExternalToken(dir, "external1111", master)).toBe(external);
    const mode = fs.statSync(path.join(dir, "bridge-external-token-external1111")).mode & 0o777;
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
    });
    const root = makeTempDir("tachyon-auth-");
    return { workspaceRoot: root, manager, tmux, pins: new PinStore(root), tasks: new TaskStore(root), validations: new ValidationStore(root), notify: () => {} };
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
      expect(tools.length).toBe(80); // t-167b5c added read_notices (77 → 78); t-1926ce added worktree_process_hygiene (78 → 79); SDD 494 Part 4 added reconcile_roster (79 → 80). bridge.test.ts holds the by-name inventory.
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
      expect((await client.listTools()).tools.length).toBe(80); // t-167b5c added read_notices (77 → 78); t-1926ce added worktree_process_hygiene (78 → 79); SDD 494 Part 4 added reconcile_roster (79 → 80). bridge.test.ts holds the by-name inventory.
      await client.close();
    } finally {
      await bridge.dispose();
    }
  });
});

describe("Bridge caller resolution (spec 351 T3)", () => {
  const MASTER = "b".repeat(64);
  const SCOPE = { workspaceId: "ws-1", instanceId: "inst-1" };

  function minimalDeps() {
    const exec = async (): Promise<ExecResult> => ({ stdout: "", stderr: "" });
    const tmux = new TmuxService(exec);
    const manager = new AgentManager({
      tmux,
      wsHash: "deadbeef",
      workspaceRoot: "/tmp",
      getConfig: () => undefined,
    });
    const root = makeTempDir("tachyon-caller-auth-");
    return { workspaceRoot: root, manager, tmux, pins: new PinStore(root), tasks: new TaskStore(root), validations: new ValidationStore(root), notify: () => {} };
  }

  it("an agent's per-agent token authenticates end-to-end (a real MCP handshake)", async () => {
    const registry = new CallerIdentityRegistry(Buffer.from("k".repeat(64), "hex"));
    const agentToken = registry.mint("claude", SCOPE);
    const bridge = new Bridge(minimalDeps(), { token: MASTER, getRegistry: () => registry, scope: SCOPE });
    await bridge.start();
    try {
      const client = new Client({ name: "agent", version: "0.0.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } }),
      );
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      await bridge.dispose();
    }
  });



  it("a revoked agent token is rejected with 401 + reason token_revoked (not a generic message)", async () => {
    const registry = new CallerIdentityRegistry(Buffer.from("k".repeat(64), "hex"));
    const agentToken = registry.mint("claude", SCOPE);
    registry.revoke("claude", SCOPE);
    const bridge = new Bridge(minimalDeps(), { token: MASTER, getRegistry: () => registry, scope: SCOPE });
    await bridge.start();
    try {
      const res = await fetch(bridge.url!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
        body: "{}",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason?: string };
      expect(body.reason).toBe("token_revoked");
    } finally {
      await bridge.dispose();
    }
  });

  it("the shared master token resolves as legacy when compat is ON, and legacy_unvalidated when compat is OFF", async () => {
    const onLegacy: Array<{ tool: string; claimedIdentity?: string }> = [];
    const bridgeOn = new Bridge(minimalDeps(), { token: MASTER, legacyCompatEnabled: true, onLegacyCall: (info) => onLegacy.push(info) });
    await bridgeOn.start();
    try {
      const client = new Client({ name: "legacy", version: "0.0.1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridgeOn.url!), { requestInit: { headers: { Authorization: `Bearer ${MASTER}` } } }));
      await client.listTools();
      const pins = await client.callTool({ name: "list_pins", arguments: {} });
      expect(pins.isError).not.toBe(true);
      await client.close();
      expect(onLegacy.some((c) => c.tool === "list_pins")).toBe(true);
    } finally {
      await bridgeOn.dispose();
    }

    const bridgeOff = new Bridge(minimalDeps(), { token: MASTER, legacyCompatEnabled: false });
    await bridgeOff.start();
    try {
      const res = await fetch(bridgeOff.url!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${MASTER}` },
        body: "{}",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason?: string };
      expect(body.reason).toBe("legacy_unvalidated");
    } finally {
      await bridgeOff.dispose();
    }
  });

  it("a dedicated external token authenticates while the legacy master is rejected with compat OFF", async () => {
    const external = "c".repeat(64);
    const bridge = new Bridge(minimalDeps(), { token: MASTER, externalToken: external, legacyCompatEnabled: false });
    await bridge.start();
    try {
      const rejectedMaster = await fetch(bridge.url!, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${MASTER}` },
        body: "{}",
      });
      expect(rejectedMaster.status).toBe(401);
      expect(((await rejectedMaster.json()) as { reason?: string }).reason).toBe("legacy_unvalidated");

      const client = new Client({ name: "external", version: "0.0.1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${external}` } } }));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const claimedAgent = await client.callTool({ name: "create_pin", arguments: { title: "external", agent: "claude" } });
      expect(claimedAgent.isError).toBe(true);
      expect(JSON.stringify(claimedAgent.content)).toContain("master_claim_denied");
      await client.close();
    } finally {
      await bridge.dispose();
    }
  });

  it("logs the claimed identity param when a legacy call declares one", async () => {
    const onLegacy: Array<{ tool: string; claimedIdentity?: string }> = [];
    const deps = minimalDeps();
    const bridge = new Bridge(deps, { token: MASTER, legacyCompatEnabled: true, onLegacyCall: (info) => onLegacy.push(info) });
    await bridge.start();
    try {
      const client = new Client({ name: "legacy", version: "0.0.1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!), { requestInit: { headers: { Authorization: `Bearer ${MASTER}` } } }));
      await client.callTool({ name: "create_pin", arguments: { title: "hello", agent: "reviewer" } });
      await client.close();
      expect(onLegacy.some((c) => c.tool === "create_pin" && c.claimedIdentity === "reviewer")).toBe(true);
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
