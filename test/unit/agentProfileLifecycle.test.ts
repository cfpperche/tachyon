import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitAgentProfileLifecycle as commitLifecycleKernel,
  agentProfileLifecycleBlocked,
  inspectAgentProfileLifecycle,
  reconcileAgentProfileLifecycle as reconcileLifecycleKernel,
  type AgentProfileLifecycleConfigPort,
  type CommitAgentProfileLifecycleInput,
} from "../../src/config/agentProfileLifecycle.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import type { AgentProfileMigrationAuthorityPort } from "../../src/config/agentProfileMigration.js";
import { acquireAgentProfileTransactionLock } from "../../src/config/agentProfileMigration.js";

const roots: string[] = [];

function temporaryWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-profile-lifecycle-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n");
  return root;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class MemoryAuthority implements AgentProfileMigrationAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  async read(name: string) { const value = this.records.get(name); return value ? structuredClone(value) : undefined; }
  async publish(record: AgentProfileAuthorityRecord) {
    if (this.records.has(record.agentName)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord) {
    const current = this.records.get(record.agentName);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async retire(name: string, expected: AgentProfileAuthorityRecord) {
    if (JSON.stringify(this.records.get(name)) !== JSON.stringify(expected)) throw new Error("authority CAS conflict");
    this.records.delete(name);
  }
}

function configPort(root: string): AgentProfileLifecycleConfigPort {
  const file = path.join(root, "tachyon.yml");
  return {
    read: () => fs.readFileSync(file, "utf8"),
    replace: (expected, text) => {
      const current = fs.readFileSync(file, "utf8");
      if (sha256(current) !== expected) throw new Error("config CAS conflict");
      fs.writeFileSync(file, text);
    },
  };
}

function commitAgentProfileLifecycle(input: Omit<CommitAgentProfileLifecycleInput, "activateState"> & {
  activateState?: CommitAgentProfileLifecycleInput["activateState"];
}) {
  return commitLifecycleKernel({ activateState: () => undefined, ...input });
}

function reconcileAgentProfileLifecycle(input: Parameters<typeof reconcileLifecycleKernel>[0]) {
  return reconcileLifecycleKernel(input);
}

function recoveryInput(root: string, authority: MemoryAuthority, config: AgentProfileLifecycleConfigPort) {
  return { workspaceRoot: root, authority, config, activateState: () => undefined };
}

const initialProfile = {
  runtime: { adapter: "codex", executable: "codex" },
  lifecycle: { autostart: false },
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent profile lifecycle kernel", () => {
  it("creates a canonical profile, authority and exact pointer as one inspectable tuple", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);

    const committed = await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
    });

    expect(committed.snapshot.profile.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(committed.snapshot.provenance.authority).toMatchObject({ scope: "host", writable: false, grants: 0 });
    expect(config.read()).toContain("profile: .tachyon/agents/codex/agent.yml");
    expect(authority.records.get("codex")?.canonicalSha256).toBe(committed.snapshot.provenance.canonical.sha256);
    expect(await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", authority, config })).toEqual(committed.snapshot);
    expect(fs.readdirSync(path.join(root, ".tachyon", "agent-profile-migrations", "lifecycle"))).toEqual([]);
  });

  it("publishes digest-bound profile artifacts and compensates them with a failed create", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const content = "# Imported soul\n";
    const artifact = { path: "SOUL.md", text: content, sha256: sha256(content) };

    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: { ...initialProfile, prompt: { soul: "portable-soul" } },
      createProfileLocalReferences: [{ id: "portable-soul", kind: "soul", path: artifact.path, mode: "pinned", sha256: artifact.sha256 }],
      createArtifacts: [artifact],
      authority,
      config,
      onPhase: (phase) => { if (phase === "profile-published") throw new Error("interrupt-artifact-create"); },
    })).rejects.toThrow("interrupt-artifact-create");

    expect(authority.records.has("codex")).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", artifact.path))).toBe(false);
    expect(config.read()).toBe("agents: {}\n");
  });

  it("checks revisions under lock and preserves authority-owned grants during canonical edits", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const created = await commitAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", operation: "create", createProfile: initialProfile, authority, config });
    const currentAuthority = authority.records.get("codex")!;
    currentAuthority.capabilityGrants = [{
      referenceId: "docs",
      sourceSha256: "a".repeat(64),
      adapter: "codex",
      kind: "mcp",
    }];
    authority.records.set("codex", currentAuthority);
    const current = await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", authority, config });

    const edited = await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "edit",
      expectedRevision: current.revision,
      patch: { displayName: "Reviewer" },
      authority,
      config,
    });
    expect(edited.snapshot.profile.displayName).toBe("Reviewer");
    expect(authority.records.get("codex")?.capabilityGrants).toEqual(currentAuthority.capabilityGrants);
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "set-enabled",
      expectedRevision: created.revision,
      enabled: false,
      authority,
      config,
    })).rejects.toThrow("profile revision conflict");
    expect((await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", authority, config })).profile.lifecycle?.enabled).toBeUndefined();
  });

  it("rejects runtime-adapter edits that would invalidate authority and grants", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const created = await commitAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", operation: "create", createProfile: initialProfile, authority, config });
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "edit",
      expectedRevision: created.revision,
      patch: { runtime: { adapter: "pi", executable: "pi" } },
      authority,
      config,
    })).rejects.toThrow("explicit authority migration");
    expect((await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", authority, config })).profile.runtime.adapter).toBe("codex");
  });

  it("compensates the durable tuple when host activation rejects the target", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const original = config.read();
    const activations: string[] = [];
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
      activateState: (state) => {
        activations.push(state);
        if (state === "target") throw new Error("activation rejected");
      },
    })).rejects.toThrow("activation rejected");
    expect(config.read()).toBe(original);
    expect(authority.records.has("codex")).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    expect(activations).toEqual(["target", "prior"]);
  });

  it.each(["staged", "profile-published", "authority-published", "locator-written", "activated"] as const)(
    "compensates a create failure after %s without leaving partial identity state",
    async (phase) => {
      const root = temporaryWorkspace();
      const authority = new MemoryAuthority();
      const config = configPort(root);
      const originalConfig = config.read();
      await expect(commitAgentProfileLifecycle({
        workspaceRoot: root,
        agentName: "codex",
        operation: "create",
        createProfile: initialProfile,
        authority,
        config,
        onPhase: (current) => { if (current === phase) throw new Error(`fail-${phase}`); },
      })).rejects.toThrow(`fail-${phase}`);
      expect(config.read()).toBe(originalConfig);
      expect(authority.records.has("codex")).toBe(false);
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    },
  );

  it("sets canonical enablement without making it authorable in tachyon.yml", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const created = await commitAgentProfileLifecycle({ workspaceRoot: root, agentName: "codex", operation: "create", createProfile: initialProfile, authority, config });
    const disabled = await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "set-enabled",
      expectedRevision: created.revision,
      enabled: false,
      authority,
      config,
    });
    expect(disabled.snapshot.profile.lifecycle?.enabled).toBe(false);
    expect(config.read()).not.toContain("enabled");
    expect((await reconcileAgentProfileLifecycle(recoveryInput(root, authority, config))).degraded).toEqual([]);
  });

  it("finalizes an already-converged crash journal on restart and is idempotent", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const originalConfigSha256 = sha256(config.read());
    const committed = await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
    });
    const txid = crypto.randomUUID();
    const txDir = path.join(root, ".tachyon", "agent-profile-migrations", "lifecycle", txid);
    fs.mkdirSync(txDir);
    fs.writeFileSync(path.join(txDir, "journal.json"), `${JSON.stringify({
      schemaVersion: 1,
      txid,
      operation: "create",
      agentName: "codex",
      phase: "locator-written",
      createdAt: new Date().toISOString(),
      expectedRevision: null,
      priorProfileSha256: null,
      targetProfileSha256: committed.snapshot.provenance.canonical.sha256,
      priorAuthority: null,
      targetAuthority: authority.records.get("codex"),
      priorConfigSha256: originalConfigSha256,
      targetConfigSha256: sha256(config.read()),
    }, null, 2)}\n`);

    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(true);
    expect(await reconcileAgentProfileLifecycle(recoveryInput(root, authority, config))).toEqual({ reconciled: [txid], degraded: [] });
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(false);
    expect(await reconcileAgentProfileLifecycle(recoveryInput(root, authority, config))).toEqual({ reconciled: [], degraded: [] });
  });

  it("marks unknown external divergence degraded and keeps launch blocked", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
      onPhase: (phase) => {
        if (phase === "authority-published") {
          fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n# external edit\n");
          throw new Error("crash-after-external-edit");
        }
      },
    })).rejects.toThrow("transaction degraded");
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(true);
    const recovered = await reconcileAgentProfileLifecycle(recoveryInput(root, authority, config));
    expect(recovered.reconciled).toEqual([]);
    expect(recovered.degraded).toHaveLength(1);
  });

  it("shares one principal lock with migration writers", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const release = acquireAgentProfileTransactionLock(root, "codex", "migration-owner");
    try {
      await expect(commitAgentProfileLifecycle({
        workspaceRoot: root,
        agentName: "codex",
        operation: "create",
        createProfile: initialProfile,
        authority,
        config,
      })).rejects.toThrow("already active");
    } finally {
      release();
    }
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
    })).resolves.toMatchObject({ operation: "create" });
  });
});
