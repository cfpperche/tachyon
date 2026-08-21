/**
 * t-54cdb2 — agent-scoped plugin dests write the private harness, never workspace-shared runtime dests.
 *
 * Red proof (must fail before the dest swap exists): a plugin installed for one isolated agent must
 * not appear in `.claude/skills` or `.mcp.json`.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectAgentIsolation,
  resolveInstallDests,
  overlayAgentPluginDests,
  materializeSkillDest,
  pluginSkillPayloadRel,
  agentSkillDestRel,
  agentClaudeMcpRel,
  WORKSPACE_DESTS,
} from "@tachyon/engine/plugins/agentDest.js";
import { parseLockfile, serializeLockfile, emptyLockfile } from "@tachyon/engine/plugins/lockfile.js";
import { harnessHome } from "@tachyon/engine/harness/HarnessManager.js";
import {
  loadPlugin,
  previewInstall,
  applyInstall,
  applyRemove,
  previewRemove,
  applyContribution,
  previewUpdate,
  applyUpdate,
  detectRuntimes,
  planSkillTargets,
} from "../../apps/vscode-extension/src/plugins/engine.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeProfile(ws: string, agent: string, adapter: string, extra = ""): void {
  const dir = path.join(ws, ".tachyon", "agents", agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent.yml"),
    `schemaVersion: 1\nagentId: ${agent}-id\ndisplayName: ${agent}\nruntime:\n  adapter: ${adapter}\n  executable: ${adapter}\n${extra}`,
  );
}

function makeSkillPlugin(name = "solo"): string {
  const dir = tmp("tachyon-plugin-");
  fs.writeFileSync(
    path.join(dir, "tachyon-plugin.json"),
    JSON.stringify({ name, version: "1.0.0", description: "agent dest", runtimes: ["claude"] }),
  );
  const skill = path.join(dir, "skills", name);
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: only for one agent\n---\n# ${name}\n`);
  return dir;
}

function makeSkillAndMcpPlugin(name = "wired"): string {
  const dir = makeSkillPlugin(name);
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({ servers: [{ name: "wired-db", transport: "stdio", command: "echo", args: ["ok"] }] }),
  );
  return dir;
}

describe("inspectAgentIsolation", () => {
  it("refuses a missing agent — never falls back to workspace dests", () => {
    const ws = tmp("tachyon-ws-");
    const r = inspectAgentIsolation(ws, "ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/);
  });

  it("refuses isolate:transcript — private configHome is not a complete harness", () => {
    const ws = tmp("tachyon-ws-");
    fs.writeFileSync(
      path.join(ws, "tachyon.yml"),
      "schemaVersion: 1\nagents:\n  slim:\n    kind: agent\n    cmd: claude\n    isolate: transcript\n    autostart: false\n    watch: []\n    attention:\n      enabled: false\n    restart: never\n",
    );
    const r = inspectAgentIsolation(ws, "slim");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isolate:transcript/);
  });

  it("accepts a canonical Claude profile as complete isolated harness", () => {
    const ws = tmp("tachyon-ws-");
    writeProfile(ws, "alice", "claude");
    const r = inspectAgentIsolation(ws, "alice");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.kind).toBe("canonical-profile");
      expect(r.identity.adapter).toBe("claude");
      expect(r.identity.destRootRel).toBe(".tachyon/harness/alice");
    }
  });

  it("accepts yaml harness:{} as complete isolated harness", () => {
    const ws = tmp("tachyon-ws-");
    fs.writeFileSync(
      path.join(ws, "tachyon.yml"),
      "schemaVersion: 1\nagents:\n  boxed:\n    kind: agent\n    cmd: claude\n    harness:\n      inherit: none\n      mcp: {}\n    autostart: false\n    watch: []\n    attention:\n      enabled: false\n    restart: never\n",
    );
    const r = inspectAgentIsolation(ws, "boxed");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("yaml-harness");
  });
});

describe("resolveInstallDests", () => {
  it("workspace scope keeps the measured project dests", () => {
    const ws = tmp("tachyon-ws-");
    const r = resolveInstallDests(ws, { type: "workspace" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.dests.claude).toEqual(WORKSPACE_DESTS.claude);
    expect(r.identity).toBeNull();
  });

  it("Claude agent dests live under the private harness, not .claude/skills or .mcp.json", () => {
    const ws = tmp("tachyon-ws-");
    writeProfile(ws, "alice", "claude");
    const r = resolveInstallDests(ws, { type: "agent", name: "alice" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.dests.claude.skillsRel).toBe(".tachyon/harness/alice/skills");
    expect(r.dests.claude.mcpRel).toBe(".tachyon/harness/alice/mcp.json");
    expect(r.dests.claude.settingsRel).toBe(".tachyon/harness/alice/settings.json");
    expect(r.dests.claude.skillsRel).not.toBe(".claude/skills");
    expect(r.dests.claude.mcpRel).not.toBe(".mcp.json");
  });

  it("Codex agent dests isolate MCP under CODEX_HOME and refuse a skill dest (no isolated discovery root)", () => {
    const ws = tmp("tachyon-ws-");
    writeProfile(ws, "coder", "codex");
    const r = resolveInstallDests(ws, { type: "agent", name: "coder" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.dests.codex.skillsRel).toBeNull();
    expect(r.dests.codex.mcpRel).toBe(".tachyon/harness/coder/config.toml");
    expect(r.dests.codex.mcpRel).not.toBe(".codex/config.toml");
  });
});

describe("lockfile dest scope", () => {
  it("round-trips an agent dest target and leaves old workspace targets unscoped", () => {
    const lock = emptyLockfile();
    lock.plugins.solo = {
      name: "solo",
      version: "1.0.0",
      runtimes: ["claude"],
      targets: [
        { runtime: "claude", kind: "skill-dir", file: ".claude/skills/solo" },
        { runtime: "claude", kind: "skill-dir", file: ".tachyon/harness/alice/skills/solo", scope: { type: "agent", name: "alice" } },
      ],
    };
    const { lockfile, errors } = parseLockfile(serializeLockfile(lock));
    expect(errors).toEqual([]);
    expect(lockfile?.plugins.solo.targets[0]?.scope).toBeUndefined();
    expect(lockfile?.plugins.solo.targets[1]?.scope).toEqual({ type: "agent", name: "alice" });
  });
});

describe("two-agent dest bytes", () => {
  it("two dests share the payload via symlink — no extra plugin bytes", () => {
    const ws = tmp("tachyon-ws-");
    const payload = path.join(ws, pluginSkillPayloadRel("solo", "solo"));
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, "SKILL.md"), "# solo\n" + "x".repeat(4096));
    const payloadBytes = fs.statSync(path.join(payload, "SKILL.md")).size;
    const a = path.join(ws, agentSkillDestRel("alice", "solo"));
    const b = path.join(ws, agentSkillDestRel("bob", "solo"));
    materializeSkillDest(payload, a, "link");
    materializeSkillDest(payload, b, "link");
    expect(fs.lstatSync(a).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(b).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(a)).toBe(fs.realpathSync(payload));
    expect(fs.realpathSync(b)).toBe(fs.realpathSync(payload));
    const extra = fs.lstatSync(a).size + fs.lstatSync(b).size;
    expect(extra).toBeLessThan(payloadBytes);
    expect(fs.readFileSync(path.join(a, "SKILL.md")).length).toBe(payloadBytes);
  });
});

describe("overlayAgentPluginDests", () => {
  it("merges a missing plugin MCP without overwriting tachyon_bridge", () => {
    const ws = tmp("tachyon-ws-");
    const mcpRel = agentClaudeMcpRel("alice");
    const mcpAbs = path.join(ws, mcpRel);
    fs.mkdirSync(path.dirname(mcpAbs), { recursive: true });
    fs.writeFileSync(mcpAbs, JSON.stringify({ mcpServers: { tachyon_bridge: { url: "http://bridge" } } }, null, 2));
    const lock = emptyLockfile();
    lock.plugins.wired = {
      name: "wired",
      version: "1.0.0",
      runtimes: ["claude"],
      targets: [
        { runtime: "claude", kind: "mcp-server", file: mcpRel, ref: "wired-db", removal: { command: "echo" }, scope: { type: "agent", name: "alice" } },
      ],
    };
    fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".tachyon/plugins.lock.json"), serializeLockfile(lock));
    overlayAgentPluginDests(ws, "alice");
    const body = JSON.parse(fs.readFileSync(mcpAbs, "utf8"));
    expect(body.mcpServers.tachyon_bridge).toEqual({ url: "http://bridge" });
    expect(body.mcpServers["wired-db"]).toEqual({ command: "echo" });
  });

  it("re-links a wiped harness dest from the lockfile without touching workspace dests", () => {
    const ws = tmp("tachyon-ws-");
    writeProfile(ws, "alice", "claude");
    const payload = path.join(ws, pluginSkillPayloadRel("solo", "solo"));
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, "SKILL.md"), "# solo\n");
    const lock = emptyLockfile();
    lock.plugins.solo = {
      name: "solo",
      version: "1.0.0",
      runtimes: ["claude"],
      targets: [
        { runtime: "claude", kind: "skill-dir", file: ".tachyon/harness/alice/skills/solo", scope: { type: "agent", name: "alice" } },
      ],
    };
    fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".tachyon/plugins.lock.json"), serializeLockfile(lock));
    overlayAgentPluginDests(ws, "alice");
    const dest = path.join(ws, agentSkillDestRel("alice", "solo"));
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/solo"))).toBe(false);
  });
});

describe("applyInstall agent dest — red proof", () => {
  it("FAIL-BEFORE: the unscoped planner still emits the shared dest the leak uses", () => {
    const dir = makeSkillPlugin("solo");
    const { plugin } = loadPlugin(dir);
    const dests = planSkillTargets(plugin!, new Set(["claude"] as const)).map((t) => t.destRel);
    expect(dests).toEqual([".claude/skills/solo"]);
  });

  it("a plugin authorized only for one agent must not appear in .claude/skills or .mcp.json", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const dir = makeSkillAndMcpPlugin("solo");
    const { plugin } = loadPlugin(dir);
    expect(plugin).toBeTruthy();
    const target = detectRuntimes(ws);
    const scope = { type: "agent" as const, name: "alice" };
    const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    expect(preview.errors).toEqual([]);
    expect(preview.skillTargets.map((t) => t.destRel)).toEqual([".tachyon/harness/alice/skills/solo"]);
    expect(preview.mcpTargets.map((t) => t.destRel)).toEqual([".tachyon/harness/alice/mcp.json"]);
    const applied = await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true, scope });
    expect(applied.installed).toBe(true);
    expect(applied.errors).toEqual([]);
    for (const skill of plugin!.skills) {
      applyContribution(plugin!.manifest.name, { kind: "skill", name: skill.name }, ws, { replace: true });
    }
    for (const server of plugin!.mcp) {
      applyContribution(plugin!.manifest.name, { kind: "mcp", name: server.name }, ws);
    }

    expect(fs.existsSync(path.join(ws, ".claude/skills/solo")), "RED: agent dest leaked into shared .claude/skills").toBe(false);
    expect(fs.existsSync(path.join(ws, ".mcp.json")), "RED: agent dest leaked into workspace .mcp.json").toBe(false);
    const dest = path.join(ws, agentSkillDestRel("alice", "solo"));
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, agentClaudeMcpRel("alice")))).toBe(true);
    expect(harnessHome(ws, "alice")).toBe(path.join(ws, ".tachyon/harness/alice"));
  });

  it("apply refuses a preview consented for a different dest scope", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const { plugin } = loadPlugin(makeSkillPlugin("solo"));
    const target = detectRuntimes(ws);
    const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, { type: "agent", name: "alice" });
    const applied = await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true });
    expect(applied.installed).toBe(false);
    expect(applied.errors.some((e) => /workspace changed since preview|scope/.test(e))).toBe(true);
  });

  it("two agents keep two dests and one shared payload — second install does not wipe the first", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    writeProfile(ws, "bob", "claude");
    const dir = makeSkillPlugin("solo");
    const { plugin } = loadPlugin(dir);
    const target = detectRuntimes(ws);
    for (const name of ["alice", "bob"] as const) {
      const scope = { type: "agent" as const, name };
      const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
      expect(preview.errors, name).toEqual([]);
      const applied = await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true, scope });
      expect(applied.installed, name).toBe(true);
      applyContribution(plugin!.manifest.name, { kind: "skill", name: "solo" }, ws, { replace: true });
    }
    const a = path.join(ws, agentSkillDestRel("alice", "solo"));
    const b = path.join(ws, agentSkillDestRel("bob", "solo"));
    expect(fs.existsSync(path.join(a, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(b, "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(a).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(b).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(a)).toBe(fs.realpathSync(b));
    expect(fs.existsSync(path.join(ws, ".claude/skills/solo"))).toBe(false);
    const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
    const dests = lock.plugins.solo.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file).sort();
    expect(dests).toEqual([".tachyon/harness/alice/skills/solo", ".tachyon/harness/bob/skills/solo"]);
  });

  it("fingerprint fails closed when the agent's harness identity changes between preview and apply", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const { plugin } = loadPlugin(makeSkillPlugin("solo"));
    const target = detectRuntimes(ws);
    const scope = { type: "agent" as const, name: "alice" };
    const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    expect(preview.errors).toEqual([]);
    fs.rmSync(path.join(ws, ".tachyon/agents/alice"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(ws, "tachyon.yml"),
      "schemaVersion: 1\nagents:\n  alice:\n    kind: agent\n    cmd: claude\n    isolate: transcript\n    autostart: false\n    watch: []\n    attention:\n      enabled: false\n    restart: never\n",
    );
    const applied = await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true, scope });
    expect(applied.installed).toBe(false);
    expect(applied.errors.length).toBeGreaterThan(0);
  });

  it("remove deletes the harness dest and never creates a shared dest", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const { plugin } = loadPlugin(makeSkillPlugin("solo"));
    const target = detectRuntimes(ws);
    const scope = { type: "agent" as const, name: "alice" };
    const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true, scope });
    applyContribution(plugin!.manifest.name, { kind: "skill", name: "solo" }, ws, { replace: true });
    expect(fs.existsSync(path.join(ws, agentSkillDestRel("alice", "solo")))).toBe(true);
    const fp = previewRemove("solo", ws).fingerprint;
    expect((await applyRemove("solo", ws, { expectedFingerprint: fp })).removed).toBe(true);
    expect(fs.existsSync(path.join(ws, agentSkillDestRel("alice", "solo")))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".claude/skills/solo"))).toBe(false);
  });

  it("agent dest hooks and MCP do not write workspace .claude/settings.json or .mcp.json", async () => {
    const dir = tmp("tachyon-plugin-");
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({
      name: "wired",
      version: "1.0.0",
      description: "hooks+mcp",
      runtimes: ["claude"],
      blocks: { claude: "claude/" },
    }));
    fs.mkdirSync(path.join(dir, "claude"));
    fs.writeFileSync(path.join(dir, "claude/hooks.json"), JSON.stringify({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }],
    }));
    fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({
      servers: [{ name: "wired-db", transport: "stdio", command: "echo", args: ["ok"] }],
    }));
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const { plugin } = loadPlugin(dir);
    const target = detectRuntimes(ws);
    const scope = { type: "agent" as const, name: "alice" };
    const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    expect(preview.errors).toEqual([]);
    const applied = await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true, scope });
    expect(applied.installed).toBe(true);
    applyContribution("wired", { kind: "hook", name: "PreToolUse" }, ws);
    applyContribution("wired", { kind: "mcp", name: "wired-db" }, ws);
    expect(fs.existsSync(path.join(ws, ".claude/settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tachyon/harness/alice/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, agentClaudeMcpRel("alice")))).toBe(true);
  });

  it("Codex agent dest writes private config.toml and not .codex/config.toml", async () => {
    const dir = tmp("tachyon-plugin-");
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({
      name: "cx",
      version: "1.0.0",
      description: "codex mcp",
      runtimes: ["codex"],
    }));
    fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({
      servers: [{ name: "cx-db", transport: "stdio", command: "echo", args: ["ok"] }],
    }));
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
    writeProfile(ws, "coder", "codex");
    const { plugin } = loadPlugin(dir);
    const target = new Set(["codex"] as const);
    const scope = { type: "agent" as const, name: "coder" };
    const preview = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    expect(preview.errors).toEqual([]);
    expect(preview.skillTargets).toEqual([]);
    expect(preview.mcpTargets.map((t) => t.destRel)).toEqual([".tachyon/harness/coder/config.toml"]);
    const applied = await applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true, scope });
    expect(applied.installed).toBe(true);
    applyContribution("cx", { kind: "mcp", name: "cx-db" }, ws);
    expect(fs.existsSync(path.join(ws, ".codex/config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tachyon/harness/coder/config.toml"))).toBe(true);
  });
});

describe("update keeps dest scope (t-cd4406)", () => {
  it("updating an agent-scoped install keeps the agent dest — no silent workspace promotion", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const dir = makeSkillPlugin("solo"); // v1.0.0
    const { plugin } = loadPlugin(dir);
    const target = detectRuntimes(ws);
    const scope = { type: "agent" as const, name: "alice" };
    const preview1 = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    expect(preview1.errors).toEqual([]);
    const applied1 = await applyInstall(plugin!, preview1, ws, target, { scope });
    expect(applied1.installed).toBe(true);
    // SDD 486 — install records the skill target; applying the contribution materializes the dest.
    applyContribution("solo", { kind: "skill", name: "solo" }, ws, { replace: true });
    expect(fs.existsSync(path.join(ws, agentSkillDestRel("alice", "solo"), "SKILL.md"))).toBe(true);

    // v2 of the SAME plugin, then update it in place under its own dest scope.
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name: "solo", version: "2.0.0", description: "agent dest v2", runtimes: ["claude"] }));
    const v2 = loadPlugin(dir).plugin!;
    const res = await applyUpdate(v2, ws, { scope });
    expect(res.updated, res.errors.join("; ")).toBe(true);

    // the agent dest survived and was refreshed; the shared workspace dest was NEVER created
    const harnessSkill = path.join(ws, agentSkillDestRel("alice", "solo"));
    expect(fs.existsSync(path.join(harnessSkill, "SKILL.md")), "agent dest lost by the update").toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/solo")), "RED: update promoted the agent install into shared .claude/skills").toBe(false);
    // lockfile: updated version recorded under the agent scope only — no unscoped duplicate target
    const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
    expect(lock.plugins.solo.version).toBe("2.0.0");
    const skillTargets = lock.plugins.solo.targets.filter((t: { kind: string }) => t.kind === "skill-dir");
    expect(skillTargets.map((t: { file: string }) => t.file)).toEqual([".tachyon/harness/alice/skills/solo"]);
    expect(skillTargets[0].scope).toEqual({ type: "agent", name: "alice" });
  });

  it("apply refuses a fingerprint consented for a different dest scope, like install does", async () => {
    const ws = tmp("tachyon-ws-");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    writeProfile(ws, "alice", "claude");
    const dir = makeSkillPlugin("solo");
    const { plugin } = loadPlugin(dir);
    const target = detectRuntimes(ws);
    const scope = { type: "agent" as const, name: "alice" };
    const preview1 = previewInstall(plugin!, ws, target, undefined, undefined, undefined, scope);
    expect(preview1.errors).toEqual([]);
    expect((await applyInstall(plugin!, preview1, ws, target, { scope })).installed).toBe(true);

    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name: "solo", version: "2.0.0", description: "agent dest v2", runtimes: ["claude"] }));
    const v2 = loadPlugin(dir).plugin!;

    // the preview plans the AGENT dest (scope propagated into the install plan)…
    const upd = await previewUpdate(v2, ws, undefined, { scope });
    expect(upd.errors).toEqual([]);
    expect(upd.install?.scope).toEqual(scope);
    expect(upd.install!.skillTargets.map((t) => t.destRel)).toEqual([".tachyon/harness/alice/skills/solo"]);
    // …so an apply that re-derives under another scope cannot match the consented fingerprint → refuse
    const refused = await applyUpdate(v2, ws, { expectedFingerprint: upd.install!.fingerprint });
    expect(refused.updated).toBe(false);
    expect(refused.errors.some((e) => /workspace changed since preview|scope/.test(e))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/solo"))).toBe(false);
    // and the matching-scope apply with that same fingerprint goes through
    const ok = await applyUpdate(v2, ws, { scope, expectedFingerprint: upd.install!.fingerprint });
    expect(ok.updated, ok.errors.join("; ")).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude/skills/solo"))).toBe(false);
  });
});
