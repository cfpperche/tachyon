import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfileForgetSnapshot } from "../../src/agents/AgentManager.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import {
  agentProfileForgetBlocked,
  commitAgentProfileForget,
  reconcileAgentProfileForgets,
  retiredAgentProfileRoot,
  type AgentProfileForgetEvolutionPort,
} from "../../src/config/agentProfileForget.js";
import { commitAgentProfileLifecycle, type AgentProfileLifecycleConfigPort } from "../../src/config/agentProfileLifecycle.js";
import type { AgentProfileAuthorityPort } from "../../src/config/agentProfileTransactions.js";

const roots: string[] = [];

function temporaryWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-profile-forget-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  keeper:\n    cmd: sh\n");
  return root;
}

class MemoryAuthority implements AgentProfileAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  loseRetireAcknowledgement = false;
  async read(name: string) { const value = this.records.get(name); return value ? structuredClone(value) : undefined; }
  async publish(record: AgentProfileAuthorityRecord) {
    if (this.records.has(record.agentName)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord) {
    if (!isDeepStrictEqual(this.records.get(record.agentName), expected)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async retire(name: string, expected: AgentProfileAuthorityRecord) {
    if (!isDeepStrictEqual(this.records.get(name), expected)) throw new Error("authority CAS conflict");
    this.records.delete(name);
    if (this.loseRetireAcknowledgement) throw new Error("lost authority acknowledgement");
  }
}

function configPort(root: string): AgentProfileLifecycleConfigPort {
  const file = path.join(root, "tachyon.yml");
  return {
    read: () => fs.readFileSync(file, "utf8"),
    replace: (expected, text) => {
      const current = fs.readFileSync(file, "utf8");
      if (crypto.createHash("sha256").update(current).digest("hex") !== expected) throw new Error("config CAS conflict");
      fs.writeFileSync(file, text);
    },
  };
}

class MemoryEvolution implements AgentProfileForgetEvolutionPort {
  readonly profiles = new Map<string, string>();
  readonly retired: string[] = [];
  async readProfileId(name: string) { return this.profiles.get(name); }
  async retire(name: string, expectedProfileId: string | null) {
    expect(this.profiles.get(name) ?? null).toBe(expectedProfileId);
    if (!this.retired.includes(name)) this.retired.push(name);
  }
}

async function fixture() {
  const root = temporaryWorkspace();
  const authority = new MemoryAuthority();
  const config = configPort(root);
  const evolution = new MemoryEvolution();
  const created = await commitAgentProfileLifecycle({
    workspaceRoot: root,
    agentName: "reviewer",
    operation: "create",
    createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    authority,
    config,
    activateState: () => undefined,
  });
  evolution.profiles.set("reviewer", "evolution-1");
  const home = path.join(root, ".tachyon", "agents", "reviewer");
  fs.mkdirSync(path.join(home, "evolution"));
  fs.writeFileSync(path.join(home, "evolution", "profile.json"), '{"profileId":"evolution-1"}\n');
  fs.mkdirSync(path.join(home, "plugins", "future-plugin"), { recursive: true });
  fs.writeFileSync(path.join(home, "plugins", "future-plugin", "plugin.json"), "{}\n");
  const liveSnapshot: AgentProfileForgetSnapshot = {
    ledgerSha256: null,
    activity: { jsonlSha256: null, stateSha256: null },
  };
  const converged: string[] = [];
  const live = {
    prepare: async () => structuredClone(liveSnapshot),
    converge: async (_name: string, agentId: string, txid: string, snapshot: AgentProfileForgetSnapshot) => {
      expect(snapshot).toEqual(liveSnapshot);
      converged.push(`${agentId}:${txid}`);
    },
  };
  return { root, authority, config, evolution, created, home, live, converged };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical agent profile forget", () => {
  it("retires exact authorities and locator, quarantines the complete home, and permits fresh identity reuse", async () => {
    const input = await fixture();
    input.authority.loseRetireAcknowledgement = true;
    const result = await commitAgentProfileForget({
      workspaceRoot: input.root,
      agentName: "reviewer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live: input.live,
      activateState: () => undefined,
    });

    expect(input.authority.records.has("reviewer")).toBe(false);
    expect(input.config.read()).not.toContain("reviewer:");
    expect(fs.existsSync(input.home)).toBe(false);
    const retired = retiredAgentProfileRoot(input.root, result.agentId, result.txid);
    expect(fs.readFileSync(path.join(retired, "plugins", "future-plugin", "plugin.json"), "utf8")).toBe("{}\n");
    expect(input.evolution.retired).toEqual(["reviewer"]);
    expect(input.converged).toHaveLength(1);
    expect(agentProfileForgetBlocked(input.root, "reviewer")).toBe(false);
    const replacement = await commitAgentProfileLifecycle({
      workspaceRoot: input.root,
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
      authority: input.authority,
      config: input.config,
      activateState: () => undefined,
    });
    expect(replacement.snapshot.agentId).not.toBe(result.agentId);
    expect(fs.existsSync(retired)).toBe(true);
  });

  it("publishes admission intent before the stopped recheck and abandons safely on a race", async () => {
    const input = await fixture();
    let prepares = 0;
    await expect(commitAgentProfileForget({
      workspaceRoot: input.root,
      agentName: "reviewer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live: {
        ...input.live,
        prepare: async () => {
          prepares += 1;
          if (prepares === 2) {
            expect(agentProfileForgetBlocked(input.root, "reviewer")).toBe(true);
            throw new Error("session appeared");
          }
          return input.live.prepare();
        },
      },
      activateState: () => undefined,
    })).rejects.toThrow("session appeared");
    expect(agentProfileForgetBlocked(input.root, "reviewer")).toBe(false);
    expect(input.authority.records.has("reviewer")).toBe(true);
    expect(fs.existsSync(input.home)).toBe(true);
  });

  it("recovers only forward after an interruption beyond the commit decision", async () => {
    const input = await fixture();
    await expect(commitAgentProfileForget({
      workspaceRoot: input.root,
      agentName: "reviewer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live: input.live,
      activateState: () => undefined,
      onPhase: (phase) => { if (phase === "authority-retired") throw new Error("crash"); },
    })).rejects.toThrow("crash");
    expect(agentProfileForgetBlocked(input.root, "reviewer")).toBe(true);

    const recovered = await reconcileAgentProfileForgets({
      workspaceRoot: input.root,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live: input.live,
      activateState: () => undefined,
    });
    expect(recovered.reconciled).toHaveLength(1);
    expect(recovered.degraded).toEqual([]);
    expect(agentProfileForgetBlocked(input.root, "reviewer")).toBe(false);
    expect(input.config.read()).not.toContain("reviewer:");
  });

  it("degrades and retains changed config instead of deleting by name", async () => {
    const input = await fixture();
    await expect(commitAgentProfileForget({
      workspaceRoot: input.root,
      agentName: "reviewer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live: input.live,
      activateState: () => undefined,
      onPhase: (phase) => {
        if (phase === "authority-retired") fs.appendFileSync(path.join(input.root, "tachyon.yml"), "# external change\n");
      },
    })).rejects.toThrow("locator changed outside");
    expect(agentProfileForgetBlocked(input.root, "reviewer")).toBe(true);
    expect(input.config.read()).toContain("reviewer:");
    expect(fs.existsSync(input.home)).toBe(true);
  });
});
