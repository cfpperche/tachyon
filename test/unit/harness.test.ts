import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HarnessManager,
  HarnessUnavailableError,
  harnessHome,
  harnessMcpPath,
  mergeServers,
  buildMcpConfig,
  harnessWiring,
  collectEnvRefs,
  readWorkspaceMcpServers,
  realConfigHome,
} from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import type { HarnessDef } from "../../src/config/loadConfig.js";

const claude = adapterForRuntime("claude")!;
const DEF = (inherit: "none" | "workspace"): HarnessDef => ({
  inherit,
  mcp: { "fal-ai": { command: "npx", args: ["-y", "@fal-ai/mcp"], env: { FAL_KEY: "${FAL_KEY}" } } },
});

describe("harness pure helpers", () => {
  it("mergeServers: inherit none → only declared", () => {
    expect(mergeServers(DEF("none"), { ws: { command: "x" } })).toEqual({ "fal-ai": DEF("none").mcp["fal-ai"] });
  });

  it("mergeServers: inherit workspace → workspace base + declared overlay (declared wins)", () => {
    const merged = mergeServers(DEF("workspace"), { ws: { command: "x" }, "fal-ai": { command: "OLD" } });
    expect(Object.keys(merged).sort()).toEqual(["fal-ai", "ws"]);
    expect((merged["fal-ai"] as any).command).toBe("npx"); // declared overlays the workspace one
  });

  it("mergeServers: inherit workspace with no workspace file → only declared", () => {
    expect(mergeServers(DEF("workspace"), null)).toEqual({ "fal-ai": DEF("workspace").mcp["fal-ai"] });
  });

  it("buildMcpConfig wraps in mcpServers", () => {
    expect(buildMcpConfig({ a: { command: "x" } })).toEqual({ mcpServers: { a: { command: "x" } } });
  });

  it("harnessWiring uses the adapter's claude shape", () => {
    const { env, args } = harnessWiring(claude, "/h/home", "/h/home/mcp.json");
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/h/home" });
    expect(args).toEqual(["--mcp-config", "/h/home/mcp.json", "--strict-mcp-config"]);
  });

  it("path builders", () => {
    expect(harnessHome("/ws", "a")).toBe("/ws/.tachyon/harness/a");
    expect(harnessMcpPath("/ws", "a")).toBe("/ws/.tachyon/harness/a/mcp.json");
  });

  it("realConfigHome honors CLAUDE_CONFIG_DIR override, else ~/.claude", () => {
    expect(realConfigHome({ CLAUDE_CONFIG_DIR: "/custom" }, "/home/u")).toBe("/custom");
    expect(realConfigHome({}, "/home/u")).toBe("/home/u/.claude");
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
    const mgr = new HarnessManager(ws, realHome, PROC);
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

  it("fails closed when a referenced ${VAR} is not in the env (H7 — no unauthenticated MCP)", () => {
    const mgr = new HarnessManager(ws, realHome, {}); // FAL_KEY absent
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(HarnessUnavailableError);
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(/FAL_KEY/);
    expect(fs.existsSync(harnessHome(ws, "researcher"))).toBe(false); // threw BEFORE any fs side effect
  });

  it("fails closed when the real claude credential is absent (H1 — no dangling symlink)", () => {
    fs.rmSync(path.join(realHome, ".credentials.json"));
    const mgr = new HarnessManager(ws, realHome, PROC);
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).toThrow(/credentials|login/i);
  });

  it("inherit: workspace folds the workspace .mcp.json snapshot in (H6)", () => {
    fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { "ws-server": { command: "wsx" } } }));
    const mgr = new HarnessManager(ws, realHome, PROC);
    mgr.materialize("researcher", DEF("workspace"), claude);
    const written = JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8"));
    expect(Object.keys(written.mcpServers).sort()).toEqual(["fal-ai", "ws-server"]);
  });

  it("inherit: none ignores the workspace .mcp.json (no project pickup, H5b)", () => {
    fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { "ws-server": { command: "wsx" } } }));
    const mgr = new HarnessManager(ws, realHome, PROC);
    mgr.materialize("researcher", DEF("none"), claude);
    const written = JSON.parse(fs.readFileSync(harnessMcpPath(ws, "researcher"), "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["fal-ai"]);
  });

  it("rematerialize replaces a stale auth symlink (H6)", () => {
    const mgr = new HarnessManager(ws, realHome, PROC);
    mgr.materialize("researcher", DEF("none"), claude);
    // simulate a stale/broken link, then rematerialize
    const link = path.join(harnessHome(ws, "researcher"), ".credentials.json");
    fs.rmSync(link, { force: true });
    fs.symlinkSync("/nonexistent/stale", link);
    expect(() => mgr.materialize("researcher", DEF("none"), claude)).not.toThrow();
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(realHome, ".credentials.json")));
  });

  it("remove() deletes the home; list() reports existing homes", () => {
    const mgr = new HarnessManager(ws, realHome, PROC);
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
