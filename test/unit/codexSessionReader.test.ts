import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexSessionReader } from "@tachyon/engine/runtimeOps/codexSessionReader.js";

/**
 * t-0c963d — the Codex reader, driven by the argv and files a real session actually has.
 *
 * Every fixture here is shortened from a live `codex` session measured on 2026-07-31, not invented.
 * That matters twice over: reading the code first told me Codex writes its hooks to a file (it does
 * not — they ride the argv), and the panel's whole purpose is to stop guessing about what a runtime
 * was handed.
 */
describe("t-0c963d — reading what a Codex session was given", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function homes(): { codexHome: string; realHome: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-"));
    dirs.push(root);
    const codexHome = path.join(root, "harness", "codex");
    const realHome = path.join(root, "home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(realHome, ".codex"), { recursive: true });

    // The projected file, exactly the shape a canonical profile produces: six allowlist keys plus the
    // `[projects]` trust block Tachyon writes itself.
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'personality = "pragmatic"',
      "",
      "[tui]",
      'status_line = ["model-with-reasoning", "git-branch"]',
      "status_line_use_colors = true",
      "",
      "[features]",
      "terminal_resize_reflow = true",
      "",
      '[projects."/ws"]',
      'trust_level = "trusted"',
    ].join("\n"));

    // The person's own global: real settings that do NOT cross, plus two ledgers that are not settings.
    fs.writeFileSync(path.join(realHome, ".codex", "config.toml"), [
      'model = "gpt-5.1-codex"',
      'model_reasoning_effort = "high"',
      'service_tier = "priority"',
      "",
      '[projects."/home/someone/other-repo"]',
      'trust_level = "trusted"',
      "",
      "[hooks.state]",
      '"/<session-flags>/config.toml:session_start:0:0".trusted_hash = "abc123"',
      "",
      "[plugins]",
      '"github@openai-curated".enabled = true',
    ].join("\n"));
    return { codexHome, realHome };
  }

  const HOOKS_ARG = 'hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",'
    + 'command="node \'/ws/.tachyon/activity/session-owner-record.cjs\'",statusMessage="Recording"}]}]';
  const STOP_ARG = 'hooks.Stop=[{hooks=[{type="command",command="node \'/ws/.tachyon/activity/'
    + 'persistence-stop-record.cjs\'",statusMessage="Recording"}]}]';
  const BRIDGE_ARG = 'mcp_servers.tachyon_bridge={url="http://127.0.0.1:42897/mcp", '
    + 'bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"}';

  function read(overrides: { argv?: string[] } = {}) {
    const { codexHome, realHome } = homes();
    return codexSessionReader.read({
      workspaceRoot: "/ws",
      agent: "codex",
      env: { CODEX_HOME: codexHome, HOME: realHome },
      argv: "argv" in overrides
        ? overrides.argv
        : ["codex", "--dangerously-bypass-hook-trust", "-c", HOOKS_ARG, "-c", STOP_ARG, "-c", BRIDGE_ARG],
    });
  }

  it("finds the hooks in the ARGV, where Codex actually carries them", () => {
    // The measurement that corrected this task's own body. Nothing on disk holds these.
    const hooks = read().hooks;

    expect(hooks.map((hook) => hook.event)).toEqual(["SessionStart", "Stop"]);
    expect(hooks[0].purpose).toBe("records which agent owns this session");
    expect(hooks[1].writes).toBe(".tachyon/activity/persistence-stop.jsonl");
  });

  it("says outright that hooks are unreadable without a live process", () => {
    // Claude's hooks survive in a file, so its `last-known` state still lists them. Codex's do not
    // exist anywhere but the argv — and rendering that as "no hooks" would be the same lie the
    // runtime's own /hooks tells, which is the reason this panel was built.
    const found = read({ argv: undefined });

    expect(found.hooks).toEqual([]);
    expect(found.notExposed.join(" ")).toContain("cannot be read without a live process");
  });

  it("keys settings by dotted path, matching how the Codex allowlist names them", () => {
    // `tui.status_line` is in the family list; a flat `tui` key would classify every nested setting
    // as never-delivered, which is the most misleading row this panel can print.
    const keys = read().settings.map((setting) => setting.key);

    expect(keys).toContain("tui.status_line");
    expect(keys).toContain("features.terminal_resize_reflow");
    expect(keys).not.toContain("tui");
  });

  it("attributes the trust block Tachyon writes to the host, not to the person", () => {
    // Codex has ONE config file, so the layer cannot be inferred from which file a key came from.
    const projects = read().settings.filter((setting) => setting.key.startsWith("projects."));

    expect(projects).toHaveLength(1);
    expect(projects[0].hostAuthored).toBe(true);
  });

  it("reports the global settings that never reach the agent", () => {
    const globalKeys = read().globalKeys;

    expect(globalKeys).toContain("model");
    expect(globalKeys).toContain("model_reasoning_effort");
    expect(globalKeys).toContain("service_tier");
  });

  it("excludes Codex's two LEDGERS, which are not settings and were never addressed to the agent", () => {
    // Measured before this filter: ~30 rows of trust records buried the four that matter. Calling a
    // trust record "not delivered to this agent" is also simply false.
    const globalKeys = read().globalKeys;

    expect(globalKeys.some((key) => key.startsWith("projects."))).toBe(false);
    expect(globalKeys.some((key) => key.startsWith("hooks.state."))).toBe(false);
    // A plugin the person enabled IS a setting that does not cross — that row stays.
    expect(globalKeys.some((key) => key.startsWith("plugins."))).toBe(true);
  });

  it("collects MCP servers from the argv override, since Codex has no mcp file", () => {
    expect(read().mcpServers).toEqual(["tachyon_bridge"]);
  });

  it("states that MCP isolation comes from CODEX_HOME rather than a strict-config flag", () => {
    // Codex has no --strict-mcp-config, so the shared `strictMcp: false` would otherwise imply the
    // session can load ambient servers. It cannot: the redirected home is the only config it reads.
    expect(read().notExposed.join(" ")).toContain("redirected CODEX_HOME");
  });

  it("t-aaa2c6: reads the permission keys a delegated child receives on the ARGV, not just the file", () => {
    // A delegated Codex child is handed its approval posture as `-c` overrides — the same channel
    // the hooks ride. Reading only config.toml renders `approval_policy` as "not delivered to this
    // agent" while the session is demonstrably running under it.
    const found = read({
      argv: [
        "codex", "--dangerously-bypass-hook-trust", "-c", BRIDGE_ARG,
        "-c", 'approval_policy="never"',
        "-c", 'sandbox_mode="danger-full-access"',
        "-c", 'mcp_servers.tachyon_bridge.default_tools_approval_mode="approve"',
      ],
    });
    const byKey = new Map(found.settings.map((setting) => [setting.key, setting.value]));

    expect(byKey.get("approval_policy")).toBe("never");
    expect(byKey.get("sandbox_mode")).toBe("danger-full-access");
    expect(byKey.get("mcp_servers.tachyon_bridge.default_tools_approval_mode")).toBe("approve");
    // Delivered by Tachyon on the argv is not "the person authored it in their own config".
    expect(found.settings.find((setting) => setting.key === "approval_policy")?.hostAuthored).toBe(false);
  });

  it("skips an unparseable override instead of guessing at it", () => {
    const found = read({ argv: ["codex", "-c", "hooks.SessionStart=[[[ broken", "-c", STOP_ARG] });

    expect(found.hooks.map((hook) => hook.event)).toEqual(["Stop"]);
  });

  it("survives a session with no config file at all", () => {
    // A plain `cmd: codex` agent with no nativeConfig block gets a private home and NO config.toml —
    // measured on this workspace before a profile was authored. It must read as empty, not throw.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-bare-"));
    dirs.push(empty);

    const found = codexSessionReader.read({
      workspaceRoot: "/ws", agent: "codex", env: { CODEX_HOME: empty, HOME: empty }, argv: ["codex"],
    });

    expect(found.settings).toEqual([]);
    expect(found.globalKeys).toEqual([]);
  });
});

/**
 * t-0c963d — the reader carries a copy of the projector's family allowlist, and a copy drifts.
 * `FAMILY_KEYS` in codexNativeConfigProjection.ts is the authority; this fails when they disagree.
 */
describe("t-0c963d — the Codex projectable-key list matches the projector", () => {
  it("lists exactly what codexNativeConfigProjection projects", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "packages/engine/src/config/codexNativeConfigProjection.ts"), "utf8");
    const block = /const FAMILY_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
    expect(block).toBeTruthy();
    const projected = new Set([...block![1].matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]));

    const reader = fs.readFileSync(path.join(process.cwd(), "packages/engine/src/runtimeOps/codexSessionReader.ts"), "utf8");
    const listed = /projectableKeys:\s*\[([\s\S]*?)\]/.exec(reader);
    expect(listed).toBeTruthy();
    const mirrored = new Set([...listed![1].matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]));

    expect([...mirrored].sort()).toEqual([...projected].sort());
  });
});
