import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  HarnessManager,
  HarnessUnavailableError,
  harnessCodexConfigPath,
  harnessHome,
  harnessMcpPath,
  bridgeMcpPath,
  bridgeOpencodeMcpPath,
  bridgeGrokHome,
  bridgeHermesHome,
  mergeServers,
  buildMcpConfig,
  harnessWiring,
  collectEnvRefs,
  parseEnvFile,
  readWorkspaceMcpServers,
  realConfigHome,
  defaultRealCodexHome,
  defaultRealGrokHome,
  defaultRealHermesHome,
  isTachyonManagedGrokHome,
  isTachyonManagedHermesHome,
  setHermesMcpServer,
  opencodeHarnessDirs,
} from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import type { HarnessDef } from "../../src/config/loadConfig.js";

const claude = adapterForRuntime("claude")!;
const codex = adapterForRuntime("codex")!;
const DEF = (inherit: "none" | "workspace"): HarnessDef => ({
  inherit,
  mcp: { "fal-ai": { command: "npx", args: ["-y", "@fal-ai/mcp"], env: { FAL_KEY: "${FAL_KEY}" } } },
});

describe("harness pure helpers", () => {
  it("mergeServers: inherit none → only declared", () => {
    expect(mergeServers(DEF("none"), { ws: { command: "x" } })).toEqual({ "fal-ai": DEF("none").mcp!["fal-ai"] });
  });

  it("mergeServers: inherit workspace → workspace base + declared overlay (declared wins)", () => {
    const merged = mergeServers(DEF("workspace"), { ws: { command: "x" }, "fal-ai": { command: "OLD" } });
    expect(Object.keys(merged).sort()).toEqual(["fal-ai", "ws"]);
    expect((merged["fal-ai"] as any).command).toBe("npx"); // declared overlays the workspace one
  });

  it("mergeServers: inherit workspace with no workspace file → only declared", () => {
    expect(mergeServers(DEF("workspace"), null)).toEqual({ "fal-ai": DEF("workspace").mcp!["fal-ai"] });
  });

  it("mergeServers: spec 236 — the Bridge is folded in (and always present) even on inherit:none", () => {
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp" };
    const merged = mergeServers(DEF("none"), { ws: { command: "x" } }, bridge);
    expect(Object.keys(merged).sort()).toEqual(["fal-ai", "tachyon_bridge"]);
    expect(merged.tachyon_bridge).toEqual(bridge);
  });

  it("mergeServers: spec 236 — no bridgeEntry (Bridge down) → unchanged (self-heals on restart)", () => {
    expect(mergeServers(DEF("none"), null)).toEqual({ "fal-ai": DEF("none").mcp!["fal-ai"] });
  });

  it("buildMcpConfig wraps in mcpServers", () => {
    expect(buildMcpConfig({ a: { command: "x" } })).toEqual({ mcpServers: { a: { command: "x" } } });
  });

  it("harnessWiring uses the adapter's claude shape", () => {
    const { env, args } = harnessWiring(claude, "/h/home", "/h/home/mcp.json");
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/h/home" });
    expect(args).toEqual(["--mcp-config", "/h/home/mcp.json", "--strict-mcp-config"]);
  });

  it("harnessWiring uses the adapter's codex home-config shape", () => {
    const { env, args } = harnessWiring(codex, "/h/home", "/h/home/config.toml");
    expect(env).toEqual({ CODEX_HOME: "/h/home" });
    expect(args).toEqual([]);
  });

  it("path builders", () => {
    expect(harnessHome("/ws", "a")).toBe("/ws/.tachyon/harness/a");
    expect(harnessMcpPath("/ws", "a")).toBe("/ws/.tachyon/harness/a/mcp.json");
    expect(bridgeMcpPath("/ws", "a")).toBe("/ws/.tachyon/bridge-mcp/a.json"); // spec 236
    expect(bridgeOpencodeMcpPath("/ws", "a")).toBe("/ws/.tachyon/bridge-mcp/a.opencode.json"); // spec 236 — distinct filename
    expect(bridgeGrokHome("/ws", "a")).toBe("/ws/.tachyon/bridge-mcp/a.grok"); // t-843576 — private GROK_HOME
  });

  it("realConfigHome honors CLAUDE_CONFIG_DIR override, else ~/.claude", () => {
    expect(realConfigHome({ CLAUDE_CONFIG_DIR: "/custom" }, "/home/u")).toBe("/custom");
    expect(realConfigHome({}, "/home/u")).toBe("/home/u/.claude");
  });

  it("defaultRealCodexHome honors CODEX_HOME override, else ~/.codex", () => {
    expect(defaultRealCodexHome({ CODEX_HOME: "/custom" }, "/home/u")).toBe("/custom");
    expect(defaultRealCodexHome({}, "/home/u")).toBe("/home/u/.codex");
  });

  it("parseEnvFile handles plain/quoted/export/comments/blank/malformed (spec 227)", () => {
    const env = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=abc",
        'QUOTED="with spaces"',
        "SQUOTED='single'",
        "export EXPORTED=xyz",
        "  SPACED = trimmed ",
        "no_equals_line",
        "=novalue",
        "1BAD=skipped",
      ].join("\n"),
    );
    expect(env).toEqual({ PLAIN: "abc", QUOTED: "with spaces", SQUOTED: "single", EXPORTED: "xyz", SPACED: "trimmed" });
  });

  it("collectEnvRefs gathers the ${VAR} names across mcp server env blocks", () => {
    const def: HarnessDef = {
      inherit: "none",
      mcp: {
        a: { command: "x", env: { FOO: "${FOO}", BAR: "${BAR}" } },
        b: { command: "y", env: { FOO: "${FOO}" } },
        c: { command: "z" },
      },
    };
    expect(collectEnvRefs(def).sort()).toEqual(["BAR", "FOO"]);
  });
});

describe("HarnessManager materialize (fs)", () => {
  let ws: string;
  let realHome: string;
  const PROC = { FAL_KEY: "real-key" }; // the secret ${FAL_KEY} resolves from here (H7)

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-harness-"));
    ws = path.join(base, "ws");
    realHome = path.join(base, "realhome");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, ".credentials.json"), '{"token":"REAL"}');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(ws), { recursive: true, force: true });
  });

  it("writes mcp.json (${VAR} literal), symlinks auth, returns claude wiring", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const res = mgr.materialize("researcher", DEF("none"), claude);

    expect(res.home).toBe(harnessHome(ws, "researcher"));
    expect(res.env.CLAUDE_CONFIG_DIR).toBe(res.home);
    expect(res.args).toEqual(["--mcp-config", harnessMcpPath(ws, "researcher"), "--strict-mcp-config"]);

    // auth is a SYMLINK to the real home's credential file (H1), not a copy
    const link = path.join(res.home, ".credentials.json");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(realHome, ".credentials.json")));

    // mcp.json carries the ${VAR} reference literally — no secret resolved on disk (H7)
    const written = JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8"));
    expect(written.mcpServers["fal-ai"].env.FAL_KEY).toBe("${FAL_KEY}");
    // ...but the REAL value is injected into the spawned process env so claude can expand it (H7)
    expect(res.env.FAL_KEY).toBe("real-key");
  });

  it("spec 236: folds the Bridge into the materialized --strict mcp file (inherit:none keeps it)", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } };
    mgr.materialize("researcher", DEF("none"), claude, undefined, bridge);
    const written = JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8"));
    expect(written.mcpServers.tachyon_bridge).toEqual(bridge);
    expect(written.mcpServers["fal-ai"]).toBeDefined(); // declared server still there
    // the token stays a ${VAR} ref — never a literal on disk
    expect(JSON.stringify(written)).not.toMatch(/Bearer [0-9a-f]{8}/);
  });

  it("spec 298: codex harness writes private config.toml, symlinks auth, and returns CODEX_HOME only", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"token":"CODEX"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } };
    const res = mgr.materialize("coder", DEF("none"), codex, undefined, bridge);

    expect(res.home).toBe(harnessHome(ws, "coder"));
    expect(res.env.CODEX_HOME).toBe(res.home);
    expect(res.env.FAL_KEY).toBe("real-key");
    expect(res.args).toEqual([]);
    const auth = path.join(res.home, "auth.json");
    expect(fs.lstatSync(auth).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(auth)).toBe(fs.realpathSync(path.join(codexHome, "auth.json")));

    const toml = fs.readFileSync(harnessCodexConfigPath(ws, "coder"), "utf8");
    expect(toml).toContain("[mcp_servers.fal-ai]");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('env_vars = ["FAL_KEY"]');
    expect(toml).toContain("[mcp_servers.tachyon_bridge]");
    expect(toml).toContain('bearer_token_env_var = "TACHYON_BRIDGE_TOKEN"');
    expect(toml).not.toContain("real-key");
  });

  it("spec 298: codex inherit:workspace preserves workspace config.toml and overlays declared servers", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".codex", "config.toml"), '[mcp_servers.ws]\ncommand = "node"\n\n');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    mgr.materialize("coder", DEF("workspace"), codex);
    const toml = fs.readFileSync(harnessCodexConfigPath(ws, "coder"), "utf8");
    expect(toml).toContain("[mcp_servers.ws]");
    expect(toml).toContain("[mcp_servers.fal-ai]");
  });

  it("spec 311: codex harness materializes instructions, skills, and native hooks", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.mkdirSync(path.join(ws, "agents"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "researcher.md"), "# Researcher\nUse TachyonCodexInstructionsProof.\n");
    fs.mkdirSync(path.join(ws, "skills", "research"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Use when researching.\n---\nSkill body.\n");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const def: HarnessDef = {
      inherit: "none",
      instructions: ["agents/researcher.md"],
      skills: ["skills/research"],
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "./guard.sh", statusMessage: "Guarding" }] }],
      },
    };

    const res = mgr.materialize("coder", def, codex);

    expect(fs.readFileSync(path.join(res.home, "AGENTS.md"), "utf8")).toContain("TachyonCodexInstructionsProof");
    expect(fs.existsSync(path.join(res.home, "skills", "research", "SKILL.md"))).toBe(true);
    const toml = fs.readFileSync(harnessCodexConfigPath(ws, "coder"), "utf8");
    expect(toml).toContain("hooks.SessionStart = [");
    expect(toml).toContain('command = "./guard.sh"');
    expect(toml).not.toContain("CLAUDE.md");
  });

  it("spec 311 dogfood: local codex prompt-input sees harness AGENTS.md and CODEX_HOME skills", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.mkdirSync(path.join(ws, "agents"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "researcher.md"), "# Researcher\nUse TachyonCodexDogfoodProof.\n");
    fs.mkdirSync(path.join(ws, "skills", "research"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Use when proving Tachyon Codex harness dogfood.\n---\nSkill body.\n");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const res = mgr.materialize("coder", { inherit: "none", instructions: ["agents/researcher.md"], skills: ["skills/research"] }, codex);

    const out = execFileSync("codex", ["debug", "prompt-input", "hello"], {
      cwd: ws,
      env: { ...process.env, CODEX_HOME: res.home },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toContain("TachyonCodexDogfoodProof");
    expect(out).toContain("research: Use when proving Tachyon Codex harness dogfood.");
  });

  it("spec 298: codex isolate: transcript seeds auth and copies base config without MCP harness args", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5-codex"\n');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const res = mgr.materializeHomeOnly("coder", codex);
    expect(res.env).toEqual({ CODEX_HOME: res.home });
    expect(res.args).toEqual([]);
    expect(fs.readFileSync(path.join(res.home, "config.toml"), "utf8")).toContain('model = "gpt-5-codex"');
    expect(fs.lstatSync(path.join(res.home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(res.home, "auth.json"))).toBe(fs.realpathSync(path.join(codexHome, "auth.json")));
  });

  it("t-e2ebe3 review fix: opencode materializeHomeOnly returns all three XDG vars pointing at the config/data/state subdirs (not just XDG_CONFIG_HOME at the home root)", () => {
    const opencode = adapterForRuntime("opencode")!;
    const opencodeDataHome = path.join(path.dirname(realHome), "realopencodedata");
    fs.mkdirSync(path.join(opencodeDataHome, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(opencodeDataHome, "opencode", "auth.json"), '{"token":"OC"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, opencodeDataHome);

    const res = mgr.materializeHomeOnly("reviewer", opencode);

    const dirs = opencodeHarnessDirs(res.home);
    expect(res.env).toEqual({ XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state });
    expect(res.args).toEqual([]);

    // auth is a COPY (mode 600), not a symlink — opencode refreshes its token in place (a shared
    // symlink would race the real home across concurrent agents)
    const authCopy = path.join(dirs.data, "opencode", "auth.json");
    expect(fs.lstatSync(authCopy).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(authCopy, "utf8"))).toEqual({ token: "OC" });
    expect(fs.statSync(authCopy).mode & 0o777).toBe(0o600);
  });

  it("spec 236: materializeBridgeMcp writes a Bridge-only --mcp-config file for a non-harness claude agent", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } };
    const file = mgr.materializeBridgeMcp("solo", bridge);
    expect(file).toBe(bridgeMcpPath(ws, "solo"));
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written).toEqual({ mcpServers: { tachyon_bridge: bridge } });
    // GC removes it
    mgr.removeBridgeMcp("solo");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("spec 236: materializeBridgeMcpOpencode writes a Bridge-only opencode config (additive over project opencode.json)", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const bridge = { type: "remote", url: "http://127.0.0.1:9/mcp", enabled: true, headers: { Authorization: "Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}" } };
    // No existing project opencode.json => fresh file with $schema + mcp.tachyon_bridge only.
    const file = mgr.materializeBridgeMcpOpencode("oc", bridge);
    expect(file).toBe(bridgeOpencodeMcpPath(ws, "oc"));
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { $schema: string; mcp: Record<string, unknown> };
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp.tachyon_bridge).toEqual(bridge);

    // With an existing project opencode.json (other mcp servers), the Bridge is folded in alongside.
    const projectOpencode = JSON.stringify({ mcp: { userTool: { type: "local", command: ["cmd"] } } });
    const file2 = mgr.materializeBridgeMcpOpencode("oc2", bridge, projectOpencode);
    const written2 = JSON.parse(fs.readFileSync(file2, "utf8")) as { mcp: Record<string, unknown> };
    expect(Object.keys(written2.mcp).sort()).toEqual(["tachyon_bridge", "userTool"]);
  });

  it("spec 236 review fix: a malformed project opencode.json degrades to a Bridge-only config + warns, instead of throwing", () => {
    const warnings: string[] = [];
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, (m) => warnings.push(m));
    const bridge = { type: "remote", url: "http://127.0.0.1:9/mcp", enabled: true, headers: { Authorization: "Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}" } };

    // Syntactically invalid JSON (trailing comma) — must not throw; falls back to Bridge-only.
    const file = mgr.materializeBridgeMcpOpencode("oc", bridge, '{"mcp": {},}');
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { $schema: string; mcp: Record<string, unknown> };
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(Object.keys(written.mcp)).toEqual(["tachyon_bridge"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("oc");
    expect(warnings[0]).toContain("malformed");

    // Valid JSON but the wrong shape (an array) — same degrade-and-warn behavior.
    warnings.length = 0;
    const file2 = mgr.materializeBridgeMcpOpencode("oc2", bridge, "[]");
    const written2 = JSON.parse(fs.readFileSync(file2, "utf8")) as { mcp: Record<string, unknown> };
    expect(Object.keys(written2.mcp)).toEqual(["tachyon_bridge"]);
    expect(warnings).toHaveLength(1);

    // No project file at all — the (rare) mkdir/write failure path should still surface, not be swallowed;
    // proven indirectly: no warning fires when there's nothing to fall back FROM.
    warnings.length = 0;
    mgr.materializeBridgeMcpOpencode("oc3", bridge, undefined);
    expect(warnings).toHaveLength(0);
  });

  it("t-843576: materializeBridgeMcpGrok writes private GROK_HOME with tachyon_bridge + auth symlink", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok");
    fs.mkdirSync(realGrokHome, { recursive: true });
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"GROK"}');
    // HarnessManager ctor: (ws, realHome, procEnv, realClaudeJson, realCodexHome, warn, realOpencodeDataHome, realGrokHome)
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };
    const home = mgr.materializeBridgeMcpGrok("solo", bridge);
    expect(home).toBe(bridgeGrokHome(ws, "solo"));
    expect(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(home, "auth.json"))).toBe(path.join(realGrokHome, "auth.json"));
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.tachyon_bridge]");
    expect(toml).toContain('url = "http://127.0.0.1:9/mcp"');
    expect(toml).toContain('Authorization');
    expect(toml).toContain("Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}");
    expect(toml).not.toMatch(/Bearer\s+[a-f0-9]{16,}/i); // no literal secret on disk
    // Does not touch a workspace/user ~/.grok/config.toml
    expect(fs.existsSync(path.join(ws, ".grok", "config.toml"))).toBe(false);
    // GC removes the private home
    mgr.removeBridgeMcp("solo");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("t-2b0a08: materializeBridgeMcpGrok promotes a newer private regular auth refresh before relinking", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-refresh");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    fs.writeFileSync(realAuth, '{"token":"OLD"}');
    fs.chmodSync(realAuth, 0o600);
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };

    const home = mgr.materializeBridgeMcpGrok("solo", bridge);
    const privateAuth = path.join(home, "auth.json");
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(true);

    fs.unlinkSync(privateAuth);
    fs.writeFileSync(privateAuth, '{"token":"FRESH"}');
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const newTime = new Date("2026-01-01T00:00:10.000Z");
    fs.utimesSync(realAuth, oldTime, oldTime);
    fs.utimesSync(privateAuth, newTime, newTime);

    mgr.materializeBridgeMcpGrok("solo", bridge);

    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"FRESH"}');
    expect(fs.statSync(realAuth).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(privateAuth)).toBe(realAuth);
  });

  it("t-2b0a08: materializeBridgeMcpGrok leaves the normal auth symlink path intact on rematerialize", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-symlink");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    fs.writeFileSync(realAuth, '{"token":"GROK"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };

    const home = mgr.materializeBridgeMcpGrok("solo", bridge);
    mgr.materializeBridgeMcpGrok("solo", bridge);

    const privateAuth = path.join(home, "auth.json");
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(privateAuth)).toBe(realAuth);
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"GROK"}');
  });

  it("reconcileWorkspaceGrokAuth promotes the freshest multi-agent OIDC key and re-symlinks every private home", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-multi");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    fs.writeFileSync(
      realAuth,
      JSON.stringify({
        "https://auth.x.ai::old": {
          key: "OLD_KEY",
          auth_mode: "oidc",
          create_time: "2026-07-13T12:00:00.000Z",
        },
      }),
    );
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };

    const homeA = mgr.materializeBridgeMcpGrok("alpha", bridge);
    const homeB = mgr.materializeBridgeMcpGrok("beta", bridge);
    // Simulate Grok token refresh: replace each symlink with a distinct regular file (newer OIDC create_time wins).
    const authA = path.join(homeA, "auth.json");
    const authB = path.join(homeB, "auth.json");
    fs.unlinkSync(authA);
    fs.unlinkSync(authB);
    fs.writeFileSync(
      authA,
      JSON.stringify({
        "https://auth.x.ai::scope": {
          key: "KEY_A",
          auth_mode: "oidc",
          create_time: "2026-07-14T10:00:00.000Z",
        },
      }),
    );
    fs.writeFileSync(
      authB,
      JSON.stringify({
        "https://auth.x.ai::scope": {
          key: "KEY_B_NEWEST",
          auth_mode: "oidc",
          create_time: "2026-07-14T11:00:00.000Z",
        },
      }),
    );
    // mtime trap: make A look "newer" on disk while B has the fresher OIDC create_time.
    const older = new Date("2026-07-14T10:00:00.000Z");
    const newerMtime = new Date("2026-07-14T12:00:00.000Z");
    fs.utimesSync(authB, older, older);
    fs.utimesSync(authA, newerMtime, newerMtime);

    const result = mgr.reconcileGrokAuthFromWorkspace();
    expect(result.promoted).toBe(true);
    expect(result.relinked).toBeGreaterThanOrEqual(2);

    const real = JSON.parse(fs.readFileSync(realAuth, "utf8")) as { "https://auth.x.ai::scope": { key: string } };
    expect(real["https://auth.x.ai::scope"].key).toBe("KEY_B_NEWEST");
    expect(fs.lstatSync(authA).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(authB).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(authA)).toBe(realAuth);
    expect(fs.readlinkSync(authB)).toBe(realAuth);
    // Both agents now read the same promoted credential.
    expect(fs.readFileSync(authA, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));
    expect(fs.readFileSync(authB, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));
  });

  it("t-303f2b: defaultRealGrokHome ignores Tachyon-managed private GROK_HOME overrides", () => {
    expect(isTachyonManagedGrokHome("/ws/.tachyon/bridge-mcp/agent.grok")).toBe(true);
    expect(isTachyonManagedGrokHome("/ws/.tachyon/harness/agent/.grok")).toBe(true);
    expect(isTachyonManagedGrokHome("/home/me/.grok")).toBe(false);
    expect(defaultRealGrokHome({ GROK_HOME: "/ws/.tachyon/bridge-mcp/agent.grok" }, "/home/me")).toBe(path.join("/home/me", ".grok"));
    expect(defaultRealGrokHome({ GROK_HOME: "/custom/grok-home" }, "/home/me")).toBe("/custom/grok-home");
    expect(defaultRealGrokHome({}, "/home/me")).toBe(path.join("/home/me", ".grok"));
  });

  it("t-303f2b: materializeBridgeMcpGrok fails closed when auth.json is unreadable after symlink", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-bad-auth");
    fs.mkdirSync(realGrokHome, { recursive: true });
    // exists but not a JSON object → assertReadableGrokAuth must throw
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), "not-json");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    expect(() =>
      mgr.materializeBridgeMcpGrok("solo", { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" } }),
    ).toThrow(/credentials unreadable|not a JSON object|Unexpected token|not-json|JSON/i);
  });

  it("t-843576: materializeBridgeMcpGrok fails closed when no real and no private grok auth exist", () => {
    const emptyGrok = path.join(path.dirname(ws), "empty-grok");
    fs.mkdirSync(emptyGrok, { recursive: true });
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, emptyGrok);
    expect(() =>
      mgr.materializeBridgeMcpGrok("solo", { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" } }),
    ).toThrow(HarnessUnavailableError);
  });

  it("materializeBridgeMcpGrok recovers when real auth is missing but a private regular auth exists", () => {
    // Dogfood: Grok login under redirected GROK_HOME left tokens only in the private home; real
    // ~/.grok/auth.json was never updated. Stop/resume must promote private → real, not fail closed.
    const emptyGrok = path.join(path.dirname(ws), "empty-grok-recover");
    fs.mkdirSync(emptyGrok, { recursive: true });
    const realAuth = path.join(emptyGrok, "auth.json");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, emptyGrok);
    const privateAuth = path.join(bridgeGrokHome(ws, "solo"), "auth.json");
    fs.mkdirSync(path.dirname(privateAuth), { recursive: true });
    fs.writeFileSync(privateAuth, '{"token":"PRIVATE_ONLY"}');

    const home = mgr.materializeBridgeMcpGrok("solo", {
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    });
    expect(home).toBe(bridgeGrokHome(ws, "solo"));
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"PRIVATE_ONLY"}');
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(privateAuth)).toBe(realAuth);
  });

  it("setHermesMcpServer merges tachyon_bridge into config.yaml without secrets", () => {
    const out = setHermesMcpServer("model:\n  provider: openai-codex\n", "tachyon_bridge", {
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
      enabled: true,
    });
    expect(out).toContain("tachyon_bridge");
    expect(out).toContain("http://127.0.0.1:9/mcp");
    expect(out).toContain("Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}");
    expect(out).toContain("openai-codex");
    expect(out).not.toMatch(/Bearer\s+[a-f0-9]{16,}/i);
  });

  it("materializeBridgeMcpHermes writes private HERMES_HOME with Bridge yaml + auth symlink", () => {
    const realHermesHome = path.join(path.dirname(ws), "real-hermes");
    fs.mkdirSync(realHermesHome, { recursive: true });
    fs.writeFileSync(path.join(realHermesHome, "auth.json"), '{"tokens":{"access_token":"x"}}');
    fs.writeFileSync(path.join(realHermesHome, "config.yaml"), "model:\n  default: gpt-5.6-sol\n  provider: openai-codex\n");
    // ctor: (ws, realHome, procEnv, realClaudeJson, realCodexHome, warn, realOpencodeDataHome, realGrokHome, realHermesHome)
    const mgr = new HarnessManager(
      ws,
      realHome,
      PROC,
      path.join(realHome, ".claude.json"),
      undefined,
      undefined,
      undefined,
      undefined,
      realHermesHome,
    );
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };
    const home = mgr.materializeBridgeMcpHermes("solo", bridge);
    expect(home).toBe(bridgeHermesHome(ws, "solo"));
    expect(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(home, "auth.json"))).toBe(path.join(realHermesHome, "auth.json"));
    const yaml = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    expect(yaml).toContain("tachyon_bridge");
    expect(yaml).toContain("http://127.0.0.1:9/mcp");
    expect(yaml).toContain("Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}");
    expect(yaml).toContain("gpt-5.6-sol");
    expect(yaml).not.toMatch(/Bearer\s+[a-f0-9]{16,}/i);
    expect(isTachyonManagedHermesHome(home)).toBe(true);
    expect(defaultRealHermesHome({ HERMES_HOME: home }, "/home/me")).toBe(path.join("/home/me", ".hermes"));
    mgr.removeBridgeMcp("solo");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("materializeBridgeMcpHermes fails closed when real hermes auth is missing", () => {
    const emptyHermes = path.join(path.dirname(ws), "empty-hermes");
    fs.mkdirSync(emptyHermes, { recursive: true });
    const mgr = new HarnessManager(
      ws,
      realHome,
      PROC,
      path.join(realHome, ".claude.json"),
      undefined,
      undefined,
      undefined,
      undefined,
      emptyHermes,
    );
    expect(() =>
      mgr.materializeBridgeMcpHermes("solo", {
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
      }),
    ).toThrow(HarnessUnavailableError);
  });

  it("spec 243: materializeOwnershipSettings writes the recorder + per-spawn --settings hook (atomic, no temp left)", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const file = mgr.materializeOwnershipSettings("claude-x");
    // settings file carries a SessionStart command hook invoking the recorder for this exact agent
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(settings.hooks.SessionStart[0].hooks[0].type).toBe("command");
    expect(cmd).toContain("session-owner-record.cjs");
    expect(cmd).toContain("'claude-x'");
    expect(cmd).toContain("session-owners.jsonl");
    // the recorder script materialized on disk + is valid JS
    const recorder = path.join(ws, ".tachyon", "activity", "session-owner-record.cjs");
    expect(fs.existsSync(recorder)).toBe(true);
    expect(() => new Function(fs.readFileSync(recorder, "utf8"))).not.toThrow();
    // atomic write leaves no staging temp behind
    expect(fs.readdirSync(path.join(ws, ".tachyon", "activity")).some((f) => f.includes(".tmp-"))).toBe(false);
    // idempotent: a second call (e.g. restart) rewrites cleanly
    expect(() => mgr.materializeOwnershipSettings("claude-x")).not.toThrow();
  });

  it("t-4e286c: materializeOwnershipSettings can seed Claude bypass-permissions startup consent for ad-hoc spawns", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const normal = JSON.parse(fs.readFileSync(mgr.materializeOwnershipSettings("declared"), "utf8"));
    expect(normal.skipDangerousModePermissionPrompt).toBeUndefined();

    const adHoc = JSON.parse(fs.readFileSync(mgr.materializeOwnershipSettings("adhoc", undefined, { skipDangerousModePermissionPrompt: true }), "utf8"));
    expect(adHoc.skipDangerousModePermissionPrompt).toBe(true);
    expect(adHoc.hooks.SessionStart[0].hooks[0].command).toContain("session-owner-record.cjs");
  });

  it("spec 245: materializeOwnershipSettings with a handoff path also injects the SessionStart pointer", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const file = mgr.materializeOwnershipSettings("claude-x", path.join(ws, ".tachyon", "HANDOFF.md"));
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    const cmds = settings.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(cmds.length).toBe(2); // ownership recorder + handoff pointer
    expect(cmds[0]).toContain("session-owner-record.cjs");
    expect(cmds[1]).toContain("handoff-pointer.cjs");
    expect(cmds[1]).toContain("HANDOFF.md");
    // the pointer script is materialized + valid JS
    const pointer = path.join(ws, ".tachyon", "activity", "handoff-pointer.cjs");
    expect(fs.existsSync(pointer)).toBe(true);
    expect(() => new Function(fs.readFileSync(pointer, "utf8"))).not.toThrow();
    // without a handoff path → no pointer command (back-compat)
    const noPtr = JSON.parse(fs.readFileSync(mgr.materializeOwnershipSettings("claude-y"), "utf8"));
    expect(noPtr.hooks.SessionStart[0].hooks.length).toBe(1);
  });

  it("spec 312: materializeOwnershipSettings can add continuity and Stop persistence hooks", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const file = mgr.materializeOwnershipSettings("claude-x", path.join(ws, ".tachyon", "HANDOFF.md"), { silentPersistence: true });
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    const startCmds = settings.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(startCmds.some((cmd: string) => cmd.includes("session-owner-record.cjs"))).toBe(true);
    expect(startCmds.some((cmd: string) => cmd.includes("handoff-pointer.cjs"))).toBe(true);
    expect(startCmds.some((cmd: string) => cmd.includes("continuity-pointer.cjs") && cmd.includes("continuity/claude-x.md"))).toBe(true);
    expect(startCmds.every((cmd: string) => cmd.includes("persistence-hooks-failures.jsonl"))).toBe(true);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("persistence-stop-record.cjs");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("persistence-hooks-failures.jsonl");
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "continuity-pointer.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "persistence-stop-record.cjs"))).toBe(true);
  });

  it("spec 303: materializeCodexSessionStartHookConfig returns a codex hook override and writes shared scripts", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const config = mgr.materializeCodexSessionStartHookConfig("codex-x", path.join(ws, ".tachyon", "HANDOFF.md"));
    expect(config).toContain("hooks.SessionStart=");
    expect(config).toContain("session-owner-record.cjs");
    expect(config).toContain("handoff-pointer.cjs");
    expect(config).toContain("$TACHYON_AGENT_NAME");
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "session-owner-record.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "handoff-pointer.cjs"))).toBe(true);
  });

  it("spec 312: materializeCodexSessionStartHookConfig can add continuity and Stop persistence hooks", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const config = mgr.materializeCodexSessionStartHookConfig("codex-x", path.join(ws, ".tachyon", "HANDOFF.md"), { silentPersistence: true });
    expect(config).toEqual(expect.any(Array));
    const [start, stop] = config as string[];
    expect(start).toContain("hooks.SessionStart=");
    expect(start).toContain("continuity-pointer.cjs");
    expect(start).toContain("continuity/codex-x.md");
    expect(stop).toContain("hooks.Stop=");
    expect(stop).toContain("persistence-stop-record.cjs");
    expect(start).toContain("persistence-hooks-failures.jsonl");
    expect(stop).toContain("persistence-hooks-failures.jsonl");
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "continuity-pointer.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "persistence-stop-record.cjs"))).toBe(true);
  });

  it("fails closed when a referenced ${VAR} is not in the env (H7 — no unauthenticated MCP)", () => {
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json")); // FAL_KEY absent
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(HarnessUnavailableError);
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(/FAL_KEY/);
    expect(fs.existsSync(harnessHome(ws, "researcher"))).toBe(false); // threw BEFORE any fs side effect
  });

  it("fails closed when the real claude credential is absent (H1 — no dangling symlink)", () => {
    fs.rmSync(path.join(realHome, ".credentials.json"));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(/credentials|login/i);
  });

  it("spec 227: resolves a ${VAR} from the project .env when it's NOT in process.env", () => {
    fs.writeFileSync(path.join(ws, ".env"), "# secrets\nFAL_KEY=from-dotenv\n");
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json")); // procEnv empty → must fall back to .env
    const res = mgr.materialize("researcher", DEF("none"), claude);
    expect(res.env.FAL_KEY).toBe("from-dotenv");
  });

  it("spec 227: process.env wins over .env on conflict (dotenv precedence)", () => {
    fs.writeFileSync(path.join(ws, ".env"), "FAL_KEY=from-dotenv\n");
    const mgr = new HarnessManager(ws, realHome, { FAL_KEY: "from-procenv" }, path.join(realHome, ".claude.json"));
    expect(mgr.materialize("researcher", DEF("none"), claude).env.FAL_KEY).toBe("from-procenv");
  });

  it("spec 227: missing in BOTH process.env and .env → fail closed naming .env", () => {
    fs.writeFileSync(path.join(ws, ".env"), "OTHER=x\n"); // .env exists but lacks FAL_KEY
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"));
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(/\.env/);
  });

  // spec 228 — skills / rules / hooks materialization
  it("spec 228: rules → <home>/CLAUDE.md (concatenated, headered)", () => {
    fs.writeFileSync(path.join(ws, "r1.md"), "rule one");
    fs.writeFileSync(path.join(ws, "r2.md"), "rule two");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("researcher", { inherit: "none", rules: ["r1.md", "r2.md"] }, claude);
    const md = fs.readFileSync(path.join(harnessHome(ws, "researcher"), "CLAUDE.md"), "utf8");
    expect(md).toContain("# === r1.md ===");
    expect(md).toContain("rule one");
    expect(md).toContain("rule two");
  });

  it("spec 228: skills → copied into <home>/skills/<basename>/", () => {
    fs.mkdirSync(path.join(ws, "skills", "research"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "research", "SKILL.md"), "---\nname: research\n---\nbody");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("researcher", { inherit: "none", skills: ["skills/research"] }, claude);
    expect(fs.existsSync(path.join(harnessHome(ws, "researcher"), "skills", "research", "SKILL.md"))).toBe(true);
  });

  it("spec 228: hooks → merged into <home>/settings.json under `hooks`", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const hooks = { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] };
    mgr.materialize("researcher", { inherit: "none", hooks }, claude);
    const settings = JSON.parse(fs.readFileSync(path.join(harnessHome(ws, "researcher"), "settings.json"), "utf8"));
    expect(settings.hooks).toEqual(hooks);
  });

  it("spec 228 (codex M2): a rules-only harness STILL scopes MCP (strict, empty servers for inherit:none)", () => {
    fs.writeFileSync(path.join(ws, "r.md"), "rule");
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json")); // no secret needed (no mcp)
    const res = mgr.materialize("researcher", { inherit: "none", rules: ["r.md"] }, claude);
    expect(res.args).toEqual(["--mcp-config", harnessMcpPath(ws, "researcher"), "--strict-mcp-config"]); // always scoped
    expect(JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8")).mcpServers).toEqual({}); // inherit:none → no project MCP
    expect(fs.existsSync(path.join(res.home, "CLAUDE.md"))).toBe(true);
  });

  it("spec 228 (codex M3): rematerialize CLEARS rules/skills/hooks the user removed", () => {
    fs.writeFileSync(path.join(ws, "r.md"), "rule");
    fs.mkdirSync(path.join(ws, "sk", "research"), { recursive: true });
    fs.writeFileSync(path.join(ws, "sk", "research", "SKILL.md"), "---\nname: research\n---\nx");
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"));
    const home = harnessHome(ws, "researcher");
    const hooks = { SessionStart: [{ hooks: [{ type: "command", command: "echo" }] }] };
    mgr.materialize("researcher", { inherit: "none", rules: ["r.md"], skills: ["sk/research"], hooks }, claude);
    expect(fs.existsSync(path.join(home, "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, "skills", "research"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).hooks).toBeTruthy();
    // rematerialize with NONE of them (mcp-only) → all three cleared
    mgr.materialize("researcher", { inherit: "none", mcp: { s: { command: "x" } } }, claude);
    expect(fs.existsSync(path.join(home, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, "skills", "research"))).toBe(false);
    const settingsAfter = fs.existsSync(path.join(home, "settings.json")) ? JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).hooks : undefined;
    expect(settingsAfter).toBeFalsy(); // hook removed → stops firing
  });

  it("dogfood fix: seeds onboarding + folder-trust into <home>/.claude.json (skips the login/trust wizard)", () => {
    fs.writeFileSync(path.join(realHome, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.12", userID: "u123", oauthAccount: { id: "acct" }, projects: { "/elsewhere": { x: 1 } } }));
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"));
    const cwd = "/home/goat/tachyon-examples";
    mgr.materialize("researcher", { inherit: "none", mcp: { s: { command: "x" } } }, claude, cwd);
    const cfg = JSON.parse(fs.readFileSync(path.join(harnessHome(ws, "researcher"), ".claude.json"), "utf8"));
    expect(cfg.hasCompletedOnboarding).toBe(true); // login/onboarding wizard skipped
    expect(cfg.userID).toBe("u123");
    expect(cfg.oauthAccount).toEqual({ id: "acct" });
    expect(cfg.projects[cwd].hasTrustDialogAccepted).toBe(true); // folder-trust prompt skipped for the agent's cwd
  });

  it("dogfood fix: no real .claude.json to seed from → materialize still succeeds (best-effort)", () => {
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, "nonexistent.json"));
    expect(() => mgr.materialize("researcher", { inherit: "none", mcp: { s: { command: "x" } } }, claude, "/ws")).not.toThrow();
  });

  it("spec 228 (codex M4): materialize rejects a rules path that escapes the workspace", () => {
    fs.writeFileSync(path.join(path.dirname(ws), "outside.md"), "secret");
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"));
    expect(() => mgr.materialize("researcher", { inherit: "none", rules: ["../outside.md"] }, claude)).toThrow(/escapes the workspace/);
  });

  it("spec 228 (codex M4): a skill dir without SKILL.md, and duplicate basenames, fail closed", () => {
    fs.mkdirSync(path.join(ws, "noskill"), { recursive: true });
    fs.mkdirSync(path.join(ws, "a", "research"), { recursive: true });
    fs.mkdirSync(path.join(ws, "b", "research"), { recursive: true });
    fs.writeFileSync(path.join(ws, "a", "research", "SKILL.md"), "x");
    fs.writeFileSync(path.join(ws, "b", "research", "SKILL.md"), "x");
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"));
    expect(() => mgr.materialize("researcher", { inherit: "none", skills: ["noskill"] }, claude)).toThrow(/SKILL\.md/);
    expect(() => mgr.materialize("researcher", { inherit: "none", skills: ["a/research", "b/research"] }, claude)).toThrow(/duplicate skill name/);
  });

  it("spec 228: a missing rules/skill path fails closed", () => {
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"));
    expect(() => mgr.materialize("researcher", { inherit: "none", rules: ["nope.md"] }, claude)).toThrow(/rules file not found/);
    expect(() => mgr.materialize("researcher", { inherit: "none", skills: ["nope"] }, claude)).toThrow(/SKILL\.md|not found/);
  });

  it("inherit: workspace folds the workspace .mcp.json snapshot in (H6)", () => {
    fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { "ws-server": { command: "wsx" } } }));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("researcher", DEF("workspace"), claude);
    const written = JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8"));
    expect(Object.keys(written.mcpServers).sort()).toEqual(["fal-ai", "ws-server"]);
  });

  it("inherit: none ignores the workspace .mcp.json (no project pickup, H5b)", () => {
    fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { "ws-server": { command: "wsx" } } }));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("researcher", DEF("none"), claude);
    const written = JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["fal-ai"]);
  });

  it("rematerialize replaces a stale auth symlink (H6)", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("researcher", DEF("none"), claude);
    // simulate a stale/broken link, then rematerialize
    const link = path.join(harnessHome(ws, "researcher"), ".credentials.json");
    fs.rmSync(link, { force: true });
    fs.symlinkSync("/nonexistent/stale", link);
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).not.toThrow();
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(realHome, ".credentials.json")));
  });

  it("remove() deletes the home; list() reports existing homes", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("a", DEF("none"), claude);
    mgr.materialize("b", DEF("none"), claude);
    expect(mgr.list().sort()).toEqual(["a", "b"]);
    mgr.remove("a");
    expect(mgr.list()).toEqual(["b"]);
    expect(fs.existsSync(harnessHome(ws, "a"))).toBe(false);
  });

  it("remove() retries transient ENOTEMPTY after renaming the home out of the live path", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    mgr.materialize("a", DEF("none"), claude);
    const home = harnessHome(ws, "a");
    const originalRmSync = fs.rmSync.bind(fs);
    let failedOnce = false;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, opts) => {
      if (typeof target === "string" && target.includes(".a.removing-") && opts && typeof opts === "object" && "recursive" in opts && !failedOnce) {
        failedOnce = true;
        const err = new Error("Directory not empty") as NodeJS.ErrnoException;
        err.code = "ENOTEMPTY";
        throw err;
      }
      return originalRmSync(target, opts as fs.RmOptions);
    });
    try {
      expect(() => mgr.remove("a")).not.toThrow();
    } finally {
      rmSpy.mockRestore();
    }
    expect(failedOnce).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.readdirSync(path.dirname(home)).filter((entry) => entry.includes(".a.removing-"))).toEqual([]);
  });

  it("readWorkspaceMcpServers returns null on missing/malformed", () => {
    expect(readWorkspaceMcpServers(ws)).toBeNull();
    fs.writeFileSync(path.join(ws, ".mcp.json"), "not json");
    expect(readWorkspaceMcpServers(ws)).toBeNull();
  });
});
