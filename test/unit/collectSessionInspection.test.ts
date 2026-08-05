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
 * t-a5d827 — Grok is a first-class reader, and secrets/session ids never reach the webview payload.
 *
 * Driven through the collector (not the reader alone) because redaction of argv session ids and
 * setting values is a RULE, and rules live here. A reader-only test would pass while the panel
 * still printed a uuid.
 */
describe("t-a5d827 — collecting a Grok session with no secrets on the wire", () => {
  const dirs: string[] = [];
  const originalHome = process.env.HOME;
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  const SESSION_ID = "a8f52d0c-a921-4b70-b346-d4ca7077a991";
  const TOKEN = "fake-token-for-tests-0000000000000000";
  const CREDENTIAL = "REAL-SECRET-DO-NOT-SURFACE-9f3a";

  function grokWorkspace(): { root: string; grokHome: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inspect-grok-"));
    dirs.push(root);
    const grokHome = path.join(root, ".tachyon", "bridge-mcp", "solo.grok");
    const realHome = path.join(root, "home");
    fs.mkdirSync(path.join(grokHome, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(realHome, ".grok"), { recursive: true });
    process.env.HOME = realHome;

    fs.writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({ access_token: CREDENTIAL }));
    fs.writeFileSync(path.join(grokHome, "config.toml"), [
      "[memory]",
      "enabled = false",
      "",
      "[compat.claude]",
      "skills = false",
      "",
      "[mcp_servers.tachyon_bridge]",
      'url = "http://127.0.0.1:9/mcp"',
      `headers = { "Authorization" = "Bearer \${TACHYON_AGENT_BRIDGE_TOKEN}", "X-Leak" = "${CREDENTIAL}" }`,
    ].join("\n"));
    fs.writeFileSync(path.join(grokHome, "hooks", "session-start.json"), JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume",
          hooks: [{ type: "command", command: "node '/ws/.tachyon/activity/session-owner-record.cjs' 'solo'" }],
        }],
      },
    }));
    fs.writeFileSync(path.join(realHome, ".grok", "config.toml"), 'permission_mode = "always-approve"\n');
    return { root, grokHome };
  }

  it("registers grok and redacts the session id, bridge token, and leaked credential values", async () => {
    const { root, grokHome } = grokWorkspace();
    const result = await collectSessionInspection({
      workspaceRoot: root,
      agent: "solo",
      runtime: "grok",
      ports: {
        panePid: async () => 99,
        processArgv: () => [
          "grok", "-s", SESSION_ID, "--always-approve",
          "── TACHYON PRIMER ──\n" + "brief ".repeat(80) + "\n── END ──",
          "--no-memory",
        ],
        processEnv: () => ({
          GROK_HOME: grokHome,
          HOME: grokHome, // co-bound
          GROK_MEMORY: "0",
          TACHYON_AGENT_NAME: "solo",
          TACHYON_BRIDGE_TOKEN: TOKEN,
          TACHYON_AGENT_BRIDGE_TOKEN: TOKEN,
        }),
      },
    });

    expect(result.runtime).toBe("grok");
    expect(result.state).toBe("live");
    expect(result.hooks.some((hook) => hook.event === "SessionStart")).toBe(true);
    expect(result.settings.some((setting) => setting.key === "memory.enabled" && setting.origin === "host")).toBe(true);
    expect(result.env.some((entry) => entry.key === "GROK_MEMORY" && entry.value === "0")).toBe(true);
    expect(result.env.some((entry) => entry.key === "TACHYON_BRIDGE_TOKEN" && entry.value === REDACTED)).toBe(true);

    const wire = JSON.stringify(result);
    expect(wire).not.toContain(SESSION_ID);
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain(CREDENTIAL);
    expect(result.command.join(" ")).toContain("[session id — not shown]");
    expect(result.command.join(" ")).toContain("[opening brief");
    // Env-ref form of the Authorization header stays — it is the mechanism, not a secret.
    expect(result.settings.some((setting) =>
      setting.key.includes("Authorization") && setting.value.includes("${TACHYON_AGENT_BRIDGE_TOKEN}"),
    )).toBe(true);
  });

  it("no longer claims Grok is undescribed", async () => {
    const { root, grokHome } = grokWorkspace();
    const result = await collectSessionInspection({
      workspaceRoot: root,
      agent: "solo",
      runtime: "grok",
      ports: {
        panePid: async () => undefined,
        processArgv: () => undefined,
        processEnv: () => undefined,
      },
    });
    // Force the home via disk layout (no live env): reader falls back to bridge-mcp/solo.grok.
    expect(fs.existsSync(path.join(grokHome, "config.toml"))).toBe(true);
    expect(result.notExposed.join(" ")).not.toMatch(/does not yet describe/);
    expect(result.notExposed.join(" ")).toContain("no live process");
  });
});

/**
 * t-141f61 — the session must carry the gate it did NOT get, and the reason.
 *
 * Driven through the collector with a real lockfile on disk because that is the authority every spawn
 * door reads: a mock would prove the panel can render a sentence, not that it asks the same question
 * the projector answers. The lie being closed is silence — a Grok agent with no `PreToolUse` gate and
 * a hook list that looks merely short.
 */
describe("t-141f61 — a withheld enforcement gate reaches the session projection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** `secrets-guard` as it was measured: claude and codex blocks, no grok block. */
  function workspaceWithGate(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inspect-gate-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    const lock = {
      schemaVersion: 1,
      plugins: {
        // Installed and unclassified: proves the panel reports what the human ASKED for, not every
        // plugin that happens not to project. Thirteen of these rows would bury the one that matters.
        sdd: {
          name: "sdd",
          version: "1.7.1",
          runtimes: ["claude"],
          targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/sdd" }],
        },
        "secrets-guard": {
          name: "secrets-guard",
          version: "2.0.4",
          runtimes: ["claude", "codex"],
          targets: [{
            runtime: "claude",
            kind: "settings-hook",
            file: ".claude/settings.json",
            ref: "PreToolUse",
            removal: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash guard.sh" }] }],
          }],
        },
      },
    };
    fs.writeFileSync(path.join(root, ".tachyon", "plugins.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    return root;
  }

  const OFFLINE = { panePid: async () => undefined, processArgv: () => undefined, processEnv: () => undefined };

  it("tells a grok session that the classified gate never reached it, and why", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspaceWithGate(),
      agent: "solo",
      runtime: "grok",
      ports: OFFLINE,
      hookProjectionPolicy: { "secrets-guard": "enforcement" },
    });

    expect(result.gatesWithheld).toEqual([{
      plugin: "secrets-guard",
      reason: "installs no grok settings-hook — its manifest declares no grok block",
    }]);
  });

  it("withholds nothing from the runtime the gate does reach", async () => {
    // The other polarity, and the one that keeps the row meaningful: a false alarm on claude would
    // train the reader to skip the section on grok.
    const result = await collectSessionInspection({
      workspaceRoot: workspaceWithGate(),
      agent: "claude",
      runtime: "claude",
      ports: OFFLINE,
      hookProjectionPolicy: { "secrets-guard": "enforcement" },
    });

    expect(result.gatesWithheld).toEqual([]);
  });

  it("reports only plugins the workspace classified", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspaceWithGate(),
      agent: "solo",
      runtime: "grok",
      ports: OFFLINE,
      hookProjectionPolicy: { "secrets-guard": "enforcement" },
    });

    expect(result.gatesWithheld.map((gate) => gate.plugin)).not.toContain("sdd");
  });

  it("names a runtime with no channel at all rather than showing an empty list", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspaceWithGate(),
      agent: "hermes",
      runtime: "hermes",
      ports: OFFLINE,
      hookProjectionPolicy: { "secrets-guard": "enforcement" },
    });

    expect(result.gatesWithheld).toHaveLength(1);
    expect(result.gatesWithheld[0].reason).toContain("no Tachyon-owned per-spawn hook channel");
  });

  it("stays empty when the workspace classified nothing", async () => {
    const result = await collectSessionInspection({
      workspaceRoot: workspaceWithGate(), agent: "solo", runtime: "grok", ports: OFFLINE,
    });

    expect(result.gatesWithheld).toEqual([]);
  });
});

/**
 * t-0c963d — the rules file must not learn where any runtime keeps its files.
 *
 * The split exists so a rule fixed once is fixed for every runtime. It survives only while
 * `collectSessionInspection.ts` holds no path knowledge: the moment someone adds `if (runtime ===
 * "codex")` and a filename there, Codex has a second path to the same effect and Claude's rules stop
 * being the only rules — the shape t-b4a799 catalogued after five instances in one day.
 *
 * A comment asking for the discipline is what t-e73e54 proved worthless, so this asserts it.
 */
describe("t-0c963d — the collector holds rules, and readers hold paths", () => {
  // Comments MUST be stripped: this file's own doc comment names `config.toml` to explain why Codex
  // gets its own reader, and that sentence is the opposite of the violation. A guard that reads prose
  // measures prose.
  const RULES = fs.readFileSync(path.join(process.cwd(), "src/runtimeOps/collectSessionInspection.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("names no runtime's config location", () => {
    for (const marker of ["spawn-settings", "harness", "bridge-mcp", "settings.json", "config.toml", "mcp.json"]) {
      expect(RULES).not.toContain(marker);
    }
  });

  it("branches on no runtime by name", () => {
    // Dispatch is the reader registry. A named branch here is the same defect wearing a switch.
    expect(RULES).not.toMatch(/runtime\s*===\s*["']/);
  });
});

/**
 * t-283149 — the reader carries a copy of the projection's family allowlist, and a copy is a thing
 * that drifts. `FAMILY_KEYS` is the authority; this fails when the two disagree, so a key added there
 * cannot silently start showing as "not delivered to this agent" here.
 */
describe("t-283149 — the projectable-key list matches the projector", () => {
  it("lists exactly what claudeNativeConfigProjection projects", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/config/claudeNativeConfigProjection.ts"), "utf8");
    const block = /const FAMILY_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
    expect(block).toBeTruthy();
    const projected = new Set([...block![1].matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]));

    const reader = fs.readFileSync(path.join(process.cwd(), "src/runtimeOps/claudeSessionReader.ts"), "utf8");
    const listed = /projectableKeys:\s*\[([\s\S]*?)\]/.exec(reader);
    expect(listed).toBeTruthy();
    const mirrored = new Set([...listed![1].matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]));

    expect([...mirrored].sort()).toEqual([...projected].sort());
  });
});
