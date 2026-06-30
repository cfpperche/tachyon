import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HarnessManager,
  HarnessUnavailableError,
  harnessCodexConfigPath,
  harnessHome,
  harnessMcpPath,
  bridgeMcpPath,
  mergeServers,
  buildMcpConfig,
  harnessWiring,
  collectEnvRefs,
  parseEnvFile,
  readWorkspaceMcpServers,
  realConfigHome,
  defaultRealCodexHome,
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
    expect(fs.realpathSync(path.join(res.home, "auth.json"))).toBe(fs.realpathSync(path.join(codexHome, "auth.json")));
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

  it("spec 303: materializeCodexSessionStartHookConfig returns a codex hook override and writes shared scripts", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const config = mgr.materializeCodexSessionStartHookConfig(path.join(ws, ".tachyon", "HANDOFF.md"));
    expect(config).toContain("hooks.SessionStart=");
    expect(config).toContain("session-owner-record.cjs");
    expect(config).toContain("handoff-pointer.cjs");
    expect(config).toContain("$TACHYON_AGENT_NAME");
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "session-owner-record.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "handoff-pointer.cjs"))).toBe(true);
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

  it("readWorkspaceMcpServers returns null on missing/malformed", () => {
    expect(readWorkspaceMcpServers(ws)).toBeNull();
    fs.writeFileSync(path.join(ws, ".mcp.json"), "not json");
    expect(readWorkspaceMcpServers(ws)).toBeNull();
  });
});
