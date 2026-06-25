import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadPlugin,
  loadPluginFromSource,
  detectRuntimes,
  atomicWrite,
  previewInstall,
  applyInstall,
  previewRemove,
  applyRemove,
  previewUpdate,
  applyUpdate,
  planSkillTargets,
  runtimeSupportsSkills,
  planMcpTargets,
  runtimeSupportsMcp,
} from "../../src/plugins/engine.js";
import { PLUGIN_ROOT_PLACEHOLDER, renderClaudeMcpEntry } from "../../src/plugins/adapters/claude.js";
import { renderCodexMcpBlock } from "../../src/plugins/adapters/codex.js";
import { loadMcpPayload, type McpServer } from "../../src/plugins/mcp.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Build a plugin fixture dir. Ships a native hooks block + a script for each declared runtime. */
function makePlugin(opts: { name?: string; runtimes?: string[]; command?: string; version?: string } = {}): string {
  const name = opts.name ?? "sdd";
  const runtimes = opts.runtimes ?? ["claude"];
  const dir = tmp("tachyon-plugin-");
  fs.writeFileSync(
    path.join(dir, "tachyon-plugin.json"),
    JSON.stringify({
      name,
      version: opts.version ?? "1.0.0",
      description: "test plugin",
      runtimes,
      blocks: Object.fromEntries(runtimes.map((r) => [r, `${r}/`])),
    }),
  );
  for (const rt of runtimes) {
    fs.mkdirSync(path.join(dir, rt), { recursive: true });
    const cmd: Record<string, unknown> = { type: "command", command: opts.command ?? `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` };
    if (rt === "codex") cmd.statusMessage = "running gate"; // codex-only field, exercises the codex adapter
    fs.writeFileSync(path.join(dir, rt, "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: rt === "codex" ? "^Bash$" : "Bash", hooks: [cmd] }] }));
    fs.writeFileSync(path.join(dir, rt, "gate.sh"), "#!/bin/sh\necho hi\n");
  }
  return dir;
}

/** A workspace with the given runtimes present (their config dirs). Defaults to claude. */
function makeWorkspace(runtimes: string[] = ["claude"]): string {
  const ws = tmp("tachyon-ws-");
  for (const rt of runtimes) fs.mkdirSync(path.join(ws, `.${rt}`), { recursive: true });
  return ws;
}

/** Add a skill dir (`skills/<name>/SKILL.md`) to a plugin fixture. `nameInFm` overrides the frontmatter name. */
function addSkill(pluginDir: string, name: string, opts: { description?: string; nameInFm?: string; noSkillMd?: boolean } = {}): void {
  const sdir = path.join(pluginDir, "skills", name);
  fs.mkdirSync(sdir, { recursive: true });
  if (opts.noSkillMd) return;
  fs.writeFileSync(path.join(sdir, "SKILL.md"), `---\nname: ${opts.nameInFm ?? name}\ndescription: ${opts.description ?? `the ${name} skill`}\n---\n# ${name}\n`);
}

/** A skills-only plugin: declares runtimes but ships NO hooks blocks, only a skills/ payload. */
function makeSkillsOnlyPlugin(name = "skilled", runtimes = ["claude", "codex"]): string {
  const dir = tmp("tachyon-plugin-");
  fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "skills only", runtimes }));
  return dir;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const RESOLVED = `"${".tachyon/plugins/sdd/claude"}"/gate.sh`;
const SETTINGS = (ws: string) => path.join(ws, ".claude", "settings.json");
const LOCK = (ws: string) => path.join(ws, ".tachyon/plugins.lock.json");
const install = (pluginDir: string, ws: string) => {
  const { plugin } = loadPlugin(pluginDir);
  // mcpConfirmed:true — the test helper stands in for the drawer's MCP acknowledgement (OQ5 engine gate).
  return applyInstall(plugin!, previewInstall(plugin!, ws, detectRuntimes(ws)), ws, detectRuntimes(ws), { mcpConfirmed: true });
};

describe("loadPlugin — skills discovery (spec 251)", () => {
  it("discovers skills from the neutral skills/ payload, sorted by name, alongside hooks", () => {
    const dir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(dir, "zebra", { description: "z skill" });
    addSkill(dir, "alpha", { description: "a skill" });
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(plugin!.skills.map((s) => s.name)).toEqual(["alpha", "zebra"]); // sorted, deterministic
    expect(plugin!.skills[0]).toEqual({ name: "alpha", description: "a skill", dirRel: "skills/alpha" });
    expect(Object.keys(plugin!.blocks)).toEqual(["claude", "codex"]); // hooks still loaded too
  });

  it("loads a SKILLS-ONLY plugin (no hooks blocks)", () => {
    const dir = makeSkillsOnlyPlugin("skilled", ["claude", "codex"]);
    addSkill(dir, "skilled-thing");
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(Object.keys(plugin!.blocks)).toEqual([]); // no hooks
    expect(plugin!.skills.map((s) => s.name)).toEqual(["skilled-thing"]);
  });

  it("rejects a plugin with NO capability (no hooks, no skills)", () => {
    const dir = makeSkillsOnlyPlugin("empty");
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /at least one capability/.test(e))).toBe(true);
  });

  it("rejects a skill whose dir name ≠ its SKILL.md frontmatter name", () => {
    const dir = makeSkillsOnlyPlugin();
    addSkill(dir, "deploy", { nameInFm: "deployer" });
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /must equal its directory name/.test(e))).toBe(true);
  });

  it("ignores a subdir under skills/ that has no SKILL.md", () => {
    const dir = makePlugin(); // has a claude hooks block (a capability)
    addSkill(dir, "real-skill");
    addSkill(dir, "not-a-skill", { noSkillMd: true });
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(plugin!.skills.map((s) => s.name)).toEqual(["real-skill"]);
  });

  it("propagates a malformed SKILL.md as a fail-closed error", () => {
    const dir = makeSkillsOnlyPlugin();
    const sdir = path.join(dir, "skills", "broken");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "SKILL.md"), "no frontmatter at all");
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /skills\/broken\/SKILL\.md/.test(e))).toBe(true);
  });

  it("rejects a skills/ that is a symlink (no enumeration escape outside the plugin)", () => {
    const dir = makeSkillsOnlyPlugin();
    const outside = tmp("tachyon-outside-");
    fs.symlinkSync(outside, path.join(dir, "skills"));
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /must be a real directory/.test(e))).toBe(true);
  });

  it("rejects a symlinked skill entry under skills/", () => {
    const dir = makeSkillsOnlyPlugin();
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    const real = tmp("tachyon-realskill-");
    fs.writeFileSync(path.join(real, "SKILL.md"), "---\nname: evil\ndescription: d\n---\n");
    fs.symlinkSync(real, path.join(dir, "skills", "evil"));
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /symlinks are not allowed/.test(e))).toBe(true);
  });

  it("caps the immediate skills/ fanout (hostile empty-dir flood)", () => {
    const dir = makeSkillsOnlyPlugin();
    const root = path.join(dir, "skills");
    for (let i = 0; i < 70; i++) fs.mkdirSync(path.join(root, `s${i}`), { recursive: true });
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /too many entries/.test(e))).toBe(true);
  });

  it("caps the fanout even with regular FILES (not just dirs/symlinks)", () => {
    const dir = makeSkillsOnlyPlugin();
    const root = path.join(dir, "skills");
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x");
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /too many entries/.test(e))).toBe(true);
  });

  it("previewInstall plans skill targets for a hooks+skills plugin (Step 3 wires them)", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    addSkill(dir, "my-skill");
    const ws = makeWorkspace(["claude"]);
    const { plugin } = loadPlugin(dir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.steps).toHaveLength(1); // the hook
    expect(preview.skillTargets.map((t) => t.destRel)).toEqual([".claude/skills/my-skill"]); // the skill
  });
});

describe("loadPlugin — MCP discovery (spec 254 Step 1)", () => {
  /** Write a neutral `mcp.json` payload into a plugin fixture. */
  const addMcp = (dir: string, servers: unknown[]) => fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers }));
  const STDIO = { name: "db", transport: "stdio", command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } };

  it("loads an MCP-only plugin (no hooks/skills) — MCP counts toward the ≥1-capability rule", () => {
    const dir = makeSkillsOnlyPlugin("mcp-only", ["claude", "codex"]); // declares runtimes, ships no blocks
    addMcp(dir, [STDIO]);
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(plugin?.mcp).toHaveLength(1);
    expect(plugin?.mcp[0]).toMatchObject({ name: "db", transport: "stdio", command: "npx" });
  });

  it("fails closed on an invalid mcp.json", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers: [{ name: "x", transport: "stdio", command: "/abs/evil" }] }));
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.join(" ")).toMatch(/mcp\.json|command/);
  });

  it("rejects a symlinked mcp.json (no escaping the plugin boundary)", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    const real = path.join(tmp("mcp-outside-"), "evil.json");
    fs.writeFileSync(real, JSON.stringify({ servers: [STDIO] }));
    fs.symlinkSync(real, path.join(dir, "mcp.json"));
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.join(" ")).toMatch(/regular file/);
  });

  it("loads a mixed hooks + skills + MCP plugin", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    addSkill(dir, "my-skill");
    addMcp(dir, [STDIO, { name: "api", transport: "http", url: "https://api.test", headers: { Authorization: "Bearer ${API_TOKEN}" } }]);
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(Object.keys(plugin!.blocks)).toEqual(["claude"]);
    expect(plugin!.skills).toHaveLength(1);
    expect(plugin!.mcp.map((m) => m.name)).toEqual(["db", "api"]);
  });

  it("absent mcp.json → no MCP (not an error)", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(plugin?.mcp).toEqual([]);
  });
});

describe("planMcpTargets + per-runtime renderers (spec 254 Step 2)", () => {
  const addMcp = (dir: string, servers: unknown[]) => fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers }));
  const STDIO = { name: "db", transport: "stdio", command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } };
  const HTTP = { name: "api", transport: "http", url: "https://api.test/v1", headers: { Authorization: "Bearer ${API_TOKEN}", "X-Env": "${ENVNAME}" } };
  const oneServer = (s: unknown): McpServer => loadMcpPayload(JSON.stringify({ servers: [s] })).payload!.servers[0];

  it("runtimeSupportsMcp is true for both v1 runtimes", () => {
    expect(runtimeSupportsMcp("claude")).toBe(true);
    expect(runtimeSupportsMcp("codex")).toBe(true);
  });

  it("plans each server × each present declared runtime, in runtime then server order; skips absent runtimes", () => {
    const dir = makePlugin({ runtimes: ["claude", "codex"] });
    addMcp(dir, [STDIO, HTTP]);
    const { plugin } = loadPlugin(dir);
    const both = planMcpTargets(plugin!, new Set(["claude", "codex"] as const));
    expect(both.map((t) => `${t.runtime}:${t.ref}:${t.destRel}`)).toEqual([
      "claude:db:.mcp.json", "claude:api:.mcp.json",
      "codex:db:.codex/config.toml", "codex:api:.codex/config.toml",
    ]);
    // codex declared but absent from the workspace → only claude targets
    const onlyClaude = planMcpTargets(plugin!, new Set(["claude"] as const));
    expect(onlyClaude.every((t) => t.runtime === "claude")).toBe(true);
    expect(onlyClaude).toHaveLength(2);
  });

  it("no-MCP plugin plans nothing", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    const { plugin } = loadPlugin(dir);
    expect(planMcpTargets(plugin!, new Set(["claude"] as const))).toEqual([]);
  });

  it("renders a claude stdio + http entry (verbatim, empties dropped)", () => {
    expect(renderClaudeMcpEntry(oneServer(STDIO))).toEqual({ command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } });
    expect(renderClaudeMcpEntry(oneServer(HTTP))).toEqual({ type: "http", url: "https://api.test/v1", headers: { Authorization: "Bearer ${API_TOKEN}", "X-Env": "${ENVNAME}" } });
    expect(renderClaudeMcpEntry(oneServer({ name: "bare", transport: "stdio", command: "node" }))).toEqual({ command: "node" });
  });

  it("renders a codex stdio TOML block — env refs become env_vars (codex doesn't expand ${VAR} in env)", () => {
    expect(renderCodexMcpBlock(oneServer(STDIO))).toBe(
      `[mcp_servers.db]\ncommand = "npx"\nargs = ["-y", "@scope/db"]\nenv_vars = ["DB_URL"]\n`,
    );
  });

  it("renders a codex http TOML block — Bearer→bearer_token_env_var, other header→env_http_headers", () => {
    expect(renderCodexMcpBlock(oneServer(HTTP))).toBe(
      `[mcp_servers.api]\nurl = "https://api.test/v1"\nbearer_token_env_var = "API_TOKEN"\nenv_http_headers = { "X-Env" = "ENVNAME" }\n`,
    );
  });

  it("TOML-escapes a hazardous literal arg + a unicode arg (no injection)", () => {
    const s = oneServer({ name: "x", transport: "stdio", command: "node", args: ['a"b\\c', "café→x"] });
    expect(renderCodexMcpBlock(s)).toBe(`[mcp_servers.x]\ncommand = "node"\nargs = ["a\\"b\\\\c", "café→x"]\n`);
  });

  it("renders a hyphenated server name as a safe bare key + multiple env_vars", () => {
    const s = oneServer({ name: "db-tools-2", transport: "stdio", command: "node", env: { A_KEY: "${A_KEY}", B_KEY: "${B_KEY}" } });
    expect(renderCodexMcpBlock(s)).toBe(`[mcp_servers.db-tools-2]\ncommand = "node"\nenv_vars = ["A_KEY", "B_KEY"]\n`);
  });

  it("renders multiple non-auth headers into one env_http_headers table", () => {
    const s = oneServer({ name: "x", transport: "http", url: "https://x.test", headers: { "X-A": "${A}", "X-B": "${B}" } });
    expect(renderCodexMcpBlock(s)).toBe(`[mcp_servers.x]\nurl = "https://x.test"\nenv_http_headers = { "X-A" = "A", "X-B" = "B" }\n`);
  });
});

describe("MCP install / remove I/O (spec 254 Step 4)", () => {
  const addMcp = (dir: string, servers: unknown[]) => fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers }));
  const MCPJSON = (ws: string) => path.join(ws, ".mcp.json");
  const TOML = (ws: string) => path.join(ws, ".codex/config.toml");
  const readJ = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
  const STDIO = { name: "db", transport: "stdio", command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } };
  const mcpPlugin = (servers: unknown[] = [STDIO], runtimes = ["claude", "codex"]) => {
    const dir = makeSkillsOnlyPlugin("mcp-pl", runtimes); // declares runtimes, no hooks blocks
    addMcp(dir, servers);
    return dir;
  };

  it("installs a server into claude .mcp.json + codex config.toml and records lockfile targets; remove un-merges", () => {
    const dir = mcpPlugin();
    const ws = makeWorkspace(["claude", "codex"]);
    const r = install(dir, ws);
    expect(r.installed).toBe(true);
    expect(readJ(MCPJSON(ws)).mcpServers.db).toEqual({ command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } });
    expect(fs.readFileSync(TOML(ws), "utf8")).toContain("[mcp_servers.db]");
    expect(fs.readFileSync(TOML(ws), "utf8")).toContain('env_vars = ["DB_URL"]');
    const lock = readJ(LOCK(ws)).plugins["mcp-pl"];
    expect(lock.targets.filter((t: { kind: string }) => t.kind === "mcp-server")).toHaveLength(2);

    const rm = applyRemove("mcp-pl", ws);
    expect(rm.removed).toBe(true);
    expect(fs.existsSync(MCPJSON(ws))).toBe(false); // only server → file removed
    expect(fs.existsSync(TOML(ws))).toBe(false); // only block → config.toml husk removed too
  });

  it("preserves a pre-existing USER server across install + remove (claude)", () => {
    const ws = makeWorkspace(["claude"]);
    fs.writeFileSync(MCPJSON(ws), JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }));
    install(mcpPlugin([STDIO], ["claude"]), ws);
    expect(readJ(MCPJSON(ws)).mcpServers.playwright).toEqual({ command: "npx" });
    expect(readJ(MCPJSON(ws)).mcpServers.db).toBeDefined();
    applyRemove("mcp-pl", ws);
    expect(readJ(MCPJSON(ws)).mcpServers.playwright).toEqual({ command: "npx" }); // user server survives
    expect(readJ(MCPJSON(ws)).mcpServers.db).toBeUndefined();
  });

  it("collision: undecided → fail-closed; Keep leaves the user's server; Replace overwrites", () => {
    const ws = makeWorkspace(["claude"]);
    fs.writeFileSync(MCPJSON(ws), JSON.stringify({ mcpServers: { db: { command: "USER-OWN" } } }));
    const dir = mcpPlugin([STDIO], ["claude"]);
    const { plugin } = loadPlugin(dir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.mcpTargets[0].collision).toBe(true);
    // undecided → refuse (mcpConfirmed so we reach the collision check, not the OQ5 ack gate)
    expect(applyInstall(plugin!, preview, ws, detectRuntimes(ws), { mcpConfirmed: true }).errors[0]).toMatch(/collides/);
    // keep → user's server untouched, not recorded
    const kept = applyInstall(plugin!, preview, ws, detectRuntimes(ws), { mcpDecisions: { "claude db": "keep" }, mcpConfirmed: true });
    expect(kept.installed).toBe(false); // nothing else to install (mcp-only plugin, server kept)
    expect(readJ(MCPJSON(ws)).mcpServers.db).toEqual({ command: "USER-OWN" });
    // replace → overwritten + recorded
    const rep = applyInstall(plugin!, preview, ws, detectRuntimes(ws), { mcpDecisions: { "claude db": "replace" }, mcpConfirmed: true });
    expect(rep.installed).toBe(true);
    expect(readJ(MCPJSON(ws)).mcpServers.db.command).toBe("npx");
  });

  it("content-aware remove: a user-edited server is left as an orphan, never clobbered", () => {
    const ws = makeWorkspace(["claude"]);
    install(mcpPlugin([STDIO], ["claude"]), ws);
    // user edits our server in place
    const j = readJ(MCPJSON(ws));
    j.mcpServers.db.command = "user-changed";
    fs.writeFileSync(MCPJSON(ws), JSON.stringify(j));
    const rm = applyRemove("mcp-pl", ws);
    expect(rm.removed).toBe(true);
    expect(rm.orphans).toBe(1);
    expect(readJ(MCPJSON(ws)).mcpServers.db.command).toBe("user-changed"); // preserved
  });

  it("update stale-cleanup: a server dropped by the new version is un-merged", () => {
    const ws = makeWorkspace(["claude"]);
    const v1 = mcpPlugin([STDIO, { name: "extra", transport: "stdio", command: "node" }], ["claude"]);
    install(v1, ws);
    expect(readJ(MCPJSON(ws)).mcpServers.extra).toBeDefined();
    // v2 of the SAME plugin drops 'extra'
    fs.writeFileSync(path.join(v1, "tachyon-plugin.json"), JSON.stringify({ name: "mcp-pl", version: "2.0.0", description: "v2", runtimes: ["claude"] }));
    addMcp(v1, [STDIO]);
    const upd = applyUpdate(loadPlugin(v1).plugin!, ws, { mcpConfirmed: true });
    expect(upd.updated).toBe(true);
    expect(readJ(MCPJSON(ws)).mcpServers.db).toBeDefined();
    expect(readJ(MCPJSON(ws)).mcpServers.extra).toBeUndefined(); // stale server cleaned up
  });

  it("a corrupted mcp-server lockfile target (wrong file) is fail-closed at remove", () => {
    const ws = makeWorkspace(["claude"]);
    install(mcpPlugin([STDIO], ["claude"]), ws);
    const lock = readJ(LOCK(ws));
    lock.plugins["mcp-pl"].targets.find((t: { kind: string }) => t.kind === "mcp-server").file = "package.json";
    fs.writeFileSync(LOCK(ws), JSON.stringify(lock));
    expect(applyRemove("mcp-pl", ws).errors[0]).toMatch(/not a valid MCP config target/);
  });

  it("[security] OQ5: applyInstall refuses MCP without the explicit confirmation (engine fail-closed, not just UI)", () => {
    const ws = makeWorkspace(["claude"]);
    const { plugin } = loadPlugin(mcpPlugin([STDIO], ["claude"]));
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    // no mcpConfirmed → refuse
    expect(applyInstall(plugin!, preview, ws, detectRuntimes(ws)).errors[0]).toMatch(/MCP servers require/);
    // mcpConfirmed:true → installs
    expect(applyInstall(plugin!, preview, ws, detectRuntimes(ws), { mcpConfirmed: true }).installed).toBe(true);
  });

  it("[security] lost-update: .mcp.json changed between preview and apply → refuse", () => {
    const ws = makeWorkspace(["claude"]);
    const { plugin } = loadPlugin(mcpPlugin([STDIO], ["claude"]));
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    fs.writeFileSync(MCPJSON(ws), JSON.stringify({ mcpServers: { other: { command: "x" } } })); // user edits after preview
    expect(applyInstall(plugin!, preview, ws, detectRuntimes(ws), { mcpConfirmed: true }).errors[0]).toMatch(/changed since preview/);
  });

  it("[security] a broken .mcp.json fails closed at preview (never treated as 'server absent')", () => {
    const ws = makeWorkspace(["claude"]);
    fs.writeFileSync(MCPJSON(ws), "{ not json");
    const { plugin } = loadPlugin(mcpPlugin([STDIO], ["claude"]));
    expect(previewInstall(plugin!, ws, detectRuntimes(ws)).errors[0]).toMatch(/invalid JSON/);
  });

  it("[security] a forged prior target can't claim a user's server: content mismatch ⇒ still a collision", () => {
    const ws = makeWorkspace(["claude"]);
    fs.writeFileSync(MCPJSON(ws), JSON.stringify({ mcpServers: { db: { command: "USER-OWN" } } }));
    // forge a lockfile that claims this plugin owns 'db' with a DIFFERENT recorded entry
    const lf = { schemaVersion: 1, plugins: { "mcp-pl": { name: "mcp-pl", version: "1.0.0", runtimes: ["claude"], targets: [{ runtime: "claude", kind: "mcp-server", file: ".mcp.json", ref: "db", removal: { command: "OURS" } }] } } };
    fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true });
    fs.writeFileSync(LOCK(ws), JSON.stringify(lf));
    const { plugin } = loadPlugin(mcpPlugin([STDIO], ["claude"]));
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.mcpTargets[0].collision).toBe(true); // on-disk 'db' ≠ recorded removal → NOT ours
  });

  it("codex content-aware remove preserves model= + other tables; edited block → orphan", () => {
    const ws = makeWorkspace(["codex"]);
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
    fs.writeFileSync(TOML(ws), 'model = "gpt-5-codex"\n\n[mcp_servers.github]\nurl = "https://g"\n');
    install(mcpPlugin([STDIO], ["codex"]), ws);
    let toml = fs.readFileSync(TOML(ws), "utf8");
    expect(toml).toContain('model = "gpt-5-codex"');
    expect(toml).toContain("[mcp_servers.db]");
    const rm = applyRemove("mcp-pl", ws);
    toml = fs.readFileSync(TOML(ws), "utf8");
    expect(toml).toContain('model = "gpt-5-codex"'); // user setting preserved
    expect(toml).toContain("[mcp_servers.github]"); // user server preserved
    expect(toml).not.toContain("[mcp_servers.db]"); // ours un-merged
    expect(rm.orphans).toBe(0);
  });
});

describe("skill install / remove I/O (spec 251 Step 3)", () => {
  const SKILL = (ws: string, rtDir: string, name: string) => path.join(ws, rtDir, "skills", name, "SKILL.md");
  const installWith = (pluginDir: string, ws: string, decisions: Record<string, "keep" | "replace"> = {}) => {
    const { plugin } = loadPlugin(pluginDir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    return applyInstall(plugin!, preview, ws, detectRuntimes(ws), { skillDecisions: decisions });
  };

  it("materializes a skill into each present runtime's skills dir + records skill-dir targets", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude", "codex"]);
    addSkill(dir, "greeter", { description: "says hi" });
    const ws = makeWorkspace(["claude", "codex"]);
    const res = installWith(dir, ws);
    expect(res.installed).toBe(true);
    expect(fs.existsSync(SKILL(ws, ".claude", "greeter"))).toBe(true);
    expect(fs.existsSync(SKILL(ws, ".agents", "greeter"))).toBe(true); // codex → .agents/skills
    const lock = readJson(LOCK(ws)).plugins.sk;
    const skillTargets = lock.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file).sort();
    expect(skillTargets).toEqual([".agents/skills/greeter", ".claude/skills/greeter"]);
  });

  it("a hooks+skills plugin installs both", () => {
    const dir = makePlugin({ runtimes: ["claude"] });
    addSkill(dir, "helper");
    const ws = makeWorkspace(["claude"]);
    expect(installWith(dir, ws).installed).toBe(true);
    expect(fs.existsSync(SETTINGS(ws))).toBe(true); // hook
    expect(fs.existsSync(SKILL(ws, ".claude", "helper"))).toBe(true); // skill
  });

  it("refuses (fail-closed) a colliding skill with no Keep/Replace decision", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]);
    addSkill(dir, "dup");
    const ws = makeWorkspace(["claude"]);
    fs.mkdirSync(path.join(ws, ".claude/skills/dup"), { recursive: true });
    fs.writeFileSync(SKILL(ws, ".claude", "dup"), "USER OWN SKILL");
    const res = installWith(dir, ws); // no decision
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/collides with an existing skill/);
    expect(fs.readFileSync(SKILL(ws, ".claude", "dup"), "utf8")).toBe("USER OWN SKILL"); // untouched
  });

  it("Keep leaves the user's skill untouched and does not record it", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]);
    addSkill(dir, "kept");
    addSkill(dir, "fresh"); // a non-colliding skill so the install isn't empty
    const ws = makeWorkspace(["claude"]);
    fs.mkdirSync(path.join(ws, ".claude/skills/kept"), { recursive: true });
    fs.writeFileSync(SKILL(ws, ".claude", "kept"), "USER OWN");
    const res = installWith(dir, ws, { ".claude/skills/kept": "keep" });
    expect(res.installed).toBe(true);
    expect(fs.readFileSync(SKILL(ws, ".claude", "kept"), "utf8")).toBe("USER OWN"); // kept
    expect(fs.existsSync(SKILL(ws, ".claude", "fresh"))).toBe(true); // the fresh one materialized
    const skillTargets = readJson(LOCK(ws)).plugins.sk.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file);
    expect(skillTargets).toEqual([".claude/skills/fresh"]); // 'kept' NOT recorded
  });

  it("Replace overwrites the user's skill (consented) and records it", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]);
    addSkill(dir, "dup", { description: "plugin version" });
    const ws = makeWorkspace(["claude"]);
    fs.mkdirSync(path.join(ws, ".claude/skills/dup"), { recursive: true });
    fs.writeFileSync(SKILL(ws, ".claude", "dup"), "USER OWN");
    const res = installWith(dir, ws, { ".claude/skills/dup": "replace" });
    expect(res.installed).toBe(true);
    expect(fs.readFileSync(SKILL(ws, ".claude", "dup"), "utf8")).toMatch(/name: dup/); // overwritten with the plugin's
  });

  it("remove deletes the materialized skill-dirs", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]);
    addSkill(dir, "gone");
    const ws = makeWorkspace(["claude"]);
    installWith(dir, ws);
    expect(fs.existsSync(SKILL(ws, ".claude", "gone"))).toBe(true);
    const fp = previewRemove("sk", ws).fingerprint;
    expect(applyRemove("sk", ws, { expectedFingerprint: fp }).removed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/gone"))).toBe(false);
  });

  it("update cleanup deletes a skill-dir the new version dropped (no orphan)", () => {
    const ws = makeWorkspace(["claude"]);
    const v1 = makeSkillsOnlyPlugin("sk", ["claude"]); addSkill(v1, "old"); addSkill(v1, "keep-me");
    installWith(v1, ws);
    expect(fs.existsSync(SKILL(ws, ".claude", "old"))).toBe(true);
    const v2 = makeSkillsOnlyPlugin("sk", ["claude"]); addSkill(v2, "keep-me"); // drops "old"
    expect(installWith(v2, ws).installed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/old"))).toBe(false); // stale dir cleaned
    expect(fs.existsSync(SKILL(ws, ".claude", "keep-me"))).toBe(true);
    const skillTargets = readJson(LOCK(ws)).plugins.sk.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file);
    expect(skillTargets).toEqual([".claude/skills/keep-me"]); // lockfile no longer records 'old'
  });

  it("a dest that appeared between preview and apply is refused (fingerprint guard)", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]); addSkill(dir, "race");
    const ws = makeWorkspace(["claude"]);
    const { plugin } = loadPlugin(dir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws)); // 'race' absent → collision:false
    fs.mkdirSync(path.join(ws, ".claude/skills/race"), { recursive: true });
    fs.writeFileSync(SKILL(ws, ".claude", "race"), "USER appeared late");
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws)); // fresh sees the collision → fingerprint mismatch
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/changed since preview/);
    expect(fs.readFileSync(SKILL(ws, ".claude", "race"), "utf8")).toBe("USER appeared late"); // untouched
  });

  it("remove fail-closes on a corrupted skill-dir target (never deletes an arbitrary path)", () => {
    const ws = makeWorkspace(["claude"]);
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]); addSkill(dir, "s1");
    installWith(dir, ws);
    const lock = readJson(LOCK(ws));
    lock.plugins.sk.targets.find((x: { kind: string }) => x.kind === "skill-dir").file = "package.json"; // corrupt
    fs.writeFileSync(LOCK(ws), JSON.stringify(lock));
    fs.writeFileSync(path.join(ws, "package.json"), "{}");
    expect(previewRemove("sk", ws).errors.some((e) => /not a valid skills path/.test(e))).toBe(true);
    expect(applyRemove("sk", ws).removed).toBe(false);
    expect(fs.existsSync(path.join(ws, "package.json"))).toBe(true); // NOT deleted
  });

  it("install fail-closes on a pre-existing corrupted skill-dir target (won't stale-delete an arbitrary path)", () => {
    const ws = makeWorkspace(["claude"]);
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]); addSkill(dir, "s1");
    installWith(dir, ws);
    const lock = readJson(LOCK(ws));
    lock.plugins.sk.targets.find((x: { kind: string }) => x.kind === "skill-dir").file = ".claude/settings.json"; // corrupt → not a skills path
    fs.writeFileSync(LOCK(ws), JSON.stringify(lock));
    fs.writeFileSync(path.join(ws, ".claude/settings.json"), "USER SETTINGS");
    const res = installWith(dir, ws); // a re-install
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/not a valid skills path/);
    expect(fs.readFileSync(path.join(ws, ".claude/settings.json"), "utf8")).toBe("USER SETTINGS"); // NOT deleted
  });

  it("a re-install of the same plugin's own skill is NOT a collision (it's ours)", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude"]);
    addSkill(dir, "mine");
    const ws = makeWorkspace(["claude"]);
    installWith(dir, ws);
    const { plugin } = loadPlugin(dir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.skillTargets.find((t) => t.skill === "mine")?.collision).toBe(false); // ours, not a user collision
    expect(installWith(dir, ws).installed).toBe(true); // re-install succeeds with no decision
  });
});

describe("planSkillTargets (spec 251 Step 2)", () => {
  it("plans claude → .claude/skills and codex → .agents/skills for each present runtime", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude", "codex"]);
    addSkill(dir, "alpha");
    addSkill(dir, "beta");
    const { plugin } = loadPlugin(dir);
    const targets = planSkillTargets(plugin!, new Set(["claude", "codex"] as const));
    expect(targets).toEqual([
      { runtime: "claude", skill: "alpha", srcRel: ".tachyon/plugins/sk/skills/alpha", destRel: ".claude/skills/alpha" },
      { runtime: "claude", skill: "beta", srcRel: ".tachyon/plugins/sk/skills/beta", destRel: ".claude/skills/beta" },
      { runtime: "codex", skill: "alpha", srcRel: ".tachyon/plugins/sk/skills/alpha", destRel: ".agents/skills/alpha" },
      { runtime: "codex", skill: "beta", srcRel: ".tachyon/plugins/sk/skills/beta", destRel: ".agents/skills/beta" },
    ]);
  });

  it("skips a declared runtime that is ABSENT from the workspace", () => {
    const dir = makeSkillsOnlyPlugin("sk", ["claude", "codex"]);
    addSkill(dir, "alpha");
    const { plugin } = loadPlugin(dir);
    const targets = planSkillTargets(plugin!, new Set(["claude"] as const)); // codex not present
    expect(targets.map((t) => t.runtime)).toEqual(["claude"]);
  });

  it("plans nothing for a plugin with no skills", () => {
    const dir = makePlugin({ runtimes: ["claude"] }); // hooks-only
    const { plugin } = loadPlugin(dir);
    expect(planSkillTargets(plugin!, new Set(["claude"] as const))).toEqual([]);
  });

  it("both v1 runtimes support skills", () => {
    expect(runtimeSupportsSkills("claude")).toBe(true);
    expect(runtimeSupportsSkills("codex")).toBe(true);
  });
});

describe("loadPlugin", () => {
  it("reads + validates a plugin's manifest and claude hooks", () => {
    const { plugin, errors } = loadPlugin(makePlugin());
    expect(errors).toEqual([]);
    expect(plugin?.manifest.name).toBe("sdd");
    expect(plugin?.blocks.claude?.PreToolUse).toHaveLength(1);
    expect(plugin?.rootRel.claude).toBe(".tachyon/plugins/sdd/claude");
  });
  it("fail-closes on a missing manifest / missing hooks", () => {
    expect(loadPlugin(tmp("empty-")).errors[0]).toMatch(/no tachyon-plugin.json/);
    const noHooks = tmp("nohooks-");
    fs.writeFileSync(path.join(noHooks, "tachyon-plugin.json"), JSON.stringify({ name: "x", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" } }));
    expect(loadPlugin(noHooks).errors[0]).toMatch(/has no hooks.json/);
  });
});

describe("detectRuntimes", () => {
  it("detects claude by its config dir; nothing in a bare workspace", () => {
    expect([...detectRuntimes(makeWorkspace())]).toEqual(["claude"]);
    expect(detectRuntimes(tmp("bare-")).size).toBe(0);
  });
});

describe("previewInstall (the security surface)", () => {
  it("surfaces the wired commands + diff + a fingerprint without writing anything", () => {
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors).toEqual([]);
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0].wiredCommands).toEqual([RESOLVED]);
    expect(preview.steps[0].before).toEqual({});
    expect(preview.fingerprint).not.toBe("");
    expect(fs.existsSync(SETTINGS(ws))).toBe(false); // preview never writes
  });

  it("skips a declared runtime absent from the workspace", () => {
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(makePlugin({ runtimes: ["claude", "codex"] }));
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.skipped).toContain("codex");
    expect(preview.steps).toHaveLength(1);
  });

  it("fail-closes on an invalid existing settings.json (never treats it as empty)", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(SETTINGS(ws), "{ not json");
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors.some((e) => /invalid JSON/.test(e))).toBe(true);
  });

  it("fail-closes on a corrupt lockfile", () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.dirname(LOCK(ws)), { recursive: true });
    fs.writeFileSync(LOCK(ws), "{ corrupt");
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors.some((e) => /corrupt/.test(e))).toBe(true);
  });

  it("fail-closes when the lockfile path is present-but-unreadable (EISDIR, not absent)", () => {
    const ws = makeWorkspace();
    fs.mkdirSync(LOCK(ws), { recursive: true }); // a DIRECTORY where the lockfile should be → read error, not ENOENT
    const { plugin } = loadPlugin(makePlugin());
    expect(previewInstall(plugin!, ws, detectRuntimes(ws)).errors.length).toBeGreaterThan(0);
  });

  it("rejects a payload containing a symlink", () => {
    const pluginDir = makePlugin();
    fs.symlinkSync("/etc/passwd", path.join(pluginDir, "claude", "evil-link"));
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(pluginDir);
    expect(previewInstall(plugin!, ws, detectRuntimes(ws)).errors.some((e) => /symlink/.test(e))).toBe(true);
  });
});

describe("previewInstall — declared-runtime targeting (spec 263)", () => {
  // a plugin declaring claude+codex but shipping a hooks block ONLY for claude → codex is a "no-artifact" runtime.
  function makeNoArtifactCodexPlugin(): string {
    const dir = tmp("tachyon-plugin-");
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name: "sdd", version: "1.0.0", description: "claude hooks only", runtimes: ["claude", "codex"], blocks: { claude: "claude/" } }));
    fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` }] }] }));
    fs.writeFileSync(path.join(dir, "claude", "gate.sh"), "#!/bin/sh\necho hi\n");
    return dir;
  }

  it("a FRESH workspace (no .claude/.codex) still plans BOTH declared runtimes — the target set, not what exists", () => {
    const ws = tmp("tachyon-ws-"); // genuinely fresh: no runtime config dirs at all
    expect(detectRuntimes(ws).size).toBe(0);
    const { plugin } = loadPlugin(makePlugin({ runtimes: ["claude", "codex"] }));
    const preview = previewInstall(plugin!, ws, new Set(["claude", "codex"] as const));
    expect(preview.errors).toEqual([]);
    expect(preview.steps.map((s) => s.runtime).sort()).toEqual(["claude", "codex"]);
    expect(preview.targetRuntimes).toEqual(["claude", "codex"]);
    expect(preview.skipped).toEqual([]);
  });

  it("deselecting a runtime drops it to skipped and plans only the kept one", () => {
    const ws = tmp("tachyon-ws-");
    const { plugin } = loadPlugin(makePlugin({ runtimes: ["claude", "codex"] }));
    const preview = previewInstall(plugin!, ws, new Set(["claude"] as const));
    expect(preview.steps.map((s) => s.runtime)).toEqual(["claude"]);
    expect(preview.targetRuntimes).toEqual(["claude"]);
    expect(preview.skipped).toEqual(["codex"]);
  });

  it("GOLDEN: a both-present workspace produces the unchanged install plan (present-path regression, scenario 63)", () => {
    const ws = makeWorkspace(["claude", "codex"]); // both runtime dirs already exist
    const pdir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(pdir, "deploy");
    const { plugin } = loadPlugin(pdir);
    const preview = previewInstall(plugin!, ws, new Set(["claude", "codex"] as const));
    // the plan-visible fields are frozen — any drift to the present-path materialization fails here.
    expect(preview.errors).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(preview.skipped).toEqual([]);
    expect(preview.targetRuntimes).toEqual(["claude", "codex"]);
    expect(preview.steps.map((s) => ({ rt: s.runtime, file: s.settingsRel, cmds: s.wiredCommands }))).toEqual([
      { rt: "claude", file: ".claude/settings.json", cmds: [`"${".tachyon/plugins/sdd/claude"}"/gate.sh`] },
      { rt: "codex", file: ".codex/hooks.json", cmds: [`"${".tachyon/plugins/sdd/codex"}"/gate.sh`] },
    ]);
    expect(preview.skillTargets.map((t) => ({ rt: t.runtime, skill: t.skill, dest: t.destRel, collision: t.collision }))).toEqual([
      { rt: "claude", skill: "deploy", dest: ".claude/skills/deploy", collision: false },
      { rt: "codex", skill: "deploy", dest: ".agents/skills/deploy", collision: false },
    ]);
    expect(preview.mcpTargets).toEqual([]);
  });

  it("binds the runtime SELECTION into the fingerprint even for a no-artifact runtime", () => {
    const ws = tmp("tachyon-ws-");
    const { plugin } = loadPlugin(makeNoArtifactCodexPlugin());
    const both = previewInstall(plugin!, ws, new Set(["claude", "codex"] as const));
    const onlyClaude = previewInstall(plugin!, ws, new Set(["claude"] as const));
    // codex contributes NO step/skill/mcp — the artifact plans are byte-identical...
    expect(both.steps).toEqual(onlyClaude.steps);
    expect(both.skillTargets).toEqual(onlyClaude.skillTargets);
    expect(both.mcpTargets).toEqual(onlyClaude.mcpTargets);
    // ...yet selecting vs deselecting codex MUST change consent (the explicit targetRuntimes binding — without
    // it, a declared-but-no-artifact runtime would hash identically whether selected or not).
    expect(both.targetRuntimes).toEqual(["claude", "codex"]);
    expect(onlyClaude.targetRuntimes).toEqual(["claude"]);
    expect(both.fingerprint).not.toBe(onlyClaude.fingerprint);
  });

  it("INSTALLS into a fresh workspace, materializing every selected runtime (creating its config structure)", () => {
    const ws = tmp("tachyon-ws-"); // no .claude/.codex pre-exists
    const { plugin } = loadPlugin(makePlugin({ runtimes: ["claude", "codex"] }));
    const target = new Set(["claude", "codex"] as const);
    const res = applyInstall(plugin!, previewInstall(plugin!, ws, target), ws, target, { mcpConfirmed: true });
    expect(res.errors).toEqual([]);
    expect(res.installed).toBe(true);
    expect(res.runtimes.sort()).toEqual(["claude", "codex"]);
    expect(fs.existsSync(path.join(ws, ".claude", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".codex", "hooks.json"))).toBe(true);
  });

  it("records the runtime ancestor dirs it CREATED in a fresh workspace (spec 263 task 4)", () => {
    const ws = tmp("tachyon-ws-"); // genuinely fresh
    const pdir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(pdir, "deploy");
    const { plugin } = loadPlugin(pdir);
    const target = new Set(["claude", "codex"] as const);
    expect(applyInstall(plugin!, previewInstall(plugin!, ws, target), ws, target, { mcpConfirmed: true }).installed).toBe(true);
    const lock = readJson(LOCK(ws)).plugins[plugin!.manifest.name];
    // claude: .claude (settings) + .claude/skills (skill dest); codex: .codex (hooks) + .agents + .agents/skills.
    expect(new Set(lock.createdAncestors)).toEqual(new Set([".claude", ".claude/skills", ".codex", ".agents", ".agents/skills"]));
  });

  it("does NOT record an ancestor that already existed — only what it created (spec 263 task 4)", () => {
    const ws = makeWorkspace(["claude"]); // .claude pre-exists; .codex/.agents do not
    const pdir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(pdir, "deploy");
    const { plugin } = loadPlugin(pdir);
    const target = new Set(["claude", "codex"] as const);
    applyInstall(plugin!, previewInstall(plugin!, ws, target), ws, target, { mcpConfirmed: true });
    const lock = readJson(LOCK(ws)).plugins[plugin!.manifest.name];
    expect(lock.createdAncestors).not.toContain(".claude"); // pre-existed → not ours to remove
    expect(new Set(lock.createdAncestors)).toEqual(new Set([".claude/skills", ".codex", ".agents", ".agents/skills"]));
  });

  it("omits createdAncestors entirely when every runtime dir already exists (spec 263 task 4)", () => {
    const ws = makeWorkspace(["claude", "codex"]);
    fs.mkdirSync(path.join(ws, ".claude/skills"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".agents/skills"), { recursive: true });
    const pdir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(pdir, "deploy");
    const { plugin } = loadPlugin(pdir);
    const target = new Set(["claude", "codex"] as const);
    applyInstall(plugin!, previewInstall(plugin!, ws, target), ws, target, { mcpConfirmed: true });
    expect(readJson(LOCK(ws)).plugins[plugin!.manifest.name].createdAncestors).toBeUndefined();
  });

  it("atomicWrite removes its temp file when the rename fails — no orphan temp (spec 263 task 5)", () => {
    const dir = tmp("tachyon-aw-");
    const dest = path.join(dir, "target");
    fs.mkdirSync(dest); // a DIRECTORY at the destination path → rename(tmp → dir) throws (EISDIR) after tmp is written
    expect(() => atomicWrite(dest, "hello")).toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("uninstall — created-ancestor cleanup (spec 263 task 6)", () => {
  const installBoth = (ws: string) => {
    const pdir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(pdir, "deploy");
    const { plugin } = loadPlugin(pdir);
    const target = new Set(["claude", "codex"] as const);
    return applyInstall(plugin!, previewInstall(plugin!, ws, target), ws, target, { mcpConfirmed: true });
  };

  it("rmdir's exactly the runtime dirs the install created, deepest-first", () => {
    const ws = tmp("tachyon-ws-"); // genuinely fresh
    expect(installBoth(ws).installed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/deploy"))).toBe(true);
    expect(applyRemove("sdd", ws).removed).toBe(true);
    for (const d of [".claude", ".claude/skills", ".codex", ".agents", ".agents/skills"]) {
      expect(fs.existsSync(path.join(ws, d))).toBe(false);
    }
  });

  it("never removes a runtime dir that pre-existed the install", () => {
    const ws = makeWorkspace(["claude"]); // .claude pre-exists
    expect(installBoth(ws).installed).toBe(true);
    applyRemove("sdd", ws);
    expect(fs.existsSync(path.join(ws, ".claude"))).toBe(true); // pre-existed → kept
    expect(fs.existsSync(path.join(ws, ".claude/skills"))).toBe(false); // created → removed
    expect(fs.existsSync(path.join(ws, ".codex"))).toBe(false); // created → removed
  });

  it("leaves a created dir the user later filled with unrelated content (non-empty → safe no-op)", () => {
    const ws = tmp("tachyon-ws-");
    installBoth(ws);
    fs.writeFileSync(path.join(ws, ".claude", "user-notes.md"), "mine"); // user drops a file into a created dir
    applyRemove("sdd", ws);
    expect(fs.existsSync(path.join(ws, ".claude"))).toBe(true); // non-empty → preserved
    expect(fs.existsSync(path.join(ws, ".claude/user-notes.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".codex"))).toBe(false); // empty created → removed
  });

  it("an old lock with no createdAncestors removes cleanly (ancestor cleanup is a no-op)", () => {
    const ws = makeWorkspace(["claude"]);
    install(makePlugin(), ws);
    const lf = readJson(LOCK(ws));
    delete lf.plugins.sdd.createdAncestors; // simulate a pre-263 lockfile
    fs.writeFileSync(LOCK(ws), JSON.stringify(lf));
    expect(applyRemove("sdd", ws).removed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude"))).toBe(true); // pre-existed → untouched
  });

  it("a PARTIAL install (a skill write fails mid-activation) still records a complete removal manifest incl. createdAncestors", () => {
    const ws = tmp("tachyon-ws-");
    fs.writeFileSync(path.join(ws, ".agents"), "a user file, not a dir"); // makes the codex skill copy fail at activation
    const pdir = makePlugin({ runtimes: ["claude", "codex"] });
    addSkill(pdir, "deploy");
    const { plugin } = loadPlugin(pdir);
    const target = new Set(["claude", "codex"] as const);
    const res = applyInstall(plugin!, previewInstall(plugin!, ws, target), ws, target, { mcpConfirmed: true });
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/partial install/);
    // the lockfile was written BEFORE activation → it records the plugin + createdAncestors for a clean uninstall.
    const lock = readJson(LOCK(ws)).plugins.sdd;
    expect(new Set(lock.createdAncestors)).toEqual(new Set([".claude", ".claude/skills", ".codex", ".agents/skills"]));
    // `remove` cleans up exactly what got created, never the user's pre-existing .agents file.
    expect(applyRemove("sdd", ws).removed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".agents"))).toBe(true); // the user's file, untouched
  });
});

describe("install → use → remove (end-to-end on a real temp workspace)", () => {
  it("install writes settings + copies payload + records the lockfile", () => {
    const ws = makeWorkspace();
    expect(install(makePlugin(), ws).installed).toBe(true);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse[0].hooks[0].command).toBe(RESOLVED);
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/sdd/claude/gate.sh"))).toBe(true);
    expect(readJson(LOCK(ws)).plugins.sdd.targets[0].ref).toBe("PreToolUse");
  });

  it("remove un-merges, deletes the payload, drops the lockfile entry (back to clean)", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    expect(previewRemove("sdd", ws)).toMatchObject({ found: true, expectedCount: 1, removedCount: 1, orphans: 0 });
    expect(applyRemove("sdd", ws)).toMatchObject({ removed: true, orphans: 0 });
    expect(fs.existsSync(SETTINGS(ws))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/sdd"))).toBe(false);
    expect(fs.existsSync(LOCK(ws))).toBe(false);
  });

  it("preserves a user's own hook on remove", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(SETTINGS(ws), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user.sh" }] }] } }));
    install(makePlugin(), ws);
    applyRemove("sdd", ws);
    const settings = readJson(SETTINGS(ws));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("user.sh");
  });

  it("is idempotent — re-installing does not duplicate the hook", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    install(makePlugin(), ws);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse).toHaveLength(1);
  });

  it("surfaces an orphan when the user edited the plugin's hook before removing", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    const s = readJson(SETTINGS(ws));
    s.hooks.PreToolUse[0].hooks[0].command = "EDITED";
    fs.writeFileSync(SETTINGS(ws), JSON.stringify(s));
    expect(previewRemove("sdd", ws)).toMatchObject({ expectedCount: 1, removedCount: 0, orphans: 1 });
    expect(applyRemove("sdd", ws).orphans).toBe(1);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse).toHaveLength(1); // edited group left, never deleted
  });

  it("binds a remove to its consent fingerprint (TOCTOU) — refuses a stale one, honors a matching one", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    const fp = previewRemove("sdd", ws).fingerprint;
    expect(fp).not.toBe("");
    // a fingerprint that no longer matches current state → refuse, nothing removed
    const stale = applyRemove("sdd", ws, { expectedFingerprint: "STALE" });
    expect(stale.removed).toBe(false);
    expect(stale.errors[0]).toMatch(/changed since preview/);
    expect(fs.existsSync(LOCK(ws))).toBe(true); // untouched
    // the consented fingerprint → removes
    expect(applyRemove("sdd", ws, { expectedFingerprint: fp }).removed).toBe(true);
    expect(fs.existsSync(LOCK(ws))).toBe(false);
  });
});

describe("safety + fail-closed", () => {
  it("apply refuses a stale preview (settings changed since consent)", () => {
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    fs.writeFileSync(SETTINGS(ws), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "snuck-in" }] }] } }));
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws));
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/changed since preview/);
  });

  it("apply refuses when there is nothing to install (no runtime present)", () => {
    const ws = tmp("bare-ws-"); // no .claude
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws)); // present = {}
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws));
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/nothing to install/);
    expect(fs.existsSync(LOCK(ws))).toBe(false); // never wrote a runtimes:[] lock
  });

  it("remove fail-closes on a hand-corrupted lockfile removal", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    const lock = readJson(LOCK(ws));
    lock.plugins.sdd.targets[0].removal = { PreToolUse: "not-an-array" }; // corrupt removal
    fs.writeFileSync(LOCK(ws), JSON.stringify(lock));
    // a corrupt removal makes the WHOLE lockfile invalid (parseOwnedHooks rejects) → fail-closed
    expect(previewRemove("sdd", ws).errors.length).toBeGreaterThan(0);
    expect(applyRemove("sdd", ws).removed).toBe(false);
  });

  it("remove reports not-installed for an unknown plugin", () => {
    const ws = makeWorkspace();
    expect(previewRemove("ghost", ws).found).toBe(false);
    expect(applyRemove("ghost", ws).errors[0]).toMatch(/not installed/);
  });
});

describe("update (3-way: baseline vs current vs new)", () => {
  const V1 = `"${PLUGIN_ROOT_PLACEHOLDER}"/v1.sh`;
  const V2 = `"${PLUGIN_ROOT_PLACEHOLDER}"/v2.sh`;
  const cmdOf = (ws: string) => readJson(SETTINGS(ws)).hooks.PreToolUse.map((g: { hooks: Array<{ command: string }> }) => g.hooks[0].command);

  it("auto-updates when the user hasn't edited the plugin's hooks", () => {
    const ws = makeWorkspace();
    install(makePlugin({ command: V1 }), ws);
    expect(cmdOf(ws)[0]).toContain("v1.sh");
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", command: V2 })).plugin!;
    const res = applyUpdate(v2, ws);
    expect(res.updated).toBe(true);
    expect(cmdOf(ws)).toHaveLength(1); // replaced, not duplicated
    expect(cmdOf(ws)[0]).toContain("v2.sh");
    expect(readJson(LOCK(ws)).plugins.sdd.version).toBe("2.0.0");
  });

  it("is a no-op when already up to date", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    const res = applyUpdate(loadPlugin(makePlugin()).plugin!, ws);
    expect(res).toMatchObject({ updated: false, upToDate: true });
  });

  it("refuses an update whose new version drops a runtime the install uses (spec 263 task 7)", () => {
    const ws = makeWorkspace(["claude", "codex"]);
    const v1 = loadPlugin(makePlugin({ runtimes: ["claude", "codex"] })).plugin!;
    const target = new Set(["claude", "codex"] as const);
    applyInstall(v1, previewInstall(v1, ws, target), ws, target, { mcpConfirmed: true });
    // v2 declares ONLY claude → updating would silently drop codex; must error instead.
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", runtimes: ["claude"] })).plugin!;
    expect(previewUpdate(v2, ws).errors[0]).toMatch(/no longer supports runtime\(s\) codex/);
    expect(applyUpdate(v2, ws).updated).toBe(false);
    expect(readJson(LOCK(ws)).plugins.sdd.version).toBe("1.0.0"); // unchanged
    expect(fs.existsSync(path.join(ws, ".codex/hooks.json"))).toBe(true); // codex hook intact
  });

  it("an update materializes only the consented installed set, never a newly-added runtime (spec 263 task 7)", () => {
    const ws = makeWorkspace(["claude", "codex"]); // both runtimes present on disk...
    const v1 = loadPlugin(makePlugin({ runtimes: ["claude", "codex"], command: V1 })).plugin!;
    // ...but the user installed into claude ONLY (deselected codex at install).
    const target = new Set(["claude"] as const);
    applyInstall(v1, previewInstall(v1, ws, target), ws, target, { mcpConfirmed: true });
    expect(readJson(LOCK(ws)).plugins.sdd.runtimes).toEqual(["claude"]);
    expect(fs.existsSync(path.join(ws, ".codex/hooks.json"))).toBe(false); // codex never wired
    // an update must KEEP targeting claude only, not wire codex just because its dir exists on disk.
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", runtimes: ["claude", "codex"], command: V2 })).plugin!;
    expect(previewUpdate(v2, ws).install!.targetRuntimes).toEqual(["claude"]);
    expect(applyUpdate(v2, ws).updated).toBe(true);
    expect(readJson(LOCK(ws)).plugins.sdd.runtimes).toEqual(["claude"]);
    expect(fs.existsSync(path.join(ws, ".codex/hooks.json"))).toBe(false); // still not wired
  });

  it("refuses to update a plugin that isn't installed", () => {
    const ws = makeWorkspace();
    expect(applyUpdate(loadPlugin(makePlugin()).plugin!, ws).errors[0]).toMatch(/not installed/);
  });

  it("refuses without force when the user edited the plugin's hook (3-way conflict)", () => {
    const ws = makeWorkspace();
    install(makePlugin({ command: V1 }), ws);
    const s = readJson(SETTINGS(ws));
    s.hooks.PreToolUse[0].hooks[0].command = "MY-EDIT";
    fs.writeFileSync(SETTINGS(ws), JSON.stringify(s));
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", command: V2 })).plugin!;
    const preview = previewUpdate(v2, ws);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0].edited).toBe(1);
    const res = applyUpdate(v2, ws);
    expect(res.updated).toBe(false);
    expect(res.errors[0]).toMatch(/conflict/);
    expect(cmdOf(ws)).toEqual(["MY-EDIT"]); // untouched
  });

  it("with force, updates despite the edit, keeping the edited group as a conservative orphan", () => {
    const ws = makeWorkspace();
    install(makePlugin({ command: V1 }), ws);
    const s = readJson(SETTINGS(ws));
    s.hooks.PreToolUse[0].hooks[0].command = "MY-EDIT";
    fs.writeFileSync(SETTINGS(ws), JSON.stringify(s));
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", command: V2 })).plugin!;
    const res = applyUpdate(v2, ws, { force: true });
    expect(res.updated).toBe(true);
    const cmds = cmdOf(ws);
    expect(cmds).toContain("MY-EDIT"); // edited group kept (never deleted)
    expect(cmds.some((c: string) => c.includes("v2.sh"))).toBe(true); // new version added
  });

  it("refuses when the user already added a hook equal to the new version (would-duplicate collision)", () => {
    const ws = makeWorkspace();
    install(makePlugin({ command: V1 }), ws);
    // user manually adds a second group that happens to equal what v2 will write
    const s = readJson(SETTINGS(ws));
    s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: `"${".tachyon/plugins/sdd/claude"}"/v2.sh` }] });
    fs.writeFileSync(SETTINGS(ws), JSON.stringify(s));
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", command: V2 })).plugin!;
    const preview = previewUpdate(v2, ws);
    expect(preview.conflicts[0].collided).toBe(1);
    const res = applyUpdate(v2, ws);
    expect(res.updated).toBe(false);
    expect(res.errors[0]).toMatch(/would-duplicate|conflict/);
  });

  it("refuses a downgrade without force", () => {
    const ws = makeWorkspace();
    install(makePlugin({ version: "2.0.0", command: V2 }), ws);
    const v1 = loadPlugin(makePlugin({ version: "1.0.0", command: V1 })).plugin!;
    const preview = previewUpdate(v1, ws);
    expect(preview.isDowngrade).toBe(true);
    expect(applyUpdate(v1, ws).errors[0]).toMatch(/lower than|downgrade/);
    expect(applyUpdate(v1, ws, { force: true }).updated).toBe(true); // force allows it
  });

  it("binds an update to its consent fingerprint (TOCTOU) — refuses a stale one, applies a matching one", () => {
    const ws = makeWorkspace();
    install(makePlugin({ command: V1 }), ws);
    const v2 = loadPlugin(makePlugin({ version: "2.0.0", command: V2 })).plugin!;
    const fp = previewUpdate(v2, ws).install!.fingerprint;
    // a fingerprint that doesn't match the fresh plan → refuse, no write
    const stale = applyUpdate(v2, ws, { expectedFingerprint: "STALE" });
    expect(stale.updated).toBe(false);
    expect(stale.errors[0]).toMatch(/changed since preview/);
    expect(cmdOf(ws)[0]).toContain("v1.sh"); // untouched
    // the consented fingerprint → applies
    expect(applyUpdate(v2, ws, { expectedFingerprint: fp }).updated).toBe(true);
    expect(cmdOf(ws)[0]).toContain("v2.sh");
  });

  it("multi-runtime: a conflict in only one runtime is surfaced for that runtime", () => {
    const ws = makeWorkspace(["claude", "codex"]);
    install(makePlugin({ runtimes: ["claude", "codex"], command: V1 }), ws);
    // edit only the codex hook
    const codex = readJson(path.join(ws, ".codex", "hooks.json"));
    codex.hooks.PreToolUse[0].hooks[0].command = "CODEX-EDIT";
    fs.writeFileSync(path.join(ws, ".codex", "hooks.json"), JSON.stringify(codex));
    const v2 = loadPlugin(makePlugin({ runtimes: ["claude", "codex"], version: "2.0.0", command: V2 })).plugin!;
    const preview = previewUpdate(v2, ws);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0].runtime).toBe("codex");
    expect(preview.conflicts[0].edited).toBe(1);
  });

  it("wires the SAME plugin into BOTH claude and codex (the multi-runtime thesis)", () => {
    const ws = makeWorkspace(["claude", "codex"]);
    const res = install(makePlugin({ runtimes: ["claude", "codex"] }), ws);
    expect(res.installed).toBe(true);
    expect(res.runtimes.sort()).toEqual(["claude", "codex"]);
    // claude config wired in .claude/settings.json
    expect(readJson(path.join(ws, ".claude", "settings.json")).hooks.PreToolUse[0].hooks[0].command).toBe(RESOLVED);
    // codex config wired in .codex/hooks.json, with the codex payload root + codex-only statusMessage
    const codex = readJson(path.join(ws, ".codex", "hooks.json"));
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toBe(`"${".tachyon/plugins/sdd/codex"}"/gate.sh`);
    expect(codex.hooks.PreToolUse[0].hooks[0].statusMessage).toBe("running gate");
    expect(codex.hooks.PreToolUse[0].matcher).toBe("^Bash$"); // codex-native matcher preserved
    // lockfile records targets for both runtimes
    const lock = readJson(LOCK(ws));
    expect(lock.plugins.sdd.runtimes.sort()).toEqual(["claude", "codex"]);
    // remove cleans BOTH
    expect(applyRemove("sdd", ws).removed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".codex", "hooks.json"))).toBe(false);
  });

  it("a claude+codex plugin in a claude-only workspace wires claude, skips codex", () => {
    const ws = makeWorkspace(["claude"]);
    const res = install(makePlugin({ runtimes: ["claude", "codex"] }), ws);
    expect(res.runtimes).toEqual(["claude"]);
    expect(fs.existsSync(path.join(ws, ".codex", "hooks.json"))).toBe(false);
  });

  it("install aborts if the plugin payload gains a symlink after preview (TOCTOU)", () => {
    const ws = makeWorkspace();
    const pluginDir = makePlugin();
    const { plugin } = loadPlugin(pluginDir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors).toEqual([]);
    fs.symlinkSync("/etc/passwd", path.join(pluginDir, "claude", "evil")); // source tampered after consent
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws));
    expect(res.installed).toBe(false);
    expect(res.errors.some((e) => /symlink|changed/.test(e))).toBe(true);
    expect(fs.existsSync(SETTINGS(ws))).toBe(false); // nothing activated
  });
});

// ── end-to-end: a remote source-spec → fetch → install (real git, a local repo as the remote) ──
function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe.skipIf(!gitOk())("loadPluginFromSource → install (remote source end-to-end)", () => {
  it("clones a git source and installs the plugin into a workspace", async () => {
    // a real source repo holding one claude plugin
    const repo = tmp("src-repo-");
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    run(["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "tachyon-plugin.json"), JSON.stringify({ name: "remote-sdd", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" } }));
    fs.mkdirSync(path.join(repo, "claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` }] }] }));
    fs.writeFileSync(path.join(repo, "claude", "gate.sh"), "#!/bin/sh\n");
    run(["add", "-A"]); run(["commit", "-q", "-m", "init"]); run(["tag", "v1"]);

    const ws = makeWorkspace();
    // construct the GitSource via the engine bridge — the resolver rejects non-https remotes, so call the
    // fetcher path with a hand-built spec is not possible; instead exercise loadPluginFromSource by pointing
    // the fetcher at the local repo through a GitRun that maps the parsed https remote to the local path.
    const localGit = async (args: string[], cwd?: string) => {
      const mapped = args.map((a) => (a === "https://github.com/o/remote-sdd.git" ? repo : a));
      return await import("../../src/plugins/fetcher.js").then((m) => m.defaultGitRun(mapped, cwd));
    };
    const loaded = await loadPluginFromSource("github:o/remote-sdd@v1", localGit, { cacheRoot: tmp("cache-") });
    expect(loaded.errors).toEqual([]);
    expect(loaded.plugin?.manifest.name).toBe("remote-sdd");
    expect(loaded.provenance?.source.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);

    const res = applyInstall(loaded.plugin!, previewInstall(loaded.plugin!, ws, detectRuntimes(ws)), ws, detectRuntimes(ws), { provenance: loaded.provenance });
    expect(res.installed).toBe(true);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse[0].hooks[0].command).toContain("gate.sh");
    // provenance is pinned in the lockfile (byte-reproducible re-hydrate)
    const lock = readJson(LOCK(ws)).plugins["remote-sdd"];
    expect(lock.source).toMatchObject({ type: "git", spec: "github:o/remote-sdd@v1", resolvedCommit: loaded.provenance!.source.resolvedCommit });
    expect(lock.integrity).toMatchObject({ algorithm: "sha256" });
  });
});
