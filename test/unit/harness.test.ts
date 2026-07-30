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
  authCredentialRank,
  authRankBetter,
  claudeCredentialState,
  listWorkspaceClaudePrivateHomes,
  privateClaudeAuthNeedsReconcile,
  reconcileWorkspaceClaudeAuth,
  defaultRealCodexHome,
  defaultRealPiHome,
  defaultRealGrokHome,
  defaultRealHermesHome,
  isTachyonManagedGrokHome,
  isTachyonManagedHermesHome,
  setHermesMcpServer,
  opencodeHarnessDirs,
} from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import type { HarnessDef } from "../../src/config/loadConfig.js";
import type { ResolvedAgentCapabilityProjection } from "../../src/config/agentProfileResolver.js";

const claude = adapterForRuntime("claude")!;
const codex = adapterForRuntime("codex")!;
const pi = adapterForRuntime("pi")!;
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

  it("SDD 401: defaultRealPiHome ignores Tachyon private overrides", () => {
    expect(defaultRealPiHome({ PI_CODING_AGENT_DIR: "/custom/pi" }, "/home/u")).toBe("/custom/pi");
    expect(defaultRealPiHome({ PI_CODING_AGENT_DIR: "/ws/.tachyon/harness/pi" }, "/home/u")).toBe("/home/u/.pi/agent");
    expect(defaultRealPiHome({}, "/home/u")).toBe("/home/u/.pi/agent");
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

  it("canonical Claude materializes only selected settings and excludes ambient local settings, skills and MCP", () => {
    fs.mkdirSync(path.join(ws, ".claude", "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "guard" }] }] },
      permissions: { allow: ["Read"] },
    }));
    fs.writeFileSync(path.join(ws, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read", "Bash"] },
      prefersReducedMotion: true,
    }));
    fs.writeFileSync(path.join(ws, ".claude", "skills", "review", "SKILL.md"), "# review\n");
    fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({
      mcpServers: { workspace: { command: "workspace-mcp" } },
    }));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const staleHome = harnessHome(ws, "canonical");
    fs.mkdirSync(path.join(staleHome, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(staleHome, "CLAUDE.md"), "stale");

    const res = mgr.materializeCanonicalClaudeHome("canonical", claude, undefined, {
      adapter: "claude",
      selectors: { model: "claude-opus-5", reasoningEffort: "high" },
      settings: {
        permissions: { allow: ["Read"] },
        prefersReducedMotion: false,
      },
    });

    expect(res.env).toEqual({ CLAUDE_CONFIG_DIR: res.home });
    expect(res.args).toEqual([
      "--setting-sources", "user", "--settings", path.join(res.home, "settings.json"),
      "--model", "claude-opus-5", "--effort", "high",
      "--mcp-config", path.join(res.home, "mcp.json"), "--strict-mcp-config",
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(res.home, "settings.json"), "utf8"))).toEqual({
      permissions: { allow: ["Read"] },
      prefersReducedMotion: false,
      autoMemoryEnabled: false,
    });
    expect(fs.existsSync(path.join(res.home, "skills"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(res.home, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
    expect(fs.existsSync(path.join(res.home, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(res.home, "plugins"))).toBe(false);
    expect(fs.lstatSync(path.join(res.home, ".credentials.json")).isSymbolicLink()).toBe(true);

    const withoutSelectors = mgr.materializeCanonicalClaudeHome("canonical", claude, undefined, {
      adapter: "claude",
      selectors: {},
      settings: { prefersReducedMotion: true },
    });
    expect(withoutSelectors.args).not.toContain("--model");
    expect(withoutSelectors.args).not.toContain("--effort");
  });

  it("SDD 471: an authorized bypassPermissions reaches the private home on fresh, restart, resume and fork", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const projection = {
      adapter: "claude" as const,
      selectors: {},
      settings: { permissions: { defaultMode: "bypassPermissions", allow: ["Read"] } },
    };
    const settingsOf = (home: string) =>
      JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));

    // fresh, then restart and resume regenerate the same private generation.
    const fresh = mgr.materializeCanonicalClaudeHome("authorized", claude, undefined, projection);
    const restart = mgr.materializeCanonicalClaudeHome("authorized", claude, undefined, projection);
    const resume = mgr.materializeCanonicalClaudeHome("authorized", claude, undefined, projection);
    for (const phase of [fresh, restart, resume]) {
      expect(phase.home).toBe(fresh.home);
      expect(settingsOf(phase.home).permissions).toEqual({ defaultMode: "bypassPermissions", allow: ["Read"] });
    }

    // a fork is a distinct private home that carries the same authorized projection.
    const fork = mgr.materializeCanonicalClaudeHome("authorized-fork", claude, undefined, projection);
    expect(fork.home).not.toBe(fresh.home);
    expect(settingsOf(fork.home).permissions).toEqual({ defaultMode: "bypassPermissions", allow: ["Read"] });

    // an agent that authorized nothing gets no permissions block at all.
    const unauthorized = mgr.materializeCanonicalClaudeHome("unauthorized", claude, undefined, {
      adapter: "claude", selectors: {}, settings: {},
    });
    expect(settingsOf(unauthorized.home).permissions).toBeUndefined();
  });

  it("canonical Claude consumes captured capabilities, reserves Bridge, and repairs stale projection state", () => {
    const skillBytes = Buffer.from("# Canonical review\n");
    const capabilities: ResolvedAgentCapabilityProjection = {
      schemaVersion: 1,
      adapter: "claude",
      sha256: "a".repeat(64),
      effectiveProfileSha256: "b".repeat(64),
      sources: [
        { referenceId: "review", kind: "skill", scope: "project", owner: "workspace", path: "shared/review", sha256: "c".repeat(64) },
        { referenceId: "docs", kind: "mcp", scope: "profile", owner: "agent", path: "capabilities/docs.yml", sha256: "d".repeat(64) },
      ],
      skills: [{ name: "review", source: {
        source: "shared/review",
        sourcePath: path.join(ws, "shared/review"),
        type: "tree",
        sha256: "c".repeat(64),
        entries: [
          { path: ".", type: "directory", mode: 0o755 },
          { path: "SKILL.md", type: "file", mode: 0o644, bytes: skillBytes },
        ],
      } }],
      mcp: { docs: { command: "node", args: ["docs.js"], env: { FAL_KEY: "${FAL_KEY}" } } },
      hooks: { PostToolUseFailure: [{ hooks: [{ type: "command", command: "node observe.js" }] }] },
      pi: { extensions: [], prompts: [], themes: [], packages: [] },
    };
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } };
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const first = mgr.materializeCanonicalClaudeProfileHome("canonical", claude, {
      nativeConfig: { adapter: "claude", selectors: {}, settings: { prefersReducedMotion: true } },
      capabilities,
    }, undefined, bridge);
    const skillFile = path.join(first.home, "skills", "review", "SKILL.md");
    const manifestFile = path.join(first.home, ".tachyon-profile-capabilities", "manifest.json");

    expect(first.env).toMatchObject({ CLAUDE_CONFIG_DIR: first.home, FAL_KEY: "real-key" });
    expect(fs.readFileSync(skillFile, "utf8")).toBe("# Canonical review\n");
    expect(JSON.parse(fs.readFileSync(path.join(first.home, "settings.json"), "utf8"))).toEqual({
      prefersReducedMotion: true,
      hooks: capabilities.hooks,
      autoMemoryEnabled: false,
    });
    expect(JSON.parse(fs.readFileSync(path.join(first.home, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { docs: capabilities.mcp.docs, tachyon_bridge: bridge },
    });
    expect(JSON.parse(fs.readFileSync(manifestFile, "utf8"))).toMatchObject({
      adapter: "claude",
      effectiveProfileSha256: "b".repeat(64),
      capabilityProjectionSha256: "a".repeat(64),
    });

    fs.writeFileSync(skillFile, "stale");
    fs.writeFileSync(path.join(first.home, "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    fs.writeFileSync(path.join(first.home, "mcp.json"), JSON.stringify({ mcpServers: { attacker: { command: "evil" } } }));
    fs.writeFileSync(manifestFile, "stale");
    mgr.materializeCanonicalClaudeProfileHome("canonical", claude, { capabilities }, undefined, bridge);
    expect(fs.readFileSync(skillFile, "utf8")).toBe("# Canonical review\n");
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(first.home, "settings.json"), "utf8")))).not.toContain("Stop");
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(first.home, "mcp.json"), "utf8")))).not.toContain("attacker");
    expect(JSON.parse(fs.readFileSync(manifestFile, "utf8"))).toMatchObject({ capabilityProjectionSha256: "a".repeat(64) });

    const invalid = structuredClone(capabilities);
    delete invalid.skills[0]!.source.entries.find((entry) => entry.path === "SKILL.md")!.bytes;
    expect(() => mgr.materializeCanonicalClaudeProfileHome("canonical", claude, { capabilities: invalid }))
      .toThrow(/has no bytes/);
    expect(fs.existsSync(manifestFile)).toBe(false);

    mgr.materializeCanonicalClaudeHome("canonical", claude);
    expect(fs.existsSync(path.join(first.home, "skills"))).toBe(false);
    expect(fs.existsSync(manifestFile)).toBe(false);
  });

  it("canonical Claude does not inspect ambient workspace settings without a selected policy", () => {
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    const outside = path.join(path.dirname(ws), "outside-settings.json");
    fs.writeFileSync(outside, "{}");
    fs.symlinkSync(outside, path.join(ws, ".claude", "settings.json"));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));

    expect(() => mgr.materializeCanonicalClaudeHome("canonical", claude)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(harnessHome(ws, "canonical"), "settings.json"), "utf8")))
      .toEqual({ autoMemoryEnabled: false });
  });

  it("canonical Claude keeps only bootstrap markers and exact workspace/cwd trust", () => {
    const realClaudeJson = path.join(realHome, ".claude.json");
    fs.writeFileSync(realClaudeJson, JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.12",
      userID: "u123",
      oauthAccount: { id: "acct" },
      projects: { "/ambient/sibling": { hasTrustDialogAccepted: true } },
      attackerState: "must-not-copy",
    }));
    const mgr = new HarnessManager(ws, realHome, PROC, realClaudeJson);
    const home = harnessHome(ws, "canonical");

    mgr.materializeCanonicalClaudeHome("canonical", claude);
    let cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(cfg).toEqual({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.12",
      userID: "u123",
      oauthAccount: { id: "acct" },
      projects: {
        [path.resolve(ws)]: { hasTrustDialogAccepted: true },
      },
    });

    const firstCwd = path.join(ws, "worktrees", "first");
    const secondCwd = path.join(ws, "worktrees", "second");
    mgr.materializeCanonicalClaudeHome("canonical", claude, firstCwd);
    cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(cfg.projects).toEqual({
      [path.resolve(ws)]: { hasTrustDialogAccepted: true },
      [path.resolve(firstCwd)]: { hasTrustDialogAccepted: true },
    });

    cfg.projects["/stale/private-home-write"] = { hasTrustDialogAccepted: true };
    cfg.runtimeState = "must-be-removed";
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify(cfg));
    mgr.materializeCanonicalClaudeHome("canonical", claude, secondCwd);
    cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(cfg.projects).toEqual({
      [path.resolve(ws)]: { hasTrustDialogAccepted: true },
      [path.resolve(secondCwd)]: { hasTrustDialogAccepted: true },
    });
    expect(cfg).not.toHaveProperty("runtimeState");
    expect(JSON.stringify(cfg)).not.toContain("ambient/sibling");
    expect(JSON.stringify(cfg)).not.toContain("stale/private-home-write");
    expect(fs.realpathSync(path.join(home, ".credentials.json")))
      .toBe(fs.realpathSync(path.join(realHome, ".credentials.json")));
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

  it("SDD 401: Pi gets regular private JSON snapshots, strict permissions, and no executable-tree inheritance", () => {
    const piHome = path.join(path.dirname(realHome), "realpi");
    fs.mkdirSync(path.join(piHome, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(piHome, "auth.json"), '{"openai":{"type":"oauth"}}');
    fs.writeFileSync(path.join(piHome, "settings.json"), '{"theme":"dark","packages":["unsafe-global-package"],"extensions":["/global/extension.js"],"skills":["/global/skills"]}');
    fs.writeFileSync(path.join(piHome, "trust.json"), '{}');
    fs.writeFileSync(path.join(piHome, "extensions", "global.js"), "throw new Error('must not inherit')");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);

    const a = mgr.materializePiHomeOnly("pi-a");
    const b = mgr.materializePiHomeOnly("pi-b");
    expect(a.env).toEqual({
      PI_CODING_AGENT_DIR: harnessHome(ws, "pi-a"),
      PI_CODING_AGENT_SESSION_DIR: path.join(harnessHome(ws, "pi-a"), "sessions"),
    });
    expect(b.env.PI_CODING_AGENT_DIR).not.toBe(a.env.PI_CODING_AGENT_DIR);
    expect(fs.statSync(a.home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(a.env.PI_CODING_AGENT_SESSION_DIR).mode & 0o777).toBe(0o700);
    const auth = path.join(a.home, "auth.json");
    expect(fs.lstatSync(auth).isFile()).toBe(true);
    expect(fs.lstatSync(auth).isSymbolicLink()).toBe(false);
    expect(fs.statSync(auth).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(a.home, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    expect(fs.existsSync(path.join(a.home, "extensions"))).toBe(false);

    // Pi owns later private mutations; rematerialization validates but does not overwrite them.
    fs.writeFileSync(path.join(a.home, "settings.json"), '{"theme":"light"}');
    fs.writeFileSync(path.join(a.home, "trust.json"), '{"/runtime-owned":false}');
    mgr.materializePiHomeOnly("pi-a");
    expect(JSON.parse(fs.readFileSync(path.join(a.home, "settings.json"), "utf8"))).toEqual({ theme: "light" });
    expect(JSON.parse(fs.readFileSync(path.join(a.home, "trust.json"), "utf8"))).toEqual({ "/runtime-owned": false });
  });

  it("canonical Pi replaces ambient and stale trust with the exact workspace and effective cwd", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-canonical-trust");
    const cwd = path.join(path.dirname(ws), "pi-worktree");
    fs.mkdirSync(piHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(piHome, "auth.json"), '{"provider":{"type":"oauth"}}');
    fs.writeFileSync(path.join(piHome, "settings.json"), '{"theme":"dark"}');
    fs.writeFileSync(path.join(piHome, "trust.json"), '{"/ambient-parent":true,"/ambient-denial":false}');
    const mgr = new HarnessManager(
      ws,
      realHome,
      PROC,
      path.join(realHome, ".claude.json"),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      piHome,
    );

    const result = mgr.materializePiHomeOnly("pi-canonical", { exactTrustCwd: cwd });
    const trustPath = path.join(result.home, "trust.json");
    expect(JSON.parse(fs.readFileSync(trustPath, "utf8"))).toEqual({
      [fs.realpathSync(ws)]: true,
      [fs.realpathSync(cwd)]: true,
    });
    expect(fs.statSync(trustPath).mode & 0o777).toBe(0o600);

    fs.writeFileSync(trustPath, '{"/stale-parent":true,"/stale-denial":false}');
    fs.writeFileSync(path.join(result.home, "settings.json"), '{"theme":"runtime-owned"}');
    mgr.materializePiHomeOnly("pi-canonical", { exactTrustCwd: cwd });
    expect(JSON.parse(fs.readFileSync(trustPath, "utf8"))).toEqual({
      [fs.realpathSync(ws)]: true,
      [fs.realpathSync(cwd)]: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(result.home, "settings.json"), "utf8")))
      .toEqual({ theme: "runtime-owned" });
    expect(JSON.parse(fs.readFileSync(path.join(result.home, "auth.json"), "utf8")))
      .toEqual({ provider: { type: "oauth" } });

    const same = mgr.materializePiHomeOnly("pi-same-cwd", { exactTrustCwd: ws });
    expect(JSON.parse(fs.readFileSync(path.join(same.home, "trust.json"), "utf8")))
      .toEqual({ [fs.realpathSync(ws)]: true });
  });

  it("SDD 401: Pi environment-only auth works, while unsafe JSON sources and targets fail closed", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-empty");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "settings.json"), "{}");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);
    expect(() => mgr.materializePiHomeOnly("env-auth")).not.toThrow();
    expect(fs.existsSync(path.join(harnessHome(ws, "env-auth"), "auth.json"))).toBe(false);

    fs.writeFileSync(path.join(piHome, "auth.json"), "not-json");
    expect(() => mgr.materializePiHomeOnly("bad-source")).toThrow(/not a readable JSON object/);
    fs.rmSync(path.join(piHome, "auth.json"));
    fs.symlinkSync(path.join(piHome, "settings.json"), path.join(piHome, "auth.json"));
    expect(() => mgr.materializePiHomeOnly("linked-source")).toThrow(/regular no-follow file/);
    fs.rmSync(path.join(piHome, "auth.json"));
    const unsafe = harnessHome(ws, "unsafe-target");
    fs.mkdirSync(unsafe, { recursive: true });
    fs.symlinkSync(path.join(piHome, "settings.json"), path.join(unsafe, "settings.json"));
    expect(() => mgr.materializePiHomeOnly("unsafe-target")).toThrow(/regular no-follow file/);

    const unsafeTrust = harnessHome(ws, "unsafe-exact-trust");
    fs.mkdirSync(unsafeTrust, { recursive: true });
    fs.symlinkSync(path.join(piHome, "settings.json"), path.join(unsafeTrust, "trust.json"));
    expect(() => mgr.materializePiHomeOnly("unsafe-exact-trust", { exactTrustCwd: ws }))
      .toThrow(/regular no-follow file/);
  });

  it("SDD 406: Pi snapshots an exact resource generation and returns only explicit CLI resource paths", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-resources");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "settings.json"), '{"theme":"dark","quietStartup":true}');

    fs.mkdirSync(path.join(ws, "pi-resources", "extension"), { recursive: true });
    fs.writeFileSync(path.join(ws, "pi-resources", "extension", "index.ts"), "export default function () {}\n");
    fs.writeFileSync(path.join(ws, "pi-resources", "extension", "helper.ts"), "export const value = 1;\n");
    fs.mkdirSync(path.join(ws, "pi-resources", "skill"), { recursive: true });
    fs.writeFileSync(path.join(ws, "pi-resources", "skill", "SKILL.md"), "---\nname: harness-skill\ndescription: exact\n---\n");
    fs.writeFileSync(path.join(ws, "pi-resources", "review.md"), "---\ndescription: review\n---\nReview.\n");
    fs.writeFileSync(path.join(ws, "pi-resources", "theme.json"), '{"name":"harness-theme","colors":{}}');
    fs.mkdirSync(path.join(ws, "pi-resources", "package", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(ws, "pi-resources", "package", "package.json"), '{"name":"local-pi-package","pi":{"prompts":["prompts"]}}');
    fs.writeFileSync(path.join(ws, "pi-resources", "package", "prompts", "package-command.md"), "Package prompt.\n");

    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);
    const seeded = mgr.materializePiHomeOnly("pi-exact");
    const settingsBefore = fs.readFileSync(path.join(seeded.home, "settings.json"), "utf8");
    const result = mgr.materializePiHome("pi-exact", {
      inherit: "workspace",
      extensions: ["pi-resources/extension"],
      skills: ["pi-resources/skill"],
      prompts: ["pi-resources/review.md"],
      themes: ["pi-resources/theme.json"],
      packages: ["pi-resources/package"],
    });

    expect(result.args.slice(0, 4)).toEqual(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]);
    expect(result.args.filter((arg) => arg === "--extension")).toHaveLength(2);
    expect(result.args).toContain("--skill");
    expect(result.args).toContain("--prompt-template");
    expect(result.args).toContain("--theme");
    expect(result.args.join(" ")).toContain("/.tachyon-resources/generation-");
    expect(result.args.join(" ")).not.toContain(".staging-");
    expect(fs.readFileSync(path.join(result.home, "settings.json"), "utf8")).toBe(settingsBefore);
    expect(fs.existsSync(path.join(result.home, ".tachyon-resources"))).toBe(true);
    expect(fs.existsSync(path.join(result.home, "extensions"))).toBe(false);
  });

  it("SDD 406: Pi resource rematerialization isolates siblings, reuses content generations, and no-harness mode preserves settings", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-rematerialize");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "settings.json"), '{"theme":"light"}');
    for (const name of ["one", "two"]) {
      fs.mkdirSync(path.join(ws, "skills", name), { recursive: true });
      fs.writeFileSync(path.join(ws, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
    }
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);
    const first = mgr.materializePiHome("pi-a", { inherit: "workspace", skills: ["skills/one"] });
    const sibling = mgr.materializePiHome("pi-b", { inherit: "workspace", skills: ["skills/two"] });
    const repeated = mgr.materializePiHome("pi-a", { inherit: "workspace", skills: ["skills/one"] });
    const second = mgr.materializePiHome("pi-a", { inherit: "workspace", skills: ["skills/two"] });

    expect(first.args.join(" ")).toContain("/skills/one");
    const firstSkillPath = first.args[first.args.indexOf("--skill") + 1]!.slice(1, -1);
    expect(fs.existsSync(firstSkillPath)).toBe(true);
    expect(repeated.args).toEqual(first.args);
    fs.writeFileSync(path.join(firstSkillPath, "SKILL.md"), "tampered\n");
    const repaired = mgr.materializePiHome("pi-a", { inherit: "workspace", skills: ["skills/one"] });
    expect(repaired.args).toEqual(first.args);
    expect(fs.readFileSync(path.join(firstSkillPath, "SKILL.md"), "utf8")).toContain("name: one");
    expect(second.args.join(" ")).toContain("/skills/two");
    expect(second.args.join(" ")).not.toContain("/skills/one");
    expect(sibling.home).not.toBe(first.home);
    expect(sibling.args.join(" ")).not.toContain(first.home);
    const generations = fs.readdirSync(path.join(first.home, ".tachyon-resources")).filter((name) => name.startsWith("generation-"));
    expect(generations).toHaveLength(2);
    expect(fs.existsSync(firstSkillPath)).toBe(true);

    fs.writeFileSync(path.join(first.home, "settings.json"), '{"theme":"agent-owned"}');
    const ordinary = mgr.materializePiHomeOnly("pi-a");
    expect(ordinary.args).toEqual([]);
    expect(fs.existsSync(path.join(first.home, ".tachyon-resources"))).toBe(true);
    expect(fs.existsSync(firstSkillPath)).toBe(true);
    expect(fs.readFileSync(path.join(first.home, "settings.json"), "utf8")).toBe('{"theme":"agent-owned"}');
  });

  it("SDD 406: Pi rejects symlinked resource trees and never publishes staging argv", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-unsafe-resources");
    fs.mkdirSync(piHome, { recursive: true });
    fs.mkdirSync(path.join(ws, "skills", "unsafe"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "unsafe", "SKILL.md"), "---\nname: unsafe\ndescription: unsafe\n---\n");
    fs.symlinkSync(path.join(piHome, "secret.json"), path.join(ws, "skills", "unsafe", "secret-link"));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);

    expect(() => mgr.materializePiHome("pi-unsafe", { inherit: "workspace", skills: ["skills/unsafe"] })).toThrow(/symlink or special file/);
    const root = path.join(harnessHome(ws, "pi-unsafe"), ".tachyon-resources");
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readdirSync(root).some((name) => name.startsWith("generation-") || name.startsWith(".staging-"))).toBe(false);
  });

  it("SDD 406: Pi rejects duplicate, escaping, special-file, unsafe-package, and unsafe owned-root inputs", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-invalid-resources");
    fs.mkdirSync(piHome, { recursive: true });
    fs.mkdirSync(path.join(ws, "one"), { recursive: true });
    fs.mkdirSync(path.join(ws, "two"), { recursive: true });
    fs.writeFileSync(path.join(ws, "one", "same.md"), "one");
    fs.writeFileSync(path.join(ws, "two", "same.md"), "two");
    const outside = path.join(path.dirname(ws), "outside-skill");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: outside\ndescription: outside\n---\n");
    fs.symlinkSync(outside, path.join(ws, "escaping-skill"));
    execFileSync("mkfifo", [path.join(ws, "special.md")]);
    fs.mkdirSync(path.join(ws, "unsafe-package"), { recursive: true });
    fs.writeFileSync(path.join(ws, "unsafe-package", "package.json"), '{"pi":{"extensions":["../../auth.json"]}}');
    const malformedPackages = [
      ["bad-extension-package", "extensions", "readme.txt", "not code"],
      ["bad-skill-package", "skills/bad", "README.md", "no skill manifest"],
      ["bad-prompt-package", "prompts", "prompt.txt", "wrong extension"],
      ["bad-theme-package", "themes", "theme.json", "not json"],
    ] as const;
    for (const [pkg, directory, file, content] of malformedPackages) {
      fs.mkdirSync(path.join(ws, pkg, directory), { recursive: true });
      fs.writeFileSync(path.join(ws, pkg, directory, file), content);
    }
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);

    expect(() => mgr.materializePiHome("pi-duplicate", { inherit: "workspace", prompts: ["one/same.md", "two/same.md"] })).toThrow(/duplicate Pi prompts resource basename/);
    expect(() => mgr.materializePiHome("pi-escape", { inherit: "workspace", skills: ["escaping-skill"] })).toThrow(/escapes the workspace/);
    expect(() => mgr.materializePiHome("pi-special", { inherit: "workspace", prompts: ["special.md"] })).toThrow(/regular no-follow file or directory/);
    expect(() => mgr.materializePiHome("pi-package", { inherit: "workspace", packages: ["unsafe-package"] })).toThrow(/pi manifest or conventional resource directory/);
    for (const [pkg] of malformedPackages) {
      expect(() => mgr.materializePiHome(`pi-${pkg}`, { inherit: "workspace", packages: [pkg] })).toThrow(/pi manifest or conventional resource directory/);
    }

    const ownedRoot = path.join(harnessHome(ws, "pi-root"), ".tachyon-resources");
    fs.mkdirSync(path.dirname(ownedRoot), { recursive: true });
    fs.symlinkSync(outside, ownedRoot);
    expect(() => mgr.materializePiHome("pi-root", { inherit: "workspace", skills: ["escaping-skill"] })).toThrow(/resource root must be a real directory/);
  });

  it("SDD 428: Pi materializes captured profile resources into a content-addressed generation", () => {
    const piHome = path.join(path.dirname(realHome), "realpi-profile");
    fs.mkdirSync(piHome, { recursive: true });
    const promptBytes = Buffer.from("Review with evidence.\n");
    const projection: ResolvedAgentCapabilityProjection = {
      schemaVersion: 1,
      adapter: "pi",
      sha256: "d".repeat(64),
      effectiveProfileSha256: "e".repeat(64),
      sources: [{ referenceId: "review-prompt", kind: "pi-prompt", scope: "profile", owner: "11111111-1111-4111-8111-111111111111", path: "capabilities/review.md", sha256: "f".repeat(64) }],
      skills: [],
      mcp: {},
      hooks: {},
      pi: { extensions: [], themes: [], packages: [], prompts: [{ name: "review.md", source: {
        source: "capabilities/review.md",
        sourcePath: path.join(ws, "capabilities/review.md"),
        type: "file",
        sha256: "f".repeat(64),
        entries: [{ path: ".", type: "file", mode: 0o644, bytes: promptBytes }],
      } }] },
    };
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, undefined, undefined, piHome);
    const first = mgr.materializeProfileCapabilities("pi-profile", projection, pi);
    const repeated = mgr.materializeProfileCapabilities("pi-profile", projection, pi);

    expect(repeated.args).toEqual(first.args);
    const promptArg = first.args[first.args.indexOf("--prompt-template") + 1]!.slice(1, -1);
    expect(fs.readFileSync(promptArg, "utf8")).toBe("Review with evidence.\n");
    expect(promptArg).toContain("generation-");
    const manifest = JSON.parse(fs.readFileSync(path.join(first.home, ".tachyon-profile-capabilities", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ adapter: "pi", capabilityProjectionSha256: "d".repeat(64) });

    fs.writeFileSync(promptArg, "tampered\n");
    const repaired = mgr.materializeProfileCapabilities("pi-profile", projection, pi);
    const repairedPrompt = repaired.args[repaired.args.indexOf("--prompt-template") + 1]!.slice(1, -1);
    expect(repairedPrompt).toBe(promptArg);
    expect(fs.readFileSync(repairedPrompt, "utf8")).toBe("Review with evidence.\n");
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

  it("SDD 428: Codex consumes captured profile bytes, records provenance, and repairs projection tampering", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex-profile");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.mkdirSync(path.join(ws, ".agents", "skills", "workspace-plugin"), { recursive: true });
    const pluginSkill = "workspace plugin bytes\n";
    const pluginConfig = "[mcp_servers.workspace_plugin]\ncommand = \"plugin-server\"\n";
    fs.writeFileSync(path.join(ws, ".agents", "skills", "workspace-plugin", "SKILL.md"), pluginSkill);
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".codex", "config.toml"), pluginConfig);
    const skillBytes = Buffer.from("---\nname: research\ndescription: research\n---\nCanonical skill.\n");
    const projection: ResolvedAgentCapabilityProjection = {
      schemaVersion: 1,
      adapter: "codex",
      sha256: "a".repeat(64),
      effectiveProfileSha256: "b".repeat(64),
      sources: [{ referenceId: "research", kind: "skill", scope: "project", owner: "workspace", path: "shared/research", sha256: "c".repeat(64) }],
      skills: [{ name: "research", source: { source: "shared/research", sourcePath: path.join(ws, "shared/research"), type: "tree", sha256: "c".repeat(64), entries: [
        { path: ".", type: "directory", mode: 0o755 },
        { path: "SKILL.md", type: "file", mode: 0o644, bytes: skillBytes },
      ] } }],
      mcp: { docs: { command: "node", args: ["server.js"], env: { FAL_KEY: "${FAL_KEY}" } } },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node guard.js" }] }] },
      pi: { extensions: [], prompts: [], themes: [], packages: [] },
    };
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const nativeConfig = {
      adapter: "codex" as const,
      selectors: { model: "gpt-5.6", provider: "openai" },
      permissions: { approvalPolicy: "on-request" },
    };
    const first = mgr.materializeCanonicalCodexProfileHome("coder", codex, { nativeConfig, capabilities: projection }, undefined, {
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" },
    });
    const skillFile = path.join(first.home, "skills", "research", "SKILL.md");
    const manifestFile = path.join(first.home, ".tachyon-profile-capabilities", "manifest.json");

    expect(fs.readFileSync(skillFile, "utf8")).toContain("Canonical skill");
    const config = fs.readFileSync(path.join(first.home, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.6"');
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain("[mcp_servers.docs]");
    expect(config).toContain("[mcp_servers.tachyon_bridge]");
    expect(config).toContain("hooks.SessionStart =");
    expect(first.env.FAL_KEY).toBe("real-key");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    expect(manifest).toMatchObject({ effectiveProfileSha256: "b".repeat(64), capabilityProjectionSha256: "a".repeat(64), sources: [{ owner: "workspace" }] });
    expect(JSON.stringify(manifest)).not.toContain("real-key");
    expect(fs.readFileSync(path.join(ws, ".agents", "skills", "workspace-plugin", "SKILL.md"), "utf8")).toBe(pluginSkill);
    expect(fs.readFileSync(path.join(ws, ".codex", "config.toml"), "utf8")).toBe(pluginConfig);

    fs.writeFileSync(skillFile, "tampered");
    fs.writeFileSync(manifestFile, "tampered");
    fs.writeFileSync(path.join(first.home, "config.toml"), "[mcp_servers.attacker]\ncommand = \"evil\"\n");
    mgr.materializeCanonicalCodexProfileHome("coder", codex, { nativeConfig, capabilities: projection });
    expect(fs.readFileSync(skillFile, "utf8")).toContain("Canonical skill");
    expect(fs.readFileSync(path.join(first.home, "config.toml"), "utf8")).not.toContain("attacker");
    expect(JSON.parse(fs.readFileSync(manifestFile, "utf8"))).toMatchObject({ capabilityProjectionSha256: "a".repeat(64) });
    expect(fs.readFileSync(path.join(ws, ".codex", "config.toml"), "utf8")).toBe(pluginConfig);

    fs.rmSync(path.join(first.home, "skills"), { recursive: true });
    fs.writeFileSync(path.join(first.home, "skills"), "unsafe replacement");
    expect(() => mgr.materializeCanonicalCodexProfileHome("coder", codex, { nativeConfig, capabilities: projection })).toThrow(/skill projection target must be a real directory/);
    expect(fs.existsSync(manifestFile)).toBe(false);
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

  it("canonical Codex profiles suppress the real native config in their private home", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "ambient-model"\n');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);

    const inherited = mgr.materializeHomeOnly("coder", codex);
    expect(fs.readFileSync(path.join(inherited.home, "config.toml"), "utf8")).toContain("ambient-model");

    const suppressed = mgr.materializeHomeOnly("coder", codex, undefined, { inheritNativeConfig: false });
    expect(fs.existsSync(path.join(suppressed.home, "config.toml"))).toBe(false);
    expect(fs.realpathSync(path.join(suppressed.home, "auth.json"))).toBe(fs.realpathSync(path.join(codexHome, "auth.json")));
  });

  it("canonical Codex projection rewrites only typed allowlisted keys on every launch", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'model = "ambient-model"',
      'approval_policy = "never"',
      '[projects."/ambient/sibling"]',
      'trust_level = "trusted"',
      '[mcp_servers.secret]',
      'command = "do-not-copy"',
    ].join("\n"));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const projection = {
      adapter: "codex" as const,
      selectors: {
        model: "gpt-5.6",
        provider: "openai",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
      permissions: {
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      },
      interface: {
        personality: "pragmatic",
        statusLine: ["model", "git-branch"],
        statusLineUseColors: false,
      },
      featureFlags: {
        terminalResizeReflow: true,
      },
    };

    const first = mgr.materializeCanonicalCodexHome("coder", codex, projection);
    expect(fs.readFileSync(path.join(first.home, "config.toml"), "utf8")).toBe([
      'model = "gpt-5.6"',
      'model_provider = "openai"',
      'model_reasoning_effort = "high"',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'personality = "pragmatic"',
      "",
      "[tui]",
      'status_line = ["model", "git-branch"]',
      "status_line_use_colors = false",
      "",
      "[features]",
      "terminal_resize_reflow = true",
      "",
      `[projects.${JSON.stringify(path.resolve(ws))}]`,
      'trust_level = "trusted"',
      "",
    ].join("\n"));
    expect(fs.realpathSync(path.join(first.home, "auth.json"))).toBe(fs.realpathSync(path.join(codexHome, "auth.json")));

    fs.writeFileSync(path.join(first.home, "config.toml"), 'approval_policy = "never"\n');
    mgr.materializeCanonicalCodexHome("coder", codex, projection);
    expect(fs.readFileSync(path.join(first.home, "config.toml"), "utf8")).toContain('approval_policy = "on-request"');
    expect(fs.readFileSync(path.join(first.home, "config.toml"), "utf8")).not.toContain("do-not-copy");
    expect(fs.readFileSync(path.join(first.home, "config.toml"), "utf8")).not.toContain("/ambient/sibling");
  });

  it("SDD 472: an authorized dangerous Codex value reaches the private home on fresh, restart and resume", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex-authorized");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    // What an AUTHORIZED profile projects; the projector is what decides it may be here at all.
    const projection = {
      adapter: "codex" as const,
      selectors: {},
      permissions: { approvalPolicy: "never", sandboxMode: "danger-full-access" },
    };
    const configOf = (home: string) => fs.readFileSync(path.join(home, "config.toml"), "utf8");

    const fresh = mgr.materializeCanonicalCodexHome("authorized", codex, projection);
    const restart = mgr.materializeCanonicalCodexHome("authorized", codex, projection);
    const resume = mgr.materializeCanonicalCodexHome("authorized", codex, projection);
    for (const phase of [fresh, restart, resume]) {
      expect(phase.home).toBe(fresh.home);
      expect(configOf(phase.home)).toContain('approval_policy = "never"');
      expect(configOf(phase.home)).toContain('sandbox_mode = "danger-full-access"');
    }

    // An agent that authorized nothing gets no permission keys at all.
    const unauthorized = mgr.materializeCanonicalCodexHome("unauthorized", codex, {
      adapter: "codex" as const, selectors: {}, permissions: {},
    });
    expect(configOf(unauthorized.home)).not.toContain("approval_policy");
    expect(configOf(unauthorized.home)).not.toContain("sandbox_mode");
  });

  it("canonical Codex trusts only the exact workspace and effective cwd on every materialization", () => {
    const codexHome = path.join(path.dirname(realHome), "realcodex-trust");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), codexHome);
    const projection = {
      adapter: "codex" as const,
      selectors: { model: "gpt-5.6" },
      permissions: { approvalPolicy: "on-request", sandboxMode: "workspace-write" },
      interface: { personality: "pragmatic" },
      featureFlags: { terminalResizeReflow: true },
    };
    const firstCwd = path.join(ws, "packages", "first");
    const secondCwd = path.join(ws, "packages", "second");
    const sibling = path.join(path.dirname(ws), "sibling");

    const first = mgr.materializeCanonicalCodexHome("coder", codex, projection, firstCwd);
    let toml = fs.readFileSync(path.join(first.home, "config.toml"), "utf8");
    expect(toml).toContain(`[projects.${JSON.stringify(path.resolve(ws))}]\ntrust_level = "trusted"`);
    expect(toml).toContain(`[projects.${JSON.stringify(path.resolve(firstCwd))}]\ntrust_level = "trusted"`);
    expect(toml).not.toContain(JSON.stringify(sibling));
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain("[features]");

    fs.appendFileSync(path.join(first.home, "config.toml"), [
      "",
      `[projects.${JSON.stringify(path.resolve(sibling))}]`,
      'trust_level = "trusted"',
      "",
    ].join("\n"));
    mgr.materializeCanonicalCodexHome("coder", codex, projection, secondCwd);
    toml = fs.readFileSync(path.join(first.home, "config.toml"), "utf8");
    expect(toml).toContain(`[projects.${JSON.stringify(path.resolve(secondCwd))}]\ntrust_level = "trusted"`);
    expect(toml).not.toContain(JSON.stringify(firstCwd));
    expect(toml).not.toContain(JSON.stringify(sibling));
    expect(toml).toContain('model = "gpt-5.6"');
    expect(toml).toContain('personality = "pragmatic"');
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

  it("t-0e88f3: a grok isolate:transcript home pins GROK_MEMORY=0, not just --no-memory", () => {
    // The flag alone was measured NOT to outrank an ambient GROK_MEMORY=1 (t-0e88f3), so the env pin
    // is what actually stops a hostile environment re-enabling memory on a private home. The flag is
    // still emitted — free and documented — but it is no longer the thing being relied on.
    const realGrokHome = path.join(path.dirname(ws), "real-grok-pin");
    fs.mkdirSync(realGrokHome, { recursive: true });
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"GROK"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const res = mgr.materializeHomeOnly("solo", adapterForRuntime("grok")!);
    expect(res.args).toEqual(["--no-memory"]);
    expect(res.env.GROK_MEMORY).toBe("0");
  });

  it("t-0e88f3: a grok HARNESS home pins the memory env too, and a secret cannot overwrite it", () => {
    // The ordering matters and is easy to get wrong: secretEnv is spread from user-controlled config,
    // so a `GROK_MEMORY` secret spread AFTER the pin would silently re-enable memory on the canonical
    // path — the exact hostile-environment case the pin exists for, arriving through Tachyon's own map.
    const realGrokHome = path.join(path.dirname(ws), "real-grok-harness-pin");
    fs.mkdirSync(realGrokHome, { recursive: true });
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"GROK"}');
    const mgr = new HarnessManager(
      ws,
      realHome,
      { ...PROC, HOSTILE: "1" },
      path.join(realHome, ".claude.json"),
      undefined,
      undefined,
      undefined,
      realGrokHome,
    );
    const res = mgr.materialize(
      "harnessed",
      { mcp: { servers: { s: { command: "x", env: { GROK_MEMORY: "${HOSTILE}" } } } } } as never,
      adapterForRuntime("grok")!,
    );
    expect(res.args).toContain("--no-memory");
    expect(res.env.GROK_MEMORY, "the memory pin outranks anything in the secret map").toBe("0");
  });

  it("t-843576: materializeBridgeMcpGrok writes private GROK_HOME with tachyon_bridge + auth copy", () => {
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
    // t-de73e0 — a private COPY, never a pointer at the person's credential.
    expect(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(home, "auth.json"), "utf8")).toBe('{"token":"GROK"}');
    expect(fs.statSync(path.join(home, "auth.json")).mode & 0o777).toBe(0o600);
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.tachyon_bridge]");
    expect(toml).toContain('url = "http://127.0.0.1:9/mcp"');
    expect(toml).toContain('Authorization');
    expect(toml).toContain("Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}");
    expect(toml).not.toMatch(/Bearer\s+[a-f0-9]{16,}/i); // no literal secret on disk
    // Folder-trust is seeded for the workspace so the interactive "Do you trust…" prompt is skipped.
    const trust = fs.readFileSync(path.join(home, "trusted_folders.toml"), "utf8");
    expect(trust).toContain(`[folders."${path.resolve(ws)}"]`);
    expect(trust).toMatch(/trusted\s*=\s*true/);
    // Does not touch a workspace/user ~/.grok/config.toml
    expect(fs.existsSync(path.join(ws, ".grok", "config.toml"))).toBe(false);
    // GC removes the private home
    mgr.removeBridgeMcp("solo");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("t-26f508: a canonical Grok home keeps the projection, Bridge, trust and auth across every launch", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-native");
    fs.mkdirSync(realGrokHome, { recursive: true });
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"GROK"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };
    const nativeConfig = {
      adapter: "grok" as const,
      selectors: {},
      toml: { "models.default": "grok-4.5", "ui.permission_mode": "ask", "features.telemetry": false },
    };
    const home = mgr.materializeBridgeMcpGrok("canonical", bridge, ws, { exactTrust: true, nativeConfig });
    const first = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    // The projection, the isolation pins and the Bridge coexist in one file.
    expect(first).toContain('default = "grok-4.5"');
    expect(first).toContain('permission_mode = "ask"');
    expect(first).toContain("[compat.claude]");
    expect(first).toContain("enabled = false");
    expect(first).toContain("[mcp_servers.tachyon_bridge]");

    // Restart/resume rewrite the same home. The bytes must be identical, and the external credential
    // must survive the rewrite — a projection that cost the agent its auth is not parity.
    mgr.materializeBridgeMcpGrok("canonical", bridge, ws, { exactTrust: true, nativeConfig });
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe(first);
    expect(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(home, "auth.json"))).toBe(true);
    expect(fs.readFileSync(path.join(home, "trusted_folders.toml"), "utf8")).toMatch(/trusted\s*=\s*true/);

    // Stale projected state is REPLACED, not merged: dropping a family must remove its key.
    mgr.materializeBridgeMcpGrok("canonical", bridge, ws, {
      exactTrust: true,
      nativeConfig: { adapter: "grok", selectors: {}, toml: { "models.default": "grok-4.5" } },
    });
    const narrowed = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(narrowed).not.toContain("permission_mode");
    expect(narrowed).toContain("[mcp_servers.tachyon_bridge]");
  });

  it("seeds Grok folder-trust for workspace + spawn cwd and preserves prior trusted entries", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-trust");
    fs.mkdirSync(realGrokHome, { recursive: true });
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"GROK"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };
    const worktree = path.join(path.dirname(ws), "wt-agent");
    fs.mkdirSync(worktree, { recursive: true });
    const home = mgr.materializeBridgeMcpGrok("solo", bridge, worktree);
    const trustPath = path.join(home, "trusted_folders.toml");
    let trust = fs.readFileSync(trustPath, "utf8");
    expect(trust).toContain(`[folders."${path.resolve(ws)}"]`);
    expect(trust).toContain(`[folders."${path.resolve(worktree)}"]`);
    expect(trust.match(/trusted\s*=\s*true/g)?.length).toBeGreaterThanOrEqual(2);

    // Rematerialize must keep prior grants and not thrash decided_at for already-trusted folders.
    const before = trust;
    mgr.materializeBridgeMcpGrok("solo", bridge, worktree);
    trust = fs.readFileSync(trustPath, "utf8");
    expect(trust).toBe(before);
  });

  it("canonical Grok rewrites folder trust to the exact workspace and effective cwd set", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-exact-trust");
    fs.mkdirSync(realGrokHome, { recursive: true });
    fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"GROK"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const cwd = path.join(path.dirname(ws), "external-project");
    fs.mkdirSync(cwd, { recursive: true });
    const home = bridgeGrokHome(ws, "canonical");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "trusted_folders.toml"), '[folders."/stale"]\ntrusted = true\ndecided_at = 1\n');

    mgr.materializeBridgeMcpGrok("canonical", {}, cwd, { exactTrust: true });

    const trust = fs.readFileSync(path.join(home, "trusted_folders.toml"), "utf8");
    expect(trust).not.toContain("/stale");
    expect(trust).toContain(`[folders."${path.resolve(ws)}"]`);
    expect(trust).toContain(`[folders."${path.resolve(cwd)}"]`);
    expect(trust.match(/trusted\s*=\s*true/g)).toHaveLength(2);
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
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);

    fs.writeFileSync(privateAuth, '{"token":"FRESH"}');
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const newTime = new Date("2026-01-01T00:00:10.000Z");
    fs.utimesSync(realAuth, oldTime, oldTime);
    fs.utimesSync(privateAuth, newTime, newTime);

    mgr.materializeBridgeMcpGrok("solo", bridge);

    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"FRESH"}');
    expect(fs.statSync(realAuth).mode & 0o777).toBe(0o600);
    // The refreshed private credential is harvested back and kept — not reverted to a stale copy.
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(privateAuth, "utf8")).toBe('{"token":"FRESH"}');
  });

  it("t-2b0a08: materializeBridgeMcpGrok keeps the private auth copy converged on rematerialize", () => {
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
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(privateAuth, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"GROK"}');
  });

  it("t-6c8437: prefer non-expired private auth over expired real even when create_time is older", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-expired");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    // Real: newer create_time but access already expired (revoked refresh sibling case).
    fs.writeFileSync(
      realAuth,
      JSON.stringify({
        "https://auth.x.ai::x": {
          key: "EXPIRED_KEY",
          create_time: "2026-07-24T18:00:00.000Z",
          expires_at: "2026-07-24T01:00:00.000Z",
        },
      }),
    );
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    };
    const home = mgr.materializeBridgeMcpGrok("solo", bridge);
    const privateAuth = path.join(home, "auth.json");
    fs.unlinkSync(privateAuth);
    // Private: older create_time but still-valid access — must win (login wall otherwise).
    fs.writeFileSync(
      privateAuth,
      JSON.stringify({
        "https://auth.x.ai::x": {
          key: "FRESH_KEY",
          create_time: "2026-07-23T12:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      }),
    );
    const result = mgr.reconcileGrokAuthFromWorkspace();
    expect(result.promoted).toBe(true);
    const real = JSON.parse(fs.readFileSync(realAuth, "utf8")) as { "https://auth.x.ai::x": { key: string } };
    expect(real["https://auth.x.ai::x"].key).toBe("FRESH_KEY");
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);
  });

  it("t-6c8437: maybeHarvestGrokAuthFromWorkspace promotes when private auth is a regular file", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-live-harvest");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    fs.writeFileSync(realAuth, JSON.stringify({ t: { key: "OLD", create_time: "2026-01-01T00:00:00.000Z" } }));
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const home = mgr.materializeBridgeMcpGrok("solo", {
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    });
    const privateAuth = path.join(home, "auth.json");
    fs.unlinkSync(privateAuth);
    fs.writeFileSync(privateAuth, JSON.stringify({ t: { key: "LIVE", create_time: "2026-06-01T00:00:00.000Z" } }));
    // After materialize's harvest stamp, jump past the throttle window.
    const t0 = Date.now() + 60_000;
    const first = mgr.maybeHarvestGrokAuthFromWorkspace(t0);
    expect(first).not.toBeNull();
    expect(first!.promoted).toBe(true);
    expect(JSON.parse(fs.readFileSync(realAuth, "utf8")).t.key).toBe("LIVE");
    // Throttled second call within interval.
    const second = mgr.maybeHarvestGrokAuthFromWorkspace(t0 + 100);
    expect(second).toBeNull();
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
    // t-de73e0 — converged by VALUE: same credential in every home, no pointer at the shared file.
    expect(fs.lstatSync(authA).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(authB).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(authA, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));
    expect(fs.readFileSync(authB, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));
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
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(privateAuth, "utf8")).toBe('{"token":"PRIVATE_ONLY"}');
  });

  /**
   * t-de73e0 — the incident, encoded. A Grok that re-authenticates inside a redirected home writes
   * the credential it was given; with a symlink that write landed on the person's own file and the
   * real `~/.grok/auth.json` did not survive. This drives the three shapes that write can take and
   * asserts the shared credential is untouched by all of them.
   */
  it("t-de73e0: whatever the runtime does to the private credential cannot reach the real one", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-isolation");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    fs.writeFileSync(realAuth, '{"token":"HUMAN_CREDENTIAL"}');
    fs.chmodSync(realAuth, 0o600);
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp", headers: {} };

    const home = mgr.materializeBridgeMcpGrok("solo", bridge);
    const privateAuth = path.join(home, "auth.json");

    // 1. Rewrite in place — the shape that destroys through a symlink.
    fs.writeFileSync(privateAuth, '{"token":"RUNTIME_REWROTE_IT"}');
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"HUMAN_CREDENTIAL"}');

    // 2. Truncate to nothing — a cleared credential after a failed refresh.
    fs.truncateSync(privateAuth, 0);
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"HUMAN_CREDENTIAL"}');

    // 3. Unlink — what actually happened on the machine this was measured on.
    fs.unlinkSync(privateAuth);
    expect(fs.existsSync(realAuth)).toBe(true);
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"HUMAN_CREDENTIAL"}');

    // And the next launch re-seeds the agent from the surviving shared credential.
    mgr.materializeBridgeMcpGrok("solo", bridge);
    expect(fs.readFileSync(privateAuth, "utf8")).toBe('{"token":"HUMAN_CREDENTIAL"}');
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);
  });

  it("t-de73e0: a legacy symlinked private home is converted to a copy on the next launch", () => {
    const realGrokHome = path.join(path.dirname(ws), "real-grok-legacy-link");
    fs.mkdirSync(realGrokHome, { recursive: true });
    const realAuth = path.join(realGrokHome, "auth.json");
    fs.writeFileSync(realAuth, '{"token":"HUMAN_CREDENTIAL"}');
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"), undefined, undefined, undefined, realGrokHome);
    const bridge = { type: "http", url: "http://127.0.0.1:9/mcp", headers: {} };

    // A home seeded by an older build: auth.json is a pointer at the person's credential.
    const home = bridgeGrokHome(ws, "legacy");
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(realAuth, path.join(home, "auth.json"));

    mgr.materializeBridgeMcpGrok("legacy", bridge);

    const privateAuth = path.join(home, "auth.json");
    expect(fs.lstatSync(privateAuth).isSymbolicLink()).toBe(false);
    // Converting must not have written through the link it replaced.
    expect(fs.readFileSync(realAuth, "utf8")).toBe('{"token":"HUMAN_CREDENTIAL"}');
    expect(fs.readFileSync(privateAuth, "utf8")).toBe('{"token":"HUMAN_CREDENTIAL"}');
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

  it("Hermes inherit:none preserves provider settings but excludes ambient global MCP servers", () => {
    const realHermesHome = path.join(path.dirname(ws), "isolated-hermes");
    fs.mkdirSync(realHermesHome, { recursive: true });
    fs.writeFileSync(path.join(realHermesHome, "auth.json"), '{"tokens":{"access_token":"x"}}');
    fs.writeFileSync(
      path.join(realHermesHome, "config.yaml"),
      "model:\n  default: gpt-5.6-sol\nmcp_servers:\n  ambient_global:\n    command: leak\n",
    );
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
    const result = mgr.materialize(
      "isolated",
      { inherit: "none", mcp: { declared: { command: "declared-command" } } },
      adapterForRuntime("hermes")!,
      undefined,
      {
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
      },
    );
    const yaml = fs.readFileSync(path.join(result.home, "config.yaml"), "utf8");
    expect(yaml).toContain("gpt-5.6-sol");
    expect(yaml).toContain("declared-command");
    expect(yaml).toContain("tachyon_bridge");
    expect(yaml).not.toContain("ambient_global");
    expect(yaml).not.toContain("command: leak");
  });

  it("Hermes harness supports API-key auth without auth.json", () => {
    const realHermesHome = path.join(path.dirname(ws), "api-key-hermes-harness");
    fs.mkdirSync(realHermesHome, { recursive: true });
    fs.writeFileSync(path.join(realHermesHome, "config.yaml"), "model:\n  provider: openai\n");
    fs.writeFileSync(path.join(realHermesHome, ".env"), "OPENAI_API_KEY=test-only\n");
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
    const result = mgr.materialize("api-key", { inherit: "none" }, adapterForRuntime("hermes")!);
    expect(fs.existsSync(path.join(result.home, "auth.json"))).toBe(false);
    expect(fs.lstatSync(path.join(result.home, ".env")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(result.home, ".env"))).toBe(path.join(realHermesHome, ".env"));
  });

  it("materializeBridgeMcpHermes supports API-key auth when auth.json is missing", () => {
    const emptyHermes = path.join(path.dirname(ws), "empty-hermes");
    fs.mkdirSync(emptyHermes, { recursive: true });
    fs.writeFileSync(path.join(emptyHermes, "config.yaml"), "model:\n  provider: openai\n");
    fs.writeFileSync(path.join(emptyHermes, ".env"), "OPENAI_API_KEY=test-only\n");
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
    const home = mgr.materializeBridgeMcpHermes("solo", {
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
    });
    expect(fs.existsSync(path.join(home, "auth.json"))).toBe(false);
    expect(fs.lstatSync(path.join(home, ".env")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).toContain("tachyon_bridge");
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

  it("t-4e286c: materializeOwnershipSettings can seed Claude bypass-permissions startup consent for Temporary spawns", () => {
    const mgr = new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
    const normal = JSON.parse(fs.readFileSync(mgr.materializeOwnershipSettings("declared"), "utf8"));
    expect(normal.skipDangerousModePermissionPrompt).toBeUndefined();

    const temporary = JSON.parse(fs.readFileSync(mgr.materializeOwnershipSettings("adhoc", undefined, { skipDangerousModePermissionPrompt: true }), "utf8"));
    expect(temporary.skipDangerousModePermissionPrompt).toBe(true);
    expect(temporary.hooks.SessionStart[0].hooks[0].command).toContain("session-owner-record.cjs");
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

/**
 * t-9598cc — Claude private homes did not follow a global re-login.
 *
 * Claude Code writes `.credentials.json` by create+rename under `CLAUDE_CONFIG_DIR`, replacing
 * Tachyon's symlink with a regular file whenever it refreshes its OAuth token — the same mechanism
 * already measured for Grok (t-2b0a08 / t-6c8437). Claude had none of Grok's reconcile, so a home
 * that detached stayed detached: a later `/login` refreshed `~/.claude/.credentials.json` and the
 * private snapshot kept serving a dead token, surfacing only as `runtime_auth_rejected` at launch.
 *
 * Measured 2026-07-27: `.tachyon/harness/claude-opus5/.credentials.json` was a regular file whose
 * contents differed from the authority's, while sibling homes were still symlinks.
 */
describe("t-9598cc Claude credential projection and refresh", () => {
  const NOW = Date.parse("2026-07-27T12:30:00.000Z");
  const HOUR = 3_600_000;
  let ws: string;
  let realHome: string;
  const PROC = { FAL_KEY: "real-key" };

  /** The shape Claude actually writes: epoch-ms `expiresAt` / `refreshTokenExpiresAt`, camelCase. */
  function claudeCredential(opts: { token: string; accessInHours: number; refreshInHours?: number }): string {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: opts.token,
        refreshToken: `${opts.token}-refresh`,
        expiresAt: NOW + opts.accessInHours * HOUR,
        refreshTokenExpiresAt: NOW + (opts.refreshInHours ?? 24 * 30) * HOUR,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
  }

  function tokenOf(file: string): string {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth: { accessToken: string } };
    return parsed.claudeAiOauth.accessToken;
  }

  /** Detach a home the way the runtime does: replace the symlink with a regular file. */
  function detach(home: string, contents: string, mtime?: Date): string {
    const file = path.join(home, ".credentials.json");
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
  }

  function manager(): HarnessManager {
    return new HarnessManager(ws, realHome, PROC, path.join(realHome, ".claude.json"));
  }

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-claude-cred-"));
    ws = path.join(base, "ws");
    realHome = path.join(base, "realhome");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "AUTHORITY", accessInHours: 8 }));
    fs.writeFileSync(path.join(realHome, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: "acct-primary", emailAddress: "primary@example.test" },
    }));
  });
  afterEach(() => {
    fs.rmSync(path.dirname(ws), { recursive: true, force: true });
  });

  describe("credential ranking understands the Claude shape", () => {
    it("reads epoch-ms expiresAt, which used to parse as 'no expiry stated'", () => {
      const live = path.join(realHome, "live.json");
      const dead = path.join(realHome, "dead.json");
      fs.writeFileSync(live, claudeCredential({ token: "LIVE", accessInHours: 4 }));
      fs.writeFileSync(dead, claudeCredential({ token: "DEAD", accessInHours: -4 }));

      expect(authCredentialRank(live, NOW).accessValid).toBe(true);
      expect(authCredentialRank(dead, NOW).accessValid).toBe(false);
      expect(authCredentialRank(live, NOW).expiresAtMs).toBe(NOW + 4 * HOUR);
    });

    it("separates a lapsed access token from a dead session via the refresh window", () => {
      const refreshable = path.join(realHome, "refreshable.json");
      const expired = path.join(realHome, "expired.json");
      fs.writeFileSync(refreshable, claudeCredential({ token: "R", accessInHours: -1, refreshInHours: 240 }));
      fs.writeFileSync(expired, claudeCredential({ token: "E", accessInHours: -1, refreshInHours: -1 }));

      expect(authCredentialRank(refreshable, NOW)).toMatchObject({ accessValid: false, refreshValid: true });
      expect(authCredentialRank(expired, NOW)).toMatchObject({ accessValid: false, refreshValid: false });
    });

    it("prefers a live credential over an expired one that merely has a newer mtime", () => {
      const live = path.join(realHome, "live.json");
      const dead = path.join(realHome, "dead.json");
      fs.writeFileSync(live, claudeCredential({ token: "LIVE", accessInHours: 4 }));
      fs.writeFileSync(dead, claudeCredential({ token: "DEAD", accessInHours: -4 }));
      const older = new Date(NOW - 10 * HOUR);
      const newer = new Date(NOW - 1 * HOUR);
      fs.utimesSync(live, older, older);
      fs.utimesSync(dead, newer, newer);

      expect(authRankBetter(authCredentialRank(live, NOW), authCredentialRank(dead, NOW))).toBe(true);
      expect(authRankBetter(authCredentialRank(dead, NOW), authCredentialRank(live, NOW))).toBe(false);
    });

    it("leaves the Grok/Hermes ISO shape ranking exactly as before", () => {
      const grokish = path.join(realHome, "grok.json");
      fs.writeFileSync(grokish, JSON.stringify({
        "https://auth.x.ai::x": { key: "K", create_time: "2026-07-20T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" },
      }));
      const rank = authCredentialRank(grokish, NOW);

      expect(rank.accessValid).toBe(true);
      expect(rank.createTimeMs).toBe(Date.parse("2026-07-20T00:00:00.000Z"));
      // Grok states no refresh expiry — absence must not be read as "dead".
      expect(rank.refreshValid).toBe(true);
      expect(rank.refreshExpiresAtMs).toBe(0);
    });
  });

  describe("claudeCredentialState separates where-from from how-good", () => {
    it("reports a healthy projection as linked", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);

      expect(claudeCredentialState(res.home, path.join(realHome, ".credentials.json"), NOW))
        .toMatchObject({ projection: "linked", health: "valid" });
    });

    it("reports an in-session refresh as detached, not as an expired session", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);
      detach(res.home, claudeCredential({ token: "PRIVATE", accessInHours: 6 }));

      expect(claudeCredentialState(res.home, path.join(realHome, ".credentials.json"), NOW))
        .toMatchObject({ projection: "detached", health: "valid" });
    });

    it("reports a never-projected home as absent rather than guessing at the credential", () => {
      const home = harnessHome(ws, "never-run");
      fs.mkdirSync(home, { recursive: true });

      expect(claudeCredentialState(home, path.join(realHome, ".credentials.json"), NOW))
        .toMatchObject({ projection: "absent", health: "valid" });
    });

    it("reports a link to another authority as foreign", () => {
      const other = path.join(path.dirname(ws), "other-account");
      fs.mkdirSync(other, { recursive: true });
      const otherAuth = path.join(other, ".credentials.json");
      fs.writeFileSync(otherAuth, claudeCredential({ token: "OTHER", accessInHours: 5 }));
      const home = harnessHome(ws, "second-account");
      fs.mkdirSync(home, { recursive: true });
      fs.symlinkSync(otherAuth, path.join(home, ".credentials.json"));

      expect(claudeCredentialState(home, path.join(realHome, ".credentials.json"), NOW))
        .toMatchObject({ projection: "foreign", health: "valid" });
    });

    it.each([
      ["refreshable", { accessInHours: -1, refreshInHours: 240 }, "refreshable"],
      ["expired", { accessInHours: -1, refreshInHours: -1 }, "expired"],
    ] as const)("grades a %s detached credential", (_label, windows, health) => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);
      detach(res.home, claudeCredential({ token: "P", ...windows }));

      expect(claudeCredentialState(res.home, path.join(realHome, ".credentials.json"), NOW).health).toBe(health);
    });

    it("grades an unparseable credential as unreadable, not as expired", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);
      detach(res.home, "{ truncated");

      expect(claudeCredentialState(res.home, path.join(realHome, ".credentials.json"), NOW).health).toBe("unreadable");
    });
  });

  describe("workspace reconcile", () => {
    it("THE MEASURED BUG: a stale private snapshot does not survive a newer global login", () => {
      const mgr = manager();
      const stale = mgr.materialize("claude-opus5", DEF("none"), claude);
      // The agent refreshed in-session at 12:15, detaching from the authority.
      detach(stale.home, claudeCredential({ token: "STALE_12_15", accessInHours: -1, refreshInHours: -1 }),
        new Date(Date.parse("2026-07-27T12:15:00.000Z")));
      // The human then logged in globally at 12:28. Nothing re-materialized this agent.
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "GLOBAL_12_28", accessInHours: 8 }));

      const result = reconcileWorkspaceClaudeAuth(ws, realHome, path.join(realHome, ".claude.json"), NOW);

      expect(result.promoted).toBe(false); // the dead private token must NOT be promoted over the fresh login
      expect(result.relinked).toBe(1);
      const link = path.join(stale.home, ".credentials.json");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(tokenOf(link)).toBe("GLOBAL_12_28");
      expect(tokenOf(path.join(realHome, ".credentials.json"))).toBe("GLOBAL_12_28");
    });

    it("harvests a fresher in-session refresh instead of destroying it", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "AUTHORITY_DEAD", accessInHours: -2, refreshInHours: -2 }));
      detach(res.home, claudeCredential({ token: "PRIVATE_LIVE", accessInHours: 6 }));

      const result = reconcileWorkspaceClaudeAuth(ws, realHome, path.join(realHome, ".claude.json"), NOW);

      expect(result.promoted).toBe(true);
      expect(tokenOf(path.join(realHome, ".credentials.json"))).toBe("PRIVATE_LIVE");
      expect(fs.lstatSync(path.join(res.home, ".credentials.json")).isSymbolicLink()).toBe(true);
    });

    it("converges every simultaneous Claude agent onto one live credential", () => {
      const mgr = manager();
      const homes = ["alpha", "beta", "gamma"].map((name) => mgr.materialize(name, DEF("none"), claude).home);
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "AUTHORITY_DEAD", accessInHours: -2, refreshInHours: -2 }));
      // Only beta refreshed; alpha and gamma still point at the now-dead authority.
      detach(homes[1], claudeCredential({ token: "BETA_LIVE", accessInHours: 6 }));

      const result = reconcileWorkspaceClaudeAuth(ws, realHome, path.join(realHome, ".claude.json"), NOW);

      expect(result.promoted).toBe(true);
      expect(result.relinked).toBe(3);
      for (const home of homes) {
        const link = path.join(home, ".credentials.json");
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(tokenOf(link)).toBe("BETA_LIVE");
      }
    });

    it("never merges a named second account into the primary authority", () => {
      const mgr = manager();
      const primary = mgr.materialize("alpha", DEF("none"), claude);
      const secondary = harnessHome(ws, "second-account");
      fs.mkdirSync(secondary, { recursive: true });
      fs.writeFileSync(path.join(secondary, ".claude.json"), JSON.stringify({
        oauthAccount: { accountUuid: "acct-secondary", emailAddress: "other@example.test" },
      }));
      // Its own live credential, newer than the primary authority's.
      fs.writeFileSync(path.join(secondary, ".credentials.json"), claudeCredential({ token: "SECOND_ACCOUNT", accessInHours: 12 }));

      const result = reconcileWorkspaceClaudeAuth(ws, realHome, path.join(realHome, ".claude.json"), NOW);

      expect(result.skipped).toEqual([secondary]);
      expect(tokenOf(path.join(realHome, ".credentials.json"))).toBe("AUTHORITY");
      // The second account keeps its own regular file — never relinked onto the primary.
      expect(fs.lstatSync(path.join(secondary, ".credentials.json")).isSymbolicLink()).toBe(false);
      expect(tokenOf(path.join(secondary, ".credentials.json"))).toBe("SECOND_ACCOUNT");
      // The primary agent is still converged.
      expect(fs.lstatSync(path.join(primary.home, ".credentials.json")).isSymbolicLink()).toBe(true);
    });

    it("leaves a home linked to another authority alone", () => {
      const other = path.join(path.dirname(ws), "other-authority");
      fs.mkdirSync(other, { recursive: true });
      const otherAuth = path.join(other, ".credentials.json");
      fs.writeFileSync(otherAuth, claudeCredential({ token: "OTHER", accessInHours: 5 }));
      const home = harnessHome(ws, "linked-elsewhere");
      fs.mkdirSync(home, { recursive: true });
      fs.symlinkSync(otherAuth, path.join(home, ".credentials.json"));

      const result = reconcileWorkspaceClaudeAuth(ws, realHome, path.join(realHome, ".claude.json"), NOW);

      expect(result.skipped).toEqual([home]);
      expect(fs.readlinkSync(path.join(home, ".credentials.json"))).toBe(otherAuth);
    });

    it("does not sweep in a non-Claude agent home sharing the harness root", () => {
      const mgr = manager();
      mgr.materialize("alpha", DEF("none"), claude);
      const codexHome = harnessHome(ws, "codex-agent");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(path.join(codexHome, "config.toml"), "model = 'x'\n");

      expect(listWorkspaceClaudePrivateHomes(ws)).toEqual([harnessHome(ws, "alpha")]);
    });
  });

  describe("materialize converges and fails closed", () => {
    it("materializing one agent repairs another agent's detached stale home", () => {
      const mgr = manager();
      const stale = mgr.materialize("alpha", DEF("none"), claude);
      detach(stale.home, claudeCredential({ token: "ALPHA_OLD", accessInHours: -3, refreshInHours: -3 }),
        new Date(NOW - 3 * HOUR));
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "AFTER_LOGIN", accessInHours: 8 }));

      mgr.materialize("beta", DEF("none"), claude);

      const link = path.join(stale.home, ".credentials.json");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(tokenOf(link)).toBe("AFTER_LOGIN");
    });

    it("materialize no longer overwrites a fresher private credential with a staler authority one", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "AUTHORITY_DEAD", accessInHours: -2, refreshInHours: -2 }));
      detach(res.home, claudeCredential({ token: "PRIVATE_LIVE", accessInHours: 6 }));

      mgr.materialize("alpha", DEF("none"), claude);

      expect(tokenOf(path.join(realHome, ".credentials.json"))).toBe("PRIVATE_LIVE");
      expect(tokenOf(path.join(res.home, ".credentials.json"))).toBe("PRIVATE_LIVE");
    });

    it("refuses at the harness boundary when the session is genuinely dead, naming the recovery", () => {
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "DEAD", accessInHours: -5, refreshInHours: -5 }));
      const mgr = manager();

      expect(() => mgr.materialize("alpha", DEF("none"), claude)).toThrow(HarnessUnavailableError);
      expect(() => mgr.materialize("alpha", DEF("none"), claude)).toThrow(/expired.*claude \/login/s);
    });

    it("does not refuse a merely-lapsed access token the runtime will renew itself", () => {
      fs.writeFileSync(path.join(realHome, ".credentials.json"), claudeCredential({ token: "LAPSED", accessInHours: -1, refreshInHours: 240 }));
      const mgr = manager();

      expect(() => mgr.materialize("alpha", DEF("none"), claude)).not.toThrow();
    });

    it("names the missing projection instead of reporting an expired session", () => {
      fs.rmSync(path.join(realHome, ".credentials.json"));
      const mgr = manager();

      expect(() => mgr.materialize("alpha", DEF("none"), claude)).toThrow(/no credentials at .*claude \/login/s);
    });
  });

  describe("in-session reconcile tick", () => {
    it("stays quiet while every home is converged and fires once one detaches", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);

      expect(privateClaudeAuthNeedsReconcile(ws, realHome, NOW)).toBe(false);
      detach(res.home, claudeCredential({ token: "REFRESHED", accessInHours: 6 }));
      expect(privateClaudeAuthNeedsReconcile(ws, realHome, NOW)).toBe(true);
    });

    it("throttles repeated ticks", () => {
      const mgr = manager();
      const res = mgr.materialize("alpha", DEF("none"), claude);
      detach(res.home, claudeCredential({ token: "REFRESHED", accessInHours: 6 }));

      const first = mgr.maybeReconcileClaudeAuthFromWorkspace(NOW + 60_000);
      expect(first).not.toBeNull();
      expect(first!.relinked).toBe(1);
      expect(mgr.maybeReconcileClaudeAuthFromWorkspace(NOW + 60_100)).toBeNull();
    });
  });
});
