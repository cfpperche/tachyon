import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import { commitAgentProfileLifecycle, type AgentProfileLifecycleConfigPort } from "../../src/config/agentProfileLifecycle.js";
import {
  acquireAgentProfileTransactionLock,
  acquireAgentProfileTransactionLocks,
  type AgentProfileAuthorityPort,
} from "../../src/config/agentProfileTransactions.js";
import {
  agentProfileRenameBlocked,
  commitAgentProfileRename,
  reconcileAgentProfileRenames,
  type AgentProfileRenameEvolutionPort,
} from "../../src/config/agentProfileRename.js";

const roots: string[] = [];

function temporaryWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-profile-rename-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  return root;
}

class MemoryAuthority implements AgentProfileAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  loseMoveAcknowledgement = false;
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
  }
  async move(oldName: string, newName: string, expected: AgentProfileAuthorityRecord, target: AgentProfileAuthorityRecord) {
    const source = this.records.get(oldName);
    const destination = this.records.get(newName);
    if (!source && isDeepStrictEqual(destination, target)) return;
    if (!isDeepStrictEqual(source, expected) || destination) throw new Error("authority CAS conflict");
    this.records.delete(oldName);
    this.records.set(newName, structuredClone(target));
    if (this.loseMoveAcknowledgement) throw new Error("lost authority acknowledgement");
  }
}

function configPort(root: string): AgentProfileLifecycleConfigPort {
  const file = path.join(root, "tachyon.yml");
  return {
    read: () => fs.readFileSync(file, "utf8"),
    replace: (expected, text) => {
      const current = fs.readFileSync(file, "utf8");
      const actual = crypto.createHash("sha256").update(current).digest("hex");
      if (actual !== expected) throw new Error("config CAS conflict");
      fs.writeFileSync(file, text);
    },
  };
}

class MemoryEvolution implements AgentProfileRenameEvolutionPort {
  constructor(private readonly root: string) {}
  readonly profiles = new Map<string, string>();
  async readProfileId(name: string) { return this.profiles.get(name); }
  async rename(oldName: string, newName: string) {
    const profileId = this.profiles.get(oldName);
    if (!profileId) return false;
    if (this.profiles.has(newName)) throw new Error("evolution conflict");
    const oldRoot = path.join(this.root, ".tachyon", "agents", oldName, "evolution");
    const newRoot = path.join(this.root, ".tachyon", "agents", newName, "evolution");
    fs.renameSync(oldRoot, newRoot);
    this.profiles.delete(oldName);
    this.profiles.set(newName, profileId);
    return true;
  }
}

async function fixture() {
  const root = temporaryWorkspace();
  const authority = new MemoryAuthority();
  const config = configPort(root);
  const evolution = new MemoryEvolution(root);
  const created = await commitAgentProfileLifecycle({
    workspaceRoot: root,
    agentName: "reviewer",
    operation: "create",
    createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    authority,
    config,
    activateState: () => undefined,
  });
  evolution.profiles.set("reviewer", "profile-1");
  const evolutionRoot = path.join(root, ".tachyon", "agents", "reviewer", "evolution");
  fs.mkdirSync(evolutionRoot);
  fs.writeFileSync(path.join(evolutionRoot, "profile.json"), '{"profileId":"profile-1"}\n');
  return { root, authority, config, evolution, created };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical agent profile rename", () => {
  it("uses one normalized lock namespace and a deterministic two-name order", () => {
    const root = temporaryWorkspace();
    const release = acquireAgentProfileTransactionLocks(root, ["Reviewer", "Maintainer"], "rename");
    expect(() => acquireAgentProfileTransactionLock(root, "reviewer", "other")).toThrow("already active");
    expect(() => acquireAgentProfileTransactionLocks(root, ["maintainer", "reviewer"], "opposing")).toThrow("already active");
    release();
    const after = acquireAgentProfileTransactionLocks(root, ["maintainer", "reviewer"], "after");
    after();
  });

  it("moves the complete profile home while preserving agent, authority grants and Evolution identity", async () => {
    const input = await fixture();
    const sourceAuthority = input.authority.records.get("reviewer")!;
    sourceAuthority.capabilityGrants = [{ referenceId: "docs", sourceSha256: "a".repeat(64), adapter: "codex", kind: "mcp" }];
    input.authority.records.set("reviewer", sourceAuthority);
    const refreshed = await import("../../src/config/agentProfileLifecycle.js").then(({ inspectAgentProfileLifecycle }) =>
      inspectAgentProfileLifecycle({ workspaceRoot: input.root, agentName: "reviewer", authority: input.authority, config: input.config }));
    fs.writeFileSync(path.join(input.root, ".tachyon", "agents", "reviewer", "owned.txt"), "preserve me\n");

    const result = await commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: refreshed.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    });

    expect(result.agentId).toBe(refreshed.agentId);
    expect(fs.existsSync(path.join(input.root, ".tachyon", "agents", "reviewer"))).toBe(false);
    expect(fs.readFileSync(path.join(input.root, ".tachyon", "agents", "maintainer", "owned.txt"), "utf8")).toBe("preserve me\n");
    expect(input.authority.records.get("reviewer")).toBeUndefined();
    expect(input.authority.records.get("maintainer")).toMatchObject({ agentId: refreshed.agentId, capabilityGrants: sourceAuthority.capabilityGrants });
    expect(input.config.read()).toContain("profile: .tachyon/agents/maintainer/agent.yml");
    expect(input.evolution.profiles.get("maintainer")).toBe("profile-1");
  });

  it("renames the parent-side ownership edge in the same transaction (t-a35572)", async () => {
    const input = await fixture();
    const owner = await commitAgentProfileLifecycle({
      workspaceRoot: input.root,
      agentName: "boss",
      operation: "create",
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      authority: input.authority,
      config: input.config,
      activateState: () => undefined,
    });
    await commitAgentProfileLifecycle({
      workspaceRoot: input.root,
      agentName: "boss",
      operation: "edit",
      expectedRevision: owner.revision,
      patch: { ownership: { subagents: ["reviewer"] } },
      authority: input.authority,
      config: input.config,
      activateState: () => undefined,
    });

    const reviewer = await import("../../src/config/agentProfileLifecycle.js").then(({ inspectAgentProfileLifecycle }) =>
      inspectAgentProfileLifecycle({ workspaceRoot: input.root, agentName: "reviewer", authority: input.authority, config: input.config }));

    const result = await commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      ownerAgentName: "boss",
      expectedRevision: reviewer.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    });

    const ownerAfter = await import("../../src/config/agentProfileLifecycle.js").then(({ inspectAgentProfileLifecycle }) =>
      inspectAgentProfileLifecycle({ workspaceRoot: input.root, agentName: "boss", authority: input.authority, config: input.config }));
    expect(ownerAfter.profile.ownership?.subagents).toEqual(["maintainer"]);
    expect(input.authority.records.get("boss")?.revision).toBe(`lifecycle-${result.txid}`);
  });

  it("rolls the parent-side ownership edge forward after an interrupted rename", async () => {
    const input = await fixture();
    const owner = await commitAgentProfileLifecycle({
      workspaceRoot: input.root,
      agentName: "boss",
      operation: "create",
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      authority: input.authority,
      config: input.config,
      activateState: () => undefined,
    });
    await commitAgentProfileLifecycle({
      workspaceRoot: input.root,
      agentName: "boss",
      operation: "edit",
      expectedRevision: owner.revision,
      patch: { ownership: { subagents: ["reviewer"] } },
      authority: input.authority,
      config: input.config,
      activateState: () => undefined,
    });
    const reviewer = await import("../../src/config/agentProfileLifecycle.js").then(({ inspectAgentProfileLifecycle }) =>
      inspectAgentProfileLifecycle({ workspaceRoot: input.root, agentName: "reviewer", authority: input.authority, config: input.config }));

    await expect(commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      ownerAgentName: "boss",
      expectedRevision: reviewer.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
      onPhase: (phase) => { if (phase === "authority-moved") throw new Error("interrupt"); },
    })).rejects.toThrow("interrupt");

    expect((await import("../../src/config/agentProfileLifecycle.js").then(({ inspectAgentProfileLifecycle }) =>
      inspectAgentProfileLifecycle({ workspaceRoot: input.root, agentName: "boss", authority: input.authority, config: input.config }))).profile.ownership?.subagents)
      .toEqual(["reviewer"]);

    await expect(reconcileAgentProfileRenames({
      workspaceRoot: input.root,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    })).resolves.toMatchObject({ reconciled: [expect.any(String)], degraded: [] });
    expect((await import("../../src/config/agentProfileLifecycle.js").then(({ inspectAgentProfileLifecycle }) =>
      inspectAgentProfileLifecycle({ workspaceRoot: input.root, agentName: "boss", authority: input.authority, config: input.config }))).profile.ownership?.subagents)
      .toEqual(["maintainer"]);
  });

  it("compensates an interruption before the authority commit", async () => {
    const input = await fixture();
    await expect(commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
      onPhase: (phase) => { if (phase === "profile-moved") throw new Error("interrupt"); },
    })).rejects.toThrow("interrupt");
    expect(fs.existsSync(path.join(input.root, ".tachyon", "agents", "reviewer", "agent.yml"))).toBe(true);
    expect(fs.existsSync(path.join(input.root, ".tachyon", "agents", "maintainer"))).toBe(false);
    expect(input.authority.records.has("reviewer")).toBe(true);
    expect(agentProfileRenameBlocked(input.root, "reviewer")).toBe(false);
  });

  it("recognizes a committed authority move after acknowledgement loss", async () => {
    const input = await fixture();
    input.authority.loseMoveAcknowledgement = true;
    await expect(commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    })).resolves.toMatchObject({ newAgentName: "maintainer" });
    expect(input.authority.records.has("maintainer")).toBe(true);
  });

  it("renames profiles that have no Evolution state without creating one", async () => {
    const input = await fixture();
    input.evolution.profiles.delete("reviewer");
    fs.rmSync(path.join(input.root, ".tachyon", "agents", "reviewer", "evolution"), { recursive: true });
    await commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    });
    expect(await input.evolution.readProfileId("maintainer")).toBeUndefined();
    expect(fs.existsSync(path.join(input.root, ".tachyon", "agents", "maintainer", "evolution"))).toBe(false);
  });

  it("rolls a post-commit interruption forward and preserves unrelated YAML edits", async () => {
    const input = await fixture();
    await expect(commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
      onPhase: (phase) => {
        if (phase === "authority-moved") {
          fs.appendFileSync(path.join(input.root, "tachyon.yml"), "# unrelated\n");
          throw new Error("interrupt");
        }
      },
    })).rejects.toThrow("interrupt");
    expect(agentProfileRenameBlocked(input.root, "reviewer")).toBe(true);
    const recovered = await reconcileAgentProfileRenames({
      workspaceRoot: input.root,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    });
    expect(recovered.degraded).toEqual([]);
    expect(input.config.read()).toContain("# unrelated");
    expect(input.config.read()).toContain("profile: .tachyon/agents/maintainer/agent.yml");
    expect(input.evolution.profiles.get("maintainer")).toBe("profile-1");
    expect(agentProfileRenameBlocked(input.root, "maintainer")).toBe(false);
  });

  it("replays live convergence when its first acknowledgement is lost", async () => {
    const input = await fixture();
    const snapshot = { sessionPresent: false, ledgerRecord: null, activity: { jsonlSha256: null, stateSha256: null } };
    let liveMoved = false;
    let calls = 0;
    const live = {
      prepare: async () => snapshot,
      converge: async () => {
        calls++;
        if (!liveMoved) {
          liveMoved = true;
          throw new Error("lost live acknowledgement");
        }
      },
    };
    await expect(commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live,
      activateState: () => undefined,
    })).rejects.toThrow("lost live acknowledgement");
    expect(agentProfileRenameBlocked(input.root, "maintainer")).toBe(true);

    const recovered = await reconcileAgentProfileRenames({
      workspaceRoot: input.root,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      live,
      activateState: () => undefined,
    });
    expect(recovered.degraded).toEqual([]);
    expect(calls).toBe(2);
    expect(agentProfileRenameBlocked(input.root, "maintainer")).toBe(false);
  });

  it("rejects destination collisions before moving durable state", async () => {
    const input = await fixture();
    input.evolution.profiles.set("maintainer", "other-profile");
    await expect(commitAgentProfileRename({
      workspaceRoot: input.root,
      oldAgentName: "reviewer",
      newAgentName: "maintainer",
      expectedRevision: input.created.revision,
      authority: input.authority,
      config: input.config,
      evolution: input.evolution,
      activateState: () => undefined,
    })).rejects.toThrow("already exists");
    expect(fs.existsSync(path.join(input.root, ".tachyon", "agents", "reviewer", "agent.yml"))).toBe(true);
    expect(input.authority.records.has("reviewer")).toBe(true);
  });
});
