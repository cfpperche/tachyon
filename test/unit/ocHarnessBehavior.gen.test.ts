import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { HarnessManager, harnessHome, opencodeHarnessDirs } from "../../src/harness/HarnessManager.js";
import { expectedAgentOpencodeEntry, expectedAgentClaudeEntry } from "../../src/registration/adapters.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";

/** spec t-e2ebe3 — behavior: a Tachyon-spawned opencode HARNESS agent gets per-agent XDG config/data/state
 *  dirs (an isolation layer independent of cwd, mirroring CLAUDE_CONFIG_DIR/CODEX_HOME parity) AND seeded
 *  auth (auth.json copied mode-600 from the real XDG_DATA_HOME so the agent runs the SIGNED model — an
 *  empty XDG_DATA_HOME is the measured FOOTGUN: opencode silently degrades to a fallback model, no error).
 *  The Bridge MCP entry lives in the auto-discovered `<XDG_CONFIG_HOME>/opencode/opencode.json` (no
 *  OPENCODE_CONFIG env needed for a harness agent). The gated-only delegation restriction is REMOVED —
 *  opencode's runtime profile upgrades from project-scoped to private-home.
 */
describe("container-generated delegation behavior", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Capture every new-session invocation's argv (env -e pairs and the spawned cmd ride inside). */
  function fakeCapture() {
    const newSessionArgs: string[][] = [];
    const newSessionEnvs: Record<string, string>[] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        newSessionArgs.push(args);
        // capture env pairs (each `-e KEY=VAL` flag) so the test can assert XDG_*_HOME values per spawn
        const env: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-e" && i + 1 < args.length) {
            const pair = args[i + 1];
            const eq = pair.indexOf("=");
            if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
        }
        newSessionEnvs.push(env);
        return { stdout: "", stderr: "" };
      }
      switch (args[2]) {
        case "has-session":
          throw new Error("can't find session");
        case "list-sessions":
          throw new Error("no server running");
        case "list-panes":
          if (newSessionArgs.length === 0) throw new Error("no server running");
          return { stdout: newSessionArgs.map((a) => `${a[a.indexOf("-s") + 1]}\t0\t`).join("\n") + "\n", stderr: "" };
        default:
          return { stdout: "", stderr: "" };
      }
    };
    return { newSessionArgs, newSessionEnvs, tmux: new TmuxService(exec) };
  }

  it("an opencode agent spawns with per-agent XDG config/data/state dirs and seeded auth", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ocx-"));
    dirs.push(base);
    const ws = path.join(base, "ws");
    const realXdgData = path.join(base, "realshare"); // simulates the real XDG_DATA_HOME (~/.local/share)
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.join(realXdgData, "opencode"), { recursive: true });
    // the real auth.json (a real secret — mode 600 at the source; the seed is a COPY, never a symlink)
    const realAuth = path.join(realXdgData, "opencode", "auth.json");
    fs.writeFileSync(realAuth, JSON.stringify({ token: "REAL-OPENCODE-TOKEN" }));
    fs.chmodSync(realAuth, 0o600);

    const BRIDGE_URL = "http://127.0.0.1:9/mcp";
    const opencode = adapterForRuntime("opencode")!;
    const harness = new HarnessManager(ws, ws, process.env, undefined, undefined, undefined, realXdgData);
    // spec t-e2ebe3 — note: Workspace passes the SHARED (claude-shaped) bridgeEntry to materialize for all
    // runtimes; HarnessManager normalizes to opencode's `type:remote` shape internally. Cover BOTH paths:
    // the test passes the opencode-shape (the production-ideal) and the normalization is exercised in a
    // second assertion below.
    const opencodeEntry = expectedAgentOpencodeEntry(BRIDGE_URL, /* auth */ true);

    const { newSessionArgs, newSessionEnvs, tmux } = fakeCapture();
    const { config } = parseConfig("agents:\n  oc:\n    cmd: opencode\n    harness: {}\n");
    const manager = new AgentManager({
      tmux,
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => config,
      getMaxAgents: () => 8,
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: BRIDGE_URL, TACHYON_BRIDGE_TOKEN: "tok" }),
      mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: `agent-token-${name}` }),
      // Real materializeHarness wiring (matches Workspace's path): HarnessManager.materialize with the
      // shared (claude-shaped) bridgeEntry — HarnessManager normalizes it to opencode-shape internally.
      materializeHarness: ({ name, def, cwd }) => {
        if (!def.harness) return null;
        const sharedClaudeEntry = expectedAgentClaudeEntry(BRIDGE_URL, true); // simulates Workspace's bridgeEntry()
        return harness.materialize(name, def.harness, opencode, cwd, sharedClaudeEntry);
      },
    });

    await manager.spawn("oc"); // use the config's declared def (carries `harness:`) — NOT an ad-hoc opts.cmd override, which would shadow it

    expect(newSessionArgs).toHaveLength(1);
    expect(newSessionEnvs).toHaveLength(1);
    const env = newSessionEnvs[0];

    // 1. Per-agent XDG dirs injected at the spawn env. home stays `.tachyon/harness/<agent>`; the three
    //    XDG vars point at its `config/data/state` subdirs.
    const home = harnessHome(ws, "oc");
    const xdgDirs = opencodeHarnessDirs(home);
    expect(env.XDG_CONFIG_HOME).toBe(xdgDirs.config);
    expect(env.XDG_DATA_HOME).toBe(xdgDirs.data);
    expect(env.XDG_STATE_HOME).toBe(xdgDirs.state);
    expect(env.XDG_CONFIG_HOME).not.toBe(env.XDG_DATA_HOME); // distinct dirs (NOT a single root)
    expect(env.XDG_DATA_HOME).not.toBe(env.XDG_STATE_HOME);

    // 2. NO OPENCODE_CONFIG env for a harness agent — opencode auto-discovers <XDG_CONFIG_HOME>/opencode/opencode.json.
    expect(env.OPENCODE_CONFIG).toBeUndefined();

    // 3. The per-agent token also lands in the spawn env (the {env:} ref in opencode.json resolves from it).
    expect(env.TACHYON_AGENT_BRIDGE_TOKEN).toBe("agent-token-oc");

    // 4. auth.json is SEEDED under <XDG_DATA_HOME>/opencode/auth.json — mode 600, COPY (NOT a symlink),
    //    content matches the real source. This is the FOOTGUN guard: empty XDG_DATA_HOME → silent
    //    wrong-model degrade, so a missing seed is a hard fault, not a soft warn.
    const seededAuth = path.join(env.XDG_DATA_HOME!, "opencode", "auth.json");
    expect(fs.existsSync(seededAuth)).toBe(true);
    expect(fs.lstatSync(seededAuth).isSymbolicLink()).toBe(false); // COPY, not symlink
    expect(fs.readFileSync(seededAuth, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));
    // mode 600 — never group/world readable (the secret is a real auth.json, not a ${VAR} ref)
    expect(fs.statSync(seededAuth).mode & 0o777).toBe(0o600);

    // 5. The Bridge MCP config is auto-discoverable under XDG_CONFIG_HOME/opencode/opencode.json (NO
    //    OPENCODE_CONFIG pointing at it — that's the whole point of the XDG harness). It carries the
    //    opencode-shape `mcp.tachyon_bridge` entry with the per-agent-token {env:} ref + the exact URL,
    //    and NO literal token on disk.
    const cfgPath = path.join(env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      $schema?: string;
      mcp?: Record<string, { type?: string; url?: string; enabled?: boolean; headers?: { Authorization?: string } }>;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    const bridge = parsed.mcp?.tachyon_bridge;
    expect(bridge).toBeDefined();
    expect(bridge!.type).toBe("remote");
    expect(bridge!.url).toBe(BRIDGE_URL);
    expect(bridge!.enabled).toBe(true);
    expect(bridge!.headers?.Authorization).toBe("Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}");
    expect(JSON.stringify(parsed)).not.toMatch(/Bearer [0-9a-f]{8}/); // no literal token on disk

    // 6. harness base dir is git-excluded — `.tachyon/` is gitignored (verified per repo .gitignore), so
    //    the secret at `<home>/data/opencode/auth.json` cannot accidentally be committed. Sanity check
    //    that the seeded auth lives under the workspace's `.tachyon/harness/` tree (NOT a sibling the
    //    user might track). If this ever fires, STOP: a tracking-excluded harness layout is a hard
    //    security precondition for the copy-seed (the claude/codex symlink types avoid this by routing
    //    through `~`, but opencode's COPY writes the secret into the harness tree).
    expect(seededAuth.startsWith(path.join(ws, ".tachyon", "harness"))).toBe(true);

    // 7. rematerialize is idempotent + refresh-seed-safe: re-materialize replaces the seed (no stale link,
    //    no double-write race) and the seeded content still matches the real source.
    await manager.restart("oc", { stop: "force", session: "new" });
    expect(newSessionEnvs.length).toBe(2);
    const env2 = newSessionEnvs[1];
    expect(env2.XDG_CONFIG_HOME).toBe(xdgDirs.config);
    expect(env2.XDG_DATA_HOME).toBe(xdgDirs.data);
    const seededAuth2 = path.join(env2.XDG_DATA_HOME!, "opencode", "auth.json");
    expect(fs.existsSync(seededAuth2)).toBe(true);
    expect(fs.statSync(seededAuth2).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(seededAuth2, "utf8")).toBe(fs.readFileSync(realAuth, "utf8"));

    // 8. fail-closed FOOTGUN guard: a FRESH real XDG_DATA_HOME with no auth → materialize THROWS (does
    //    NOT silently spawn an unauthenticated agent that runs the wrong model). Per the task recipe:
    //    "missing-auth must be a hard fault" — verified by pointing the manager at an empty source.
    const emptyShare = path.join(base, "emptyshare"); // does NOT contain opencode/auth.json
    const emptyHarness = new HarnessManager(ws, ws, process.env, undefined, undefined, undefined, emptyShare);
    expect(() => emptyHarness.materialize("never-seeded", { inherit: "workspace" }, opencode, ws, opencodeEntry)).toThrow(/auth login/);
    // the throw halts BEFORE the seed: the half-built XDG dirs may exist but no auth was written
    expect(fs.existsSync(path.join(harnessHome(ws, "never-seeded"), "data", "opencode", "auth.json"))).toBe(false);
  });
});