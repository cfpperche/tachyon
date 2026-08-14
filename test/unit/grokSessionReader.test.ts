import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GROK_NATIVE_CONFIG_FAMILY_KEYS } from "@tachyon/engine/config/grokNativeConfigProjection.js";
import { grokSessionReader } from "@tachyon/engine/runtimeOps/grokSessionReader.js";

/**
 * t-a5d827 — the Grok reader, driven by the files and argv a real session actually has.
 *
 * Fixtures are shortened from live sessions measured on 2026-08-02:
 * - Temporary/delegated: Bridge-only config.toml, hooks/session-start.json, argv carries
 *   `--always-approve` + `--no-memory` + `-s <uuid>`, HOME is NOT co-bound.
 * - Canonical: full projection + isolation pins + auth copy, HOME co-bound to GROK_HOME.
 */
describe("t-a5d827 — reading what a Grok session was given", () => {
  const dirs: string[] = [];
  const originalHome = process.env.HOME;
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  function homes(kind: "canonical" | "temporary" = "canonical"): {
    workspace: string;
    grokHome: string;
    realHome: string;
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-inspect-"));
    dirs.push(root);
    const workspace = path.join(root, "ws");
    const realHome = path.join(root, "home");
    const grokHome = path.join(workspace, ".tachyon", "bridge-mcp", "grok.grok");
    fs.mkdirSync(grokHome, { recursive: true });
    fs.mkdirSync(path.join(realHome, ".grok"), { recursive: true });
    fs.mkdirSync(path.join(grokHome, "hooks"), { recursive: true });

    // Private auth is a regular file (t-de73e0). Never a symlink — the test asserts that by content
    // presence only; the reader must not open the bytes into a projection.
    fs.writeFileSync(path.join(grokHome, "auth.json"), '{"access_token":"REAL-SECRET-DO-NOT-SURFACE"}');

    if (kind === "canonical") {
      fs.writeFileSync(path.join(grokHome, "config.toml"), [
        "[ui]",
        'permission_mode = "ask"',
        "yolo = false",
        "compact_mode = false",
        "",
        "[models]",
        'default = "grok-4.5"',
        'default_reasoning_effort = "high"',
        "",
        "[memory]",
        "enabled = false",
        "",
        "[compat.cursor]",
        "skills = false",
        "rules = false",
        "agents = false",
        "mcps = false",
        "hooks = false",
        "sessions = false",
        "",
        "[compat.claude]",
        "skills = false",
        "rules = false",
        "agents = false",
        "mcps = false",
        "hooks = false",
        "sessions = false",
        "",
        "[compat.codex]",
        "sessions = false",
        "",
        "[mcp_servers.tachyon_bridge]",
        'url = "http://127.0.0.1:9/mcp"',
        'headers = { "Authorization" = "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" }',
        "",
        // Runtime-owned noise — must NOT appear as Tachyon injection.
        "[marketplace]",
        "official_marketplace_auto_installed = true",
      ].join("\n"));

      fs.writeFileSync(path.join(grokHome, "hooks", "session-start.json"), JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: "startup|resume|clear|compact",
            hooks: [
              { type: "command", command: "node '/ws/.tachyon/activity/session-owner-record.cjs' 'grok'" },
              { type: "command", command: "node '/ws/.tachyon/activity/handoff-pointer.cjs' '/ws/.tachyon/HANDOFF.md'" },
            ],
          }],
        },
      }));
      fs.writeFileSync(path.join(grokHome, "hooks", "projected.json"), JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: "node '/ws/.tachyon/plugins/secrets-guard/gate.cjs'" }],
          }],
        },
      }));
    } else {
      // Temporary: Bridge-only config, ownership hook only, no isolation block in the file.
      fs.writeFileSync(path.join(grokHome, "config.toml"), [
        "[mcp_servers.tachyon_bridge]",
        'url = "http://127.0.0.1:9/mcp"',
        'headers = { "Authorization" = "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" }',
      ].join("\n"));
      fs.writeFileSync(path.join(grokHome, "hooks", "session-start.json"), JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: "startup|resume|clear|compact",
            hooks: [
              { type: "command", command: "node '/ws/.tachyon/activity/session-owner-record.cjs' 'grok'" },
            ],
          }],
        },
      }));
    }

    // Person's global: always-approve + a key the projector never carries.
    fs.writeFileSync(path.join(realHome, ".grok", "config.toml"), [
      "[ui]",
      'permission_mode = "always-approve"',
      "yolo = false",
      "compact_mode = false",
      "",
      "[models]",
      'default = "grok-4.5"',
      "",
      "[cli]",
      'installer = "internal"',
    ].join("\n"));

    process.env.HOME = realHome;
    return { workspace, grokHome, realHome };
  }

  function read(
    kind: "canonical" | "temporary" = "canonical",
    overrides: {
      env?: Record<string, string>;
      argv?: string[] | undefined;
      coBound?: boolean;
    } = {},
  ) {
    const { workspace, grokHome, realHome } = homes(kind);
    const coBound = overrides.coBound ?? kind === "canonical";
    return grokSessionReader.read({
      workspaceRoot: workspace,
      agent: "grok",
      env: overrides.env ?? {
        GROK_HOME: grokHome,
        HOME: coBound ? grokHome : realHome,
        GROK_MEMORY: "0",
        TACHYON_AGENT_NAME: "grok",
        TACHYON_BRIDGE_TOKEN: "fake-token-for-tests-0000000000000000",
      },
      argv: "argv" in overrides
        ? overrides.argv
        : kind === "temporary"
          ? [
            "grok", "-s", "a8f52d0c-a921-4b70-b346-d4ca7077a991",
            "--always-approve",
            "── TACHYON PRIMER ──\n" + "x".repeat(500) + "\n── END ──",
            "--no-memory",
          ]
          : ["grok", "--no-memory"],
    });
  }

  it("finds lifecycle hooks in $GROK_HOME/hooks, where Grok actually keeps them", () => {
    // Corrected by measurement: unlike Codex, Grok's hooks are files and survive without a process.
    const hooks = read("canonical").hooks;

    expect(hooks.map((hook) => hook.event).sort()).toEqual(["PreToolUse", "SessionStart", "SessionStart"]);
    expect(hooks.some((hook) => hook.purpose === "records which agent owns this session")).toBe(true);
    expect(hooks.some((hook) => hook.command.includes("handoff-pointer"))).toBe(true);
    expect(hooks.some((hook) => hook.command.includes("secrets-guard"))).toBe(true);
  });

  it("still reads hooks with no live process (last-known)", () => {
    const found = read("canonical", { argv: undefined });

    expect(found.hooks.length).toBeGreaterThan(0);
    expect(found.hooks.some((hook) => hook.event === "SessionStart")).toBe(true);
  });

  it("surfaces deliberate OFF pins: memory.enabled=false and every compat.* cell", () => {
    const keys = read("canonical").settings.map((setting) => setting.key);

    expect(keys).toContain("memory.enabled");
    expect(keys).toContain("compat.claude.skills");
    expect(keys).toContain("compat.codex.sessions");
    const memory = read("canonical").settings.find((setting) => setting.key === "memory.enabled");
    expect(memory?.value).toBe(false);
    expect(memory?.hostAuthored).toBe(true);
  });

  it("attributes projected scalars, agent-owned models, and host isolation separately", () => {
    const settings = read("canonical").settings;
    const byKey = (key: string) => settings.find((setting) => setting.key === key);

    expect(byKey("ui.permission_mode")?.hostAuthored).toBe(false);
    expect(byKey("models.default")?.hostAuthored).toBe(false);
    expect(byKey("memory.enabled")?.hostAuthored).toBe(true);
    expect(byKey("mcp_servers.tachyon_bridge.url")?.hostAuthored).toBe(true);
  });

  it("describes auth as a private reconciled copy and never returns the credential bytes", () => {
    const found = read("canonical");
    const auth = found.settings.find((setting) => setting.key === "auth.json");

    expect(auth?.value).toMatch(/private reconciled copy \(present\)/);
    expect(JSON.stringify(found)).not.toContain("REAL-SECRET-DO-NOT-SURFACE");
    expect(JSON.stringify(found)).not.toContain("access_token");
  });

  it("drops runtime-owned marketplace noise so it cannot masquerade as Tachyon injection", () => {
    const keys = read("canonical").settings.map((setting) => setting.key);

    expect(keys.some((key) => key.startsWith("marketplace."))).toBe(false);
  });

  it("reports the global keys that never reach the agent", () => {
    // [cli] is not projectable; models.default is agent-owned and may appear in private config.
    expect(read("canonical").globalKeys).toContain("cli.installer");
  });

  it("names that the workspace source is refused, with the measured reason", () => {
    expect(read("canonical").notExposed.join(" ")).toMatch(/project \.grok\/config\.toml is refused/);
  });

  it("states HOME co-bind when the two homes match, and the opposite when they do not", () => {
    const coBound = read("canonical", { coBound: true }).notExposed.join(" ");
    expect(coBound).toMatch(/HOME is co-bound/);

    const open = read("temporary", { coBound: false }).notExposed.join(" ");
    expect(open).toMatch(/HOME is NOT co-bound/);
  });

  it("surfaces argv --always-approve for a delegated child that has no config posture", () => {
    // Measured on inspetorgrok itself: Temporary home is Bridge-only, the flag is the delivery.
    const found = read("temporary");
    const flag = found.settings.find((setting) => setting.key === "argv.--always-approve");

    expect(flag?.value).toMatch(/delegated-child class policy/);
    expect(found.settings.find((setting) => setting.key === "argv.--no-memory")).toBeTruthy();
  });

  it("names a global always-approve that did not reach the session as a refusal, not silence", () => {
    // Canonical fixture projects permission_mode=ask while global is always-approve, and argv has
    // no --always-approve — the gap is the authorization/exclusion refusal.
    const found = read("canonical", { argv: ["grok", "--no-memory"] });

    expect(found.notExposed.join(" ")).toMatch(/always-approve/);
    expect(found.notExposed.join(" ")).toMatch(/did not authorize|excluded/);
  });

  it("collects MCP servers from the private config.toml", () => {
    expect(read("canonical").mcpServers).toEqual(["tachyon_bridge"]);
  });

  it("survives a session with no config file at all", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-bare-"));
    dirs.push(empty);
    const home = path.join(empty, ".tachyon", "bridge-mcp", "ghost.grok");
    fs.mkdirSync(home, { recursive: true });

    const found = grokSessionReader.read({
      workspaceRoot: empty,
      agent: "ghost",
      env: { GROK_HOME: home, HOME: empty },
      argv: ["grok"],
    });

    expect(found.settings.filter((setting) => setting.key !== "auth.json")).toEqual([]);
    expect(found.hooks).toEqual([]);
  });
});

/**
 * t-a5d827 — the reader imports the projector's family allowlist rather than copying it.
 * Importing the constant is the drift-proof form; this fails if someone reintroduces a local list.
 */
describe("t-a5d827 — the Grok projectable-key list matches the projector", () => {
  it("lists exactly what grokNativeConfigProjection projects", () => {
    const projected = [
      ...GROK_NATIVE_CONFIG_FAMILY_KEYS.permissions,
      ...GROK_NATIVE_CONFIG_FAMILY_KEYS.interface,
      ...GROK_NATIVE_CONFIG_FAMILY_KEYS.featureFlags,
    ].sort();

    expect([...grokSessionReader.config.projectableKeys].sort()).toEqual(projected);

    // And the source file must not re-list the keys as string literals next to projectableKeys —
    // a second list is the defect this import exists to prevent.
    const source = fs.readFileSync(path.join(process.cwd(), "packages/engine/src/runtimeOps/grokSessionReader.ts"), "utf8");
    expect(source).toContain("GROK_NATIVE_CONFIG_FAMILY_KEYS");
  });
});
