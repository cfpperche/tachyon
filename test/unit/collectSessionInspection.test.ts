import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSessionInspection } from "../../src/runtimeOps/collectSessionInspection.js";
import { REDACTED } from "../../src/runtimeOps/sessionInspection.js";

/**
 * t-283149 — the collector reads a real on-disk session layout and hands it to the pure projection.
 *
 * Driven through files rather than mocks because the layout IS the contract: these are the same paths
 * a launch writes, and a rename that broke them would pass a mock-shaped test while the panel showed
 * an empty session.
 */
describe("t-283149 — collecting what a session was given", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inspect-"));
    dirs.push(root);
    const dot = (...s: string[]) => path.join(root, ".tachyon", ...s);
    fs.mkdirSync(dot("harness", "claude"), { recursive: true });
    fs.mkdirSync(dot("spawn-settings"), { recursive: true });
    fs.mkdirSync(dot("bridge-mcp"), { recursive: true });

    fs.writeFileSync(dot("harness", "claude", "settings.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions", additionalDirectories: ["/tmp"] },
      theme: "dark-ansi",
      statusLine: { type: "command", command: "bash /home/x/.claude/statusline-command.sh" },
      autoMemoryEnabled: false,
    }));
    fs.writeFileSync(dot("harness", "claude", "mcp.json"), JSON.stringify({ mcpServers: { local: {} } }));
    fs.writeFileSync(dot("bridge-mcp", "claude.json"), JSON.stringify({ mcpServers: { tachyon_bridge: {} } }));

    const relay = path.join(root, "relay.relay.json");
    fs.writeFileSync(relay, JSON.stringify({ schemaVersion: 1, priorCommand: "bash /home/x/.claude/statusline-command.sh" }));
    fs.writeFileSync(dot("spawn-settings", "claude.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "node '/ws/.tachyon/activity/session-owner-record.cjs' 'claude'" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node '/ws/.tachyon/activity/persistence-stop-record.cjs' 'claude'" }] }],
      },
      skipDangerousModePermissionPrompt: true,
      statusLine: { type: "command", command: `node 'wrapper.cjs' '${relay}'` },
    }));
    return root;
  }

  const TOKEN = "fake-token-for-tests-0000000000000000";
  const livePorts = {
    panePid: async () => 4242,
    processArgv: () => [
      "claude", "--resume", "abc", "--settings", "harness/claude/settings.json",
      "--mcp-config", "x", "--strict-mcp-config", "--bridge-token", TOKEN,
    ],
    processEnv: () => ({
      TACHYON_AGENT_NAME: "claude",
      TACHYON_BRIDGE_TOKEN: TOKEN,
      CLAUDE_CONFIG_DIR: "/private/home",
      PATH: "/usr/bin",
    }),
  };

  it("reports a live session with the command redacted and the token key still visible", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspace(), agent: "claude", runtime: "claude", ports: livePorts,
    });

    expect(result.state).toBe("live");
    expect(result.command).toContain(REDACTED);
    expect(result.command.join(" ")).not.toContain(TOKEN);
    expect(result.strictMcp).toBe(true);
    expect(result.env).toEqual([
      { key: "CLAUDE_CONFIG_DIR", value: "/private/home" },
      { key: "TACHYON_AGENT_NAME", value: "claude" },
      { key: "TACHYON_BRIDGE_TOKEN", value: REDACTED },
    ]);
  });

  it("describes each injected hook with its purpose and sink", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspace(), agent: "claude", runtime: "claude", ports: livePorts,
    });

    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0]).toMatchObject({ event: "SessionStart", purpose: "records which agent owns this session" });
    expect(result.hooks[1]).toMatchObject({ event: "Stop", writes: ".tachyon/activity/persistence-stop.jsonl" });
    // Hooks live in their own section; repeating them as a settings row helps nobody.
    expect(result.settings.some((setting) => setting.key === "hooks")).toBe(false);
  });

  it("folds the wrapped status line into one row that names what it wraps", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspace(), agent: "claude", runtime: "claude", ports: livePorts,
    });

    const statusLines = result.settings.filter((setting) => setting.key === "statusLine");
    expect(statusLines).toHaveLength(1);
    expect(statusLines[0].origin).toBe("host");
    expect(statusLines[0].wraps).toBe("bash /home/x/.claude/statusline-command.sh");
  });

  it("attributes each settings key to its layer", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspace(), agent: "claude", runtime: "claude", ports: livePorts,
    });
    const originOf = (key: string) => result.settings.find((setting) => setting.key === key)?.origin;

    expect(originOf("permissions")).toBe("projected");
    expect(originOf("theme")).toBe("projected");
    expect(originOf("skipDangerousModePermissionPrompt")).toBe("host");
  });

  it("falls back to the last launch when no process is live, and says so", async () => {
    // An inspector that fails closed teaches nothing: the files still describe the last launch, and the
    // panel must say that is what it is showing rather than implying a running session.
    const result = await collectSessionInspection({
      workspaceRoot: workspace(),
      agent: "claude",
      runtime: "claude",
      ports: { panePid: async () => undefined, processArgv: () => undefined, processEnv: () => undefined },
    });

    expect(result.state).toBe("last-known");
    expect(result.command).toEqual([]);
    expect(result.hooks).toHaveLength(2); // still readable from disk
    expect(result.notExposed.join(" ")).toContain("no live process");
  });

  it("says outright when it cannot describe a runtime, instead of showing a confident blank", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspace(), agent: "claude", runtime: "hermes", ports: livePorts,
    });

    expect(result.notExposed.join(" ")).toContain("hermes");
  });

  it("survives a missing workspace without throwing", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inspect-empty-"));
    dirs.push(empty);

    const result = await collectSessionInspection({
      workspaceRoot: empty, agent: "ghost", runtime: "claude", ports: livePorts,
    });

    expect(result.hooks).toEqual([]);
    expect(result.settings.filter((setting) => setting.origin !== "not-projected")).toEqual([]);
  });
});

/**
 * t-283149 — the collector carries a copy of the projection's family allowlist, and a copy is a thing
 * that drifts. `FAMILY_KEYS` is the authority; this fails when the two disagree, so a key added there
 * cannot silently start showing as "not delivered to this agent" here.
 */
describe("t-283149 — the projectable-key list matches the projector", () => {
  it("lists exactly what claudeNativeConfigProjection projects", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/config/claudeNativeConfigProjection.ts"), "utf8");
    const block = /const FAMILY_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
    expect(block).toBeTruthy();
    const projected = new Set([...block![1].matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]));

    const collector = fs.readFileSync(path.join(process.cwd(), "src/runtimeOps/collectSessionInspection.ts"), "utf8");
    const listed = /projectableKeys:\s*\[([\s\S]*?)\]/.exec(collector);
    expect(listed).toBeTruthy();
    const mirrored = new Set([...listed![1].matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]));

    expect([...mirrored].sort()).toEqual([...projected].sort());
  });
});
