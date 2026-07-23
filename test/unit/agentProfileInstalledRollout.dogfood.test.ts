import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitLegacyAgentProfileMigration,
  planLegacyAgentProfileMigration,
  reconcileAgentProfileMigrations,
  rollbackLegacyAgentProfileMigration,
  type AgentProfileMigrationAuthorityPort,
  type LegacyAgentProfileMigrationPlan,
} from "../../src/config/agentProfileMigration.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";

const roots: string[] = [];
const INSTALLED = ["claude", "claude-orca", "codex", "grok", "grok-workflow", "grok-x"] as const;

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function selector() {
  const text = `${JSON.stringify({ schemaVersion: 1, profileId: "evolution-profile-codex" }, null, 2)}\n`;
  return { profileId: "evolution-profile-codex", text, sha256: crypto.createHash("sha256").update(text).digest("hex") };
}

class MirrorAuthority implements AgentProfileMigrationAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  async read(agentName: string) { return this.records.get(agentName); }
  async publish(record: AgentProfileAuthorityRecord, expected: undefined) {
    expect(expected).toBeUndefined();
    if (this.records.has(record.agentName)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord) {
    expect(this.records.get(record.agentName)).toEqual(expected);
    this.records.set(record.agentName, structuredClone(record));
  }
  async retire(agentName: string, expected: AgentProfileAuthorityRecord) {
    expect(this.records.get(agentName)).toEqual(expected);
    this.records.delete(agentName);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("installed agent profile rollout mirror", () => {
  it("migrates six agents sequentially and resumes from a durable checkpoint", async () => {
    const workspaceRoot = temporaryRoot("tachyon-installed-rollout-");
    const homeDir = temporaryRoot("tachyon-installed-rollout-home-");
    const configPath = path.join(workspaceRoot, "tachyon.yml");
    fs.writeFileSync(configPath, [
      "agents:",
      "  claude:",
      "    cmd: claude",
      "  claude-orca:",
      "    cmd: claude",
      "  codex:",
      "    cmd: codex",
      "    selfEvolution: { enabled: true }",
      "  grok:",
      "    cmd: grok",
      "  grok-workflow:",
      "    cmd: grok",
      "  grok-x:",
      "    cmd: grok",
      "    cwd: /home/goat/monetizacao-x",
      "settings:",
      "  auth: false",
      "",
    ].join("\n"));
    const pluginLock = path.join(workspaceRoot, ".tachyon", "plugins", "lock.json");
    const pluginBytes = Buffer.from("{\"version\":1,\"plugins\":[\"visual-qa\"]}\n");
    fs.mkdirSync(path.dirname(pluginLock), { recursive: true });
    fs.writeFileSync(pluginLock, pluginBytes);

    const authority = new MirrorAuthority();
    const stopped: string[] = [];
    const txids = new Map<string, string>();
    const migrate = async (agentName: typeof INSTALLED[number]) => {
      const configText = fs.readFileSync(configPath, "utf8");
      const index = INSTALLED.indexOf(agentName);
      const result = planLegacyAgentProfileMigration({
        workspaceRoot,
        configText,
        agentName,
        existingAuthorities: authority.records,
        homeDir,
        agentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ...(agentName === "codex" ? { evolutionSelector: selector() } : {}),
      });
      expect(result.ok, result.ok ? undefined : result.blockers.join("\n")).toBe(true);
      if (!result.ok) throw new Error(`mirror plan failed for ${agentName}`);
      const committed = await commitLegacyAgentProfileMigration({
        workspaceRoot,
        configPath,
        homeDir,
        authority,
        plan: result.plan,
        assertStopped: async (target) => { stopped.push(target); },
      });
      txids.set(agentName, committed.txid);
      return result.plan;
    };

    for (const agentName of INSTALLED.slice(0, 3)) await migrate(agentName);
    const checkpointPath = path.join(workspaceRoot, ".tachyon", "agent-profile-rollout-checkpoint.json");
    fs.writeFileSync(checkpointPath, `${JSON.stringify({
      schemaVersion: 1,
      completed: INSTALLED.slice(0, 3),
      next: INSTALLED[3],
    }, null, 2)}\n`);

    expect(await reconcileAgentProfileMigrations({ workspaceRoot, configPath, authority }))
      .toEqual({ reconciled: [], degraded: [] });
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
      completed: string[];
      next: typeof INSTALLED[number];
    };
    for (const agentName of INSTALLED.slice(checkpoint.completed.length)) await migrate(agentName);

    const rollbackTarget = "grok-workflow";
    await rollbackLegacyAgentProfileMigration({
      workspaceRoot,
      configPath,
      authority,
      txid: txids.get(rollbackTarget)!,
      assertStopped: async (target) => { stopped.push(target); },
    });
    const remigrated: LegacyAgentProfileMigrationPlan = await migrate(rollbackTarget);

    const finalConfig = parseYaml(fs.readFileSync(configPath, "utf8")) as {
      agents: Record<string, Record<string, unknown>>;
    };
    for (const agentName of INSTALLED) {
      expect(finalConfig.agents[agentName]).toEqual({
        profile: `.tachyon/agents/${agentName}/agent.yml`,
      });
      expect(authority.records.get(agentName)?.agentName).toBe(agentName);
      expect(fs.existsSync(path.join(workspaceRoot, ".tachyon", "agents", agentName, "agent.yml"))).toBe(true);
    }
    expect(remigrated.profile.runtime.adapter).toBe("grok");
    expect(stopped).toEqual([...INSTALLED, rollbackTarget, rollbackTarget]);
    expect(fs.readFileSync(pluginLock)).toEqual(pluginBytes);
  });
});
