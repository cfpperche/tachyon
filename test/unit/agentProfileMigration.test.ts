import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitLegacyAgentProfileMigration,
  listRollbackableAgentProfileMigrations,
  planLegacyAgentProfileMigration,
  reconcileAgentProfileMigrations,
  rollbackLegacyAgentProfileMigration,
  type AgentProfileMigrationAuthorityPort,
} from "../../src/config/agentProfileMigration.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-profile-migrate-"));
  roots.push(root);
  return root;
}

class MemoryAuthority implements AgentProfileMigrationAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  failAfterPublish = false;
  async read(agentName: string): Promise<AgentProfileAuthorityRecord | undefined> {
    return this.records.get(agentName);
  }
  async publish(record: AgentProfileAuthorityRecord, expected: undefined): Promise<void> {
    expect(expected).toBeUndefined();
    if (this.records.has(record.agentName)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
    if (this.failAfterPublish) throw new Error("injected publish acknowledgement failure");
  }
  async retire(agentName: string, expected: AgentProfileAuthorityRecord): Promise<void> {
    expect(this.records.get(agentName)).toEqual(expected);
    this.records.delete(agentName);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("planLegacyAgentProfileMigration", () => {
  it("builds an equivalent strict Codex profile without touching workspace bytes", () => {
    const root = workspace();
    const configText = [
      "# keep top",
      "agents:",
      "  codex:",
      "    # keep local",
      "    cmd: codex",
      "    cwd: packages/app",
      "    env:",
      "      MODE: strict",
      "    autostart: true",
      "    attention:",
      "      silenceSec: 12",
      "    restart: on-crash",
      "    role: reviewer",
      "    worktree: true",
      "    branch: tachyon/codex",
      "    isolate: transcript",
      "  helper:",
      "    cmd: claude",
      "settings:",
      "  auth: false",
      "",
    ].join("\n");
    const result = planLegacyAgentProfileMigration({
      workspaceRoot: root,
      configText,
      agentName: "codex",
      nonSecretEnv: ["MODE"],
      agentId: "11111111-1111-4111-8111-111111111111",
      authorityRevision: "test-r1",
    });
    expect(result.ok, result.ok ? undefined : result.blockers.join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.plan.projectedDefinition).toEqual(result.plan.originalDefinition);
    expect(result.plan.profile).toMatchObject({
      agentId: "11111111-1111-4111-8111-111111111111",
      runtime: { adapter: "codex", executable: "codex" },
      environment: { values: { MODE: "strict" } },
      prompt: { role: "reviewer" },
      workspace: { cwd: "packages/app", worktree: { enabled: true, branch: "tachyon/codex" } },
    });
    expect(result.plan.source.valueText).toContain("cmd: codex");
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
  });

  it("refuses deferred fields and unclassified environment values without partial output", () => {
    const root = workspace();
    const result = planLegacyAgentProfileMigration({
      workspaceRoot: root,
      configText: "agents:\n  codex:\n    cmd: codex\n    instructions: keep me\n    selfEvolution: { enabled: true }\n    env: { TOKEN: literal }\n",
      agentName: "codex",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.join("\n")).toContain("persistent instructions are owned by t-a2827d");
    expect(result.blockers.join("\n")).toContain("Agent Evolution is owned by t-a2827d");
    expect(result.blockers.join("\n")).toContain("classify every key explicitly as non-secret");
  });

  it("refuses unsupported commands, aliases, existing profile bytes, and existing authority", () => {
    const root = workspace();
    const profileDir = path.join(root, ".tachyon", "agents", "codex");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "agent.yml"), "occupied\n");
    const result = planLegacyAgentProfileMigration({
      workspaceRoot: root,
      configText: "agents:\n  codex: &codex\n    cmd: codex --model x\n",
      agentName: "codex",
      currentAuthority: {
        schemaVersion: 1,
        agentName: "codex",
        agentId: "11111111-1111-4111-8111-111111111111",
        revision: "r1",
        canonicalSha256: "a".repeat(64),
        runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: "b".repeat(64) },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.join("\n")).toContain("exact literal 'codex'");
    expect(result.blockers.join("\n")).toContain("anchors are not supported");
    expect(result.blockers.join("\n")).toContain("canonical agent.yml already exists");
    expect(result.blockers.join("\n")).toContain("host profile authority already exists");
  });
});

describe("agent profile migration transaction", () => {
  function fixture() {
    const root = workspace();
    const homeDir = workspace();
    const configPath = path.join(root, "tachyon.yml");
    const configText = "# top\nagents:\n  codex:\n    # local\n    cmd: codex\n    role: reviewer\n  helper:\n    cmd: claude\nsettings:\n  auth: false # tail\n";
    fs.writeFileSync(configPath, configText);
    const planned = planLegacyAgentProfileMigration({
      workspaceRoot: root,
      configText,
      agentName: "codex",
      agentId: "11111111-1111-4111-8111-111111111111",
      authorityRevision: "test-r1",
    });
    expect(planned.ok, planned.ok ? undefined : planned.blockers.join("\n")).toBe(true);
    if (!planned.ok) throw new Error("expected migration plan");
    return { workspaceRoot: root, homeDir, configPath, configText, plan: planned.plan, authority: new MemoryAuthority() };
  }

  it("dogfood: commits and rolls back an isolated profile fixture while preserving outside bytes", async () => {
    const f = fixture();
    let stopped = 0;
    const committed = await commitLegacyAgentProfileMigration({
      ...f,
      assertStopped: async (name) => { expect(name).toBe("codex"); stopped++; },
    });
    expect(committed.phase).toBe("committed");
    expect(stopped).toBe(1);
    const migrated = fs.readFileSync(f.configPath, "utf8");
    expect(migrated.slice(0, f.plan.source.valueStart)).toBe(f.configText.slice(0, f.plan.source.valueStart));
    expect(migrated).toContain("profile: .tachyon/agents/codex/agent.yml");
    expect(migrated).toContain("settings:\n  auth: false # tail");
    expect(fs.readFileSync(path.join(f.workspaceRoot, ".tachyon", "agents", "codex", "agent.yml"), "utf8")).toBe(f.plan.profileText);
    expect(await f.authority.read("codex")).toEqual(f.plan.authority);
    expect(listRollbackableAgentProfileMigrations(f.workspaceRoot)).toEqual([
      expect.objectContaining({ txid: committed.txid, agentName: "codex" }),
    ]);

    const rolledBack = await rollbackLegacyAgentProfileMigration({
      workspaceRoot: f.workspaceRoot,
      configPath: f.configPath,
      authority: f.authority,
      txid: committed.txid,
      assertStopped: async () => { stopped++; },
    });
    expect(rolledBack.phase).toBe("rolled-back");
    expect(stopped).toBe(2);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.configText);
    expect(fs.existsSync(path.join(f.workspaceRoot, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    expect(await f.authority.read("codex")).toBeUndefined();
    expect(listRollbackableAgentProfileMigrations(f.workspaceRoot)).toEqual([]);
  });

  it("compensates an authority acknowledgement failure without changing config", async () => {
    const f = fixture();
    f.authority.failAfterPublish = true;
    await expect(commitLegacyAgentProfileMigration(f)).rejects.toThrow("injected publish acknowledgement failure");
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.configText);
    expect(fs.existsSync(path.join(f.workspaceRoot, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    expect(await f.authority.read("codex")).toBeUndefined();
  });

  it("refuses rollback after later profile edits", async () => {
    const f = fixture();
    const committed = await commitLegacyAgentProfileMigration(f);
    fs.appendFileSync(path.join(f.workspaceRoot, ".tachyon", "agents", "codex", "agent.yml"), "# later\n");
    await expect(rollbackLegacyAgentProfileMigration({
      workspaceRoot: f.workspaceRoot,
      configPath: f.configPath,
      authority: f.authority,
      txid: committed.txid,
    })).rejects.toThrow("canonical profile changed after migration");
    expect(fs.readFileSync(f.configPath, "utf8")).toContain("profile: .tachyon/agents/codex/agent.yml");
    expect(await f.authority.read("codex")).toEqual(f.plan.authority);
  });

  it("preserves unrelated config edits made after commit during rollback", async () => {
    const f = fixture();
    const committed = await commitLegacyAgentProfileMigration(f);
    const later = fs.readFileSync(f.configPath, "utf8").replace("auth: false", "auth: true");
    fs.writeFileSync(f.configPath, later);
    await rollbackLegacyAgentProfileMigration({
      workspaceRoot: f.workspaceRoot,
      configPath: f.configPath,
      authority: f.authority,
      txid: committed.txid,
    });
    const restored = fs.readFileSync(f.configPath, "utf8");
    expect(restored).toContain("cmd: codex");
    expect(restored).toContain("auth: true");
  });

  it("reconciles crash-shaped partial and complete tuples deterministically", async () => {
    const partial = fixture();
    const first = await commitLegacyAgentProfileMigration(partial);
    const firstJournal = path.join(partial.workspaceRoot, ".tachyon", "agent-profile-migrations", first.txid, "journal.json");
    const firstRecord = JSON.parse(fs.readFileSync(firstJournal, "utf8")) as Record<string, unknown>;
    firstRecord.phase = "authority-published";
    fs.writeFileSync(firstJournal, `${JSON.stringify(firstRecord, null, 2)}\n`);
    fs.writeFileSync(partial.configPath, partial.configText);
    const compensated = await reconcileAgentProfileMigrations(partial);
    expect(compensated).toEqual({ reconciled: [first.txid], degraded: [] });
    expect(await partial.authority.read("codex")).toBeUndefined();
    expect(fs.existsSync(path.join(partial.workspaceRoot, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(firstJournal, "utf8")).phase).toBe("rolled-back");

    const complete = fixture();
    const second = await commitLegacyAgentProfileMigration(complete);
    const secondJournal = path.join(complete.workspaceRoot, ".tachyon", "agent-profile-migrations", second.txid, "journal.json");
    const secondRecord = JSON.parse(fs.readFileSync(secondJournal, "utf8")) as Record<string, unknown>;
    secondRecord.phase = "config-written";
    fs.writeFileSync(secondJournal, `${JSON.stringify(secondRecord, null, 2)}\n`);
    const finished = await reconcileAgentProfileMigrations(complete);
    expect(finished).toEqual({ reconciled: [second.txid], degraded: [] });
    expect(JSON.parse(fs.readFileSync(secondJournal, "utf8")).phase).toBe("committed");
  });

  it("serializes concurrent migration attempts for one principal", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      commitLegacyAgentProfileMigration(f),
      commitLegacyAgentProfileMigration(f),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fs.readFileSync(f.configPath, "utf8")).toContain("profile: .tachyon/agents/codex/agent.yml");
    expect(await f.authority.read("codex")).toEqual(f.plan.authority);
    expect(fs.readFileSync(path.join(f.workspaceRoot, ".tachyon", "agents", "codex", "agent.yml"), "utf8")).toBe(f.plan.profileText);
  });
});
