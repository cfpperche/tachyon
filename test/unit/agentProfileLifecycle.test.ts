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
import {
  createProfileFromStudioMutation,
  proposeSavedAgentGrantPatchFromStudioMutation,
} from "../../src/config/agentProfileStudio.js";
import { readAgentProfileGrants } from "../../src/config/agentProfileGrants.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import type { AgentProfileAuthorityPort } from "../../src/config/agentProfileTransactions.js";
import { acquireAgentProfileTransactionLock } from "../../src/config/agentProfileTransactions.js";
import {
  CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  GROK_PRIVATE_HOME_INPUT_INSPECTOR,
} from "../../src/config/agentProfileProjection.js";

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

class MemoryAuthority implements AgentProfileAuthorityPort {
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
  it("creates Claude authority with the closed private-home inspector", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();

    await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "claude",
      operation: "create",
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      authority,
      config: configPort(root),
    });

    expect(authority.records.get("claude")?.runtimeInspector).toEqual(CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR);
  });

  it("transactionally replaces authority-only orphan state during create", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const orphan: AgentProfileAuthorityRecord = {
      schemaVersion: 1,
      agentName: "claude",
      agentId: crypto.randomUUID(),
      revision: "orphan-authority",
      canonicalSha256: "a".repeat(64),
      runtimeInspector: GROK_PRIVATE_HOME_INPUT_INSPECTOR,
      capabilityGrants: [{
        referenceId: "stale-grant",
        sourceSha256: "b".repeat(64),
        adapter: "claude",
        kind: "mcp",
      }],
    };
    authority.records.set("claude", orphan);

    const created = await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "claude",
      operation: "create",
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      authority,
      config: configPort(root),
    });

    expect(created.snapshot.profile.agentId).not.toBe(orphan.agentId);
    expect(authority.records.get("claude")?.runtimeInspector).toEqual(CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR);
    expect(authority.records.get("claude")?.capabilityGrants).toBeUndefined();
  });

  it("restores authority-only orphan state when create compensation runs", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const orphan: AgentProfileAuthorityRecord = {
      schemaVersion: 1,
      agentName: "claude",
      agentId: crypto.randomUUID(),
      revision: "orphan-authority",
      canonicalSha256: "a".repeat(64),
      runtimeInspector: CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
    };
    authority.records.set("claude", orphan);

    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "claude",
      operation: "create",
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      authority,
      config: configPort(root),
      onPhase: (phase) => { if (phase === "authority-published") throw new Error("interrupt-orphan-recovery"); },
    })).rejects.toThrow("interrupt-orphan-recovery");

    expect(authority.records.get("claude")).toEqual(orphan);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "claude", "agent.yml"))).toBe(false);
    expect(configPort(root).read()).toBe("agents: {}\n");
  });

  it("creates Grok authority with the measured private-home inspector", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);

    await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "grok",
      operation: "create",
      createProfile: { runtime: { adapter: "grok", executable: "grok" } },
      authority,
      config,
    });

    expect(authority.records.get("grok")?.runtimeInspector).toEqual(GROK_PRIVATE_HOME_INPUT_INSPECTOR);
    expect(config.read()).toContain("profile: .tachyon/agents/grok/agent.yml");
  });

  it("t-26f508 review: an edit adopts the current inspector only when the prior one is superseded", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "grok",
      operation: "create",
      createProfile: { runtime: { adapter: "grok", executable: "grok" } },
      authority,
      config,
    });

    // Rewrite the record as it would look for a profile created under the shipped v1 contract.
    const v1Sha = crypto.createHash("sha256").update([
      "tachyon/grok-private-home-input-inspector/v1",
      "literal executable grok",
      "GROK_HOME is Tachyon-owned bridge-mcp/<agent>.grok on every canonical launch",
      "config.toml and trusted_folders.toml are rewritten before launch",
      "auth.json is an external credential symlink",
      "ambient ~/.grok config, memory and plugins are not inherited",
    ].join("\n")).digest("hex");
    const stale = authority.records.get("grok")!;
    authority.records.set("grok", {
      ...stale,
      runtimeInspector: { adapter: "grok", id: "tachyon.grok-private-home-inputs", version: "1", sha256: v1Sha },
    });

    await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "grok",
      operation: "set-enabled",
      expectedRevision: (await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "grok", authority, config })).revision,
      enabled: true,
      authority,
      config,
    });
    // Re-attestation happens at the lifecycle boundary, so the stale descriptor does not persist.
    expect(authority.records.get("grok")?.runtimeInspector).toEqual(GROK_PRIVATE_HOME_INPUT_INSPECTOR);

    // A descriptor that is NOT a listed supersession is still carried through untouched — adoption
    // is scoped to the one-way door a bump created, not a general "newest wins".
    const foreign = { adapter: "grok", id: "tachyon.grok-private-home-inputs", version: "9", sha256: "c".repeat(64) };
    authority.records.set("grok", { ...authority.records.get("grok")!, runtimeInspector: foreign });
    await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "grok",
      operation: "set-enabled",
      expectedRevision: (await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "grok", authority, config })).revision,
      enabled: false,
      authority,
      config,
    });
    expect(authority.records.get("grok")?.runtimeInspector).toEqual(foreign);
  });

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
    expect(fs.readdirSync(path.join(root, ".tachyon", "canonical-agent-transactions", "lifecycle"))).toEqual([]);
  });

  /**
   * t-ca9086 — fail-before was `enabled: false` on create (start refused as "profile is disabled").
   * Pass-after: the Studio/proposal create helper persists `enabled: true` without autostart, and a
   * re-inspect (reload) still shows that — so a subsequent start is not blocked by disablement.
   */
  it("t-ca9086: approve/Studio create persists enabled without autostart across reload", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    // Exact editable the extension's saved-agent-create port sends.
    const createProfile = createProfileFromStudioMutation({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "importer",
      editable: {
        displayName: "",
        runtime: { adapter: "claude", executable: "claude" },
        role: "",
        cwd: "",
        lifecycle: { autostart: false, restart: "never", attention: true, watch: [] },
        worktree: { enabled: false, branch: "" },
        isolation: "",
        capabilities: { skills: [], mcp: [], hooks: [] },
      },
    } as never);

    const committed = await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "importer",
      operation: "create",
      createProfile,
      authority,
      config,
    });
    expect(committed.snapshot.profile.lifecycle?.enabled).toBe(true);
    expect(committed.snapshot.profile.lifecycle?.autostart).toBeUndefined();

    const reloaded = await inspectAgentProfileLifecycle({
      workspaceRoot: root, agentName: "importer", authority, config,
    });
    expect(reloaded.profile.lifecycle?.enabled).toBe(true);
    expect(reloaded.profile.lifecycle?.autostart).toBeUndefined();
    // AgentManager.assertProfileLifecycleEnabled refuses only when enabled === false.
    expect(reloaded.profile.lifecycle?.enabled === false).toBe(false);
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
      artifacts: [artifact],
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

  it("t-07d05c: rolls back the first agent cleanly when the restored roster is empty", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const original = config.read();
    const activations: string[] = [];
    // t-07d05c — host reactivation of the restored prior can still fail for host-local reasons;
    // empty roster (t-f67185 valid load) must not degrade the transaction after durable restore.
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
        if (state === "prior") throw new Error("host refused empty-roster reactivation");
      },
    })).rejects.toThrow("activation rejected");

    expect(activations).toEqual(["target", "prior"]);
    // The original activation failure surfaces — not a degraded-transaction error.
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(false);
    expect(config.read()).toBe(original);
    expect(authority.records.has("codex")).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
    expect(await reconcileAgentProfileLifecycle(recoveryInput(root, authority, config)))
      .toEqual({ reconciled: [], degraded: [] });
  });

  it.each([
    ["a scalar", "agents: {}\nterminals: oops\n"],
    ["a list", "agents: {}\nterminals:\n  - one\n"],
    ["null", "agents: {}\nterminals:\n"],
  ])("t-07d05c: still degrades when the restored roster has %s instead of a mapping", async (_label, priorConfig) => {
    const root = temporaryWorkspace();
    fs.writeFileSync(path.join(root, "tachyon.yml"), priorConfig);
    const authority = new MemoryAuthority();
    const config = configPort(root);
    // A present-but-malformed block is a real config error, not an untouched workspace, so the
    // reload failure it causes must not be mistaken for the empty-roster case.
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
      activateState: (state) => {
        if (state === "target") throw new Error("activation rejected");
        if (state === "prior") throw new Error("'terminals' must be a mapping of terminal name -> definition");
      },
    })).rejects.toThrow("transaction degraded");
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(true);
  });

  it.each([
    ["a scalar", "agents: oops\n"],
    ["a list", "agents:\n  - one\n"],
  ])("t-07d05c: refuses to stage a create when the agents block is %s", async (_label, priorConfig) => {
    const root = temporaryWorkspace();
    fs.writeFileSync(path.join(root, "tachyon.yml"), priorConfig);
    const authority = new MemoryAuthority();
    const config = configPort(root);
    // A malformed agents block cannot even take the pointer, so the create fails before staging
    // and never reaches compensation — nothing is published and nothing is blocked.
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
    })).rejects.toThrow();
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(false);
    expect(authority.records.has("codex")).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))).toBe(false);
  });

  it("t-07d05c: still degrades when prior activation fails on a populated roster", async () => {
    const root = temporaryWorkspace();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  shell:\n    cmd: bash\n");
    const authority = new MemoryAuthority();
    const config = configPort(root);
    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
      activateState: (state) => {
        if (state === "target") throw new Error("activation rejected");
        if (state === "prior") throw new Error("host reload failed for an unrelated reason");
      },
    })).rejects.toThrow("transaction degraded");
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(true);
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
      // t-4a1f85 — "no partial identity state" includes the HOME. The create minted
      // `.tachyon/agents/codex/`, so a rollback that keeps it has not put the workspace back: the
      // journal is then deleted as clean and no reconcile ever revisits the directory again.
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "codex"))).toBe(false);
    },
  );

  /**
   * t-4a1f85 — the other half of the removal policy, and the reason it is `rmdir` and not `rm -rf`.
   *
   * `savedAgentState.ts` says a profile directory may hold work a human wants and that Tachyon never
   * deletes it automatically. A compensation that recursively cleared the home it created would
   * break that rule for anything that arrived in the meantime — a Soul import writes `SOUL.md` into
   * the same directory. So the rollback removes only what it can remove EMPTY, the stray bytes
   * survive, and the leftover is now `orphan-home` in `reconcile_roster` rather than invisible.
   */
  it("keeps a compensated create's home when something else wrote into it, and does not degrade", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const originalConfig = config.read();
    const home = path.join(root, ".tachyon", "agents", "codex");
    const soul = path.join(home, "SOUL.md");

    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: "codex",
      operation: "create",
      createProfile: initialProfile,
      authority,
      config,
      onPhase: (current) => {
        if (current === "locator-written") fs.writeFileSync(soul, "# a human's soul\n", "utf8");
        if (current === "activated") throw new Error("fail-activated");
      },
    })).rejects.toThrow("fail-activated");

    // The rollback still succeeded on every record the journal names — a refused `rmdir` must never
    // turn a clean compensation into `degraded`, which every reconcile skips forever.
    expect(config.read()).toBe(originalConfig);
    expect(authority.records.has("codex")).toBe(false);
    expect(agentProfileLifecycleBlocked(root, "codex")).toBe(false);
    expect(fs.existsSync(path.join(home, "agent.yml"))).toBe(false);
    expect(fs.readFileSync(soul, "utf8")).toBe("# a human's soul\n");
    expect(fs.readdirSync(home)).toEqual(["SOUL.md"]);
  });

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
    const txDir = path.join(root, ".tachyon", "canonical-agent-transactions", "lifecycle", txid);
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

/**
 * SDD 482 phase 4 (`t-5e1113`) — create-and-adopt as ONE transaction.
 *
 * Ratified 2026-07-29 after an audit rejected a two-transaction version. Ownership is parent-side
 * (spec 352), so recording the proposer as the new agent's owner edits a SECOND agent's profile.
 * Committing the two separately left a window where the agent existed unowned; these tests are about
 * that window not existing.
 */
describe("create with a companion owner is one transaction (SDD 482 phase 4)", () => {
  async function seedOwner(root: string, authority: MemoryAuthority, config: AgentProfileLifecycleConfigPort) {
    await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "boss", operation: "create", authority, config,
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
    });
  }

  it("publishes both profiles and both authorities under one txid", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    await seedOwner(root, authority, config);

    const result = await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "importer", operation: "create", authority, config,
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      companion: { agentName: "boss", ownership: { subagents: ["importer"] } },
    });

    // The owner now declares the new agent…
    const owner = await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "boss", authority, config });
    expect(owner.profile.ownership?.subagents).toEqual(["importer"]);
    // …and BOTH authority records name the same transaction, which is the ratified consequence of a
    // single transaction having a single identity.
    expect(authority.records.get("importer")?.revision).toBe(`lifecycle-${result.txid}`);
    expect(authority.records.get("boss")?.revision).toBe(`lifecycle-${result.txid}`);
  });

  /**
   * The property the whole change exists for: a failure leaves NEITHER subject changed. Not "the
   * agent exists but is unowned" — nothing.
   */
  it("compensates BOTH subjects when the transaction fails", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    await seedOwner(root, authority, config);
    const ownerBefore = structuredClone(authority.records.get("boss"));

    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "importer", operation: "create", authority, config,
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      companion: { agentName: "boss", ownership: { subagents: ["importer"] } },
      // Fails after both profiles and both authorities are published, so compensation has real work.
      activateState: (state) => { if (state === "target") throw new Error("activation refused"); },
    })).rejects.toThrow(/activation refused/);

    // The created agent is gone…
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "importer", "agent.yml"))).toBe(false);
    expect(authority.records.has("importer")).toBe(false);
    // …and the OWNER is byte-for-byte what it was, including its authority record.
    const owner = await inspectAgentProfileLifecycle({ workspaceRoot: root, agentName: "boss", authority, config });
    expect(owner.profile.ownership).toBeUndefined();
    expect(authority.records.get("boss")).toEqual(ownerBefore);
  });

  /**
   * The CRASH half of atomicity, which compensation does not cover: compensation handles a failure
   * in-process, `reconcile` handles the process that died. Raised by `claude-reviewer` as unverified;
   * a grep shows the code, only a test shows the behaviour.
   *
   * The journal here describes a transaction that published the NEW agent but not the companion's
   * ownership edge — the exact half-state. Recovery must NOT read that as converged.
   */
  it("reconcile refuses to commit a crash that left the companion behind", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    await seedOwner(root, authority, config);
    const priorOwnerAuthority = structuredClone(authority.records.get("boss"))!;
    const priorOwnerProfile = fs.readFileSync(path.join(root, ".tachyon", "agents", "boss", "agent.yml"), "utf8");
    const originalConfig = config.read();
    const originalConfigSha256 = sha256(originalConfig);

    const committed = await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "importer", operation: "create", authority, config,
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
    });

    // A journal claiming a companion target that was never published: `boss` still holds its ORIGINAL
    // profile and authority, so the tuple is half-converged.
    const txid = crypto.randomUUID();
    const txDir = path.join(root, ".tachyon", "canonical-agent-transactions", "lifecycle", txid);
    fs.mkdirSync(txDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, "backup-companion-agent.yml"), priorOwnerProfile);
    // The real transaction always stages this; a hand-built txDir must too, or compensation fails on
    // the config restore before it ever reaches the companion.
    fs.writeFileSync(path.join(txDir, "backup-tachyon.yml"), originalConfig);
    fs.writeFileSync(path.join(txDir, "journal.json"), `${JSON.stringify({
      schemaVersion: 1,
      txid,
      operation: "create",
      agentName: "importer",
      phase: "locator-written",
      createdAt: new Date().toISOString(),
      expectedRevision: null,
      priorProfileSha256: null,
      targetProfileSha256: committed.snapshot.provenance.canonical.sha256,
      priorAuthority: null,
      targetAuthority: authority.records.get("importer"),
      priorConfigSha256: originalConfigSha256,
      targetConfigSha256: sha256(config.read()),
      companion: {
        agentName: "boss",
        priorProfileSha256: sha256(priorOwnerProfile),
        targetProfileSha256: "f".repeat(64), // never reached disk
        priorAuthority: priorOwnerAuthority,
        targetAuthority: { ...priorOwnerAuthority, revision: `lifecycle-${txid}` },
      },
    }, null, 2)}\n`);

    expect(await reconcileAgentProfileLifecycle(recoveryInput(root, authority, config)))
      .toEqual({ reconciled: [txid], degraded: [] });

    // Compensated, not committed: the created agent is rolled back and the owner is untouched.
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "importer", "agent.yml"))).toBe(false);
    // t-4a1f85 — the RECOVERY door reaches the same removal as the in-process one. Same actor as a
    // create (Human or Agent), different trigger (the process died), and the residue was identical.
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "importer"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".tachyon", "agents", "boss", "agent.yml"), "utf8")).toBe(priorOwnerProfile);
    expect(authority.records.get("boss")).toEqual(priorOwnerAuthority);
  });

  it("refuses a companion that is the same agent, or one without canonical state", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);

    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "importer", operation: "create", authority, config,
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      companion: { agentName: "importer", ownership: { subagents: [] } },
    })).rejects.toThrow(/companion must be a different agent/);

    await expect(commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "importer", operation: "create", authority, config,
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      companion: { agentName: "ghost", ownership: { subagents: ["importer"] } },
    })).rejects.toThrow(/incomplete canonical state/);
  });
});

describe("t-3bde32 — Saved Agent proposal grant, through the governed door", () => {
  it("grants, revokes, and treats revocation as absence rather than an explicit false", async () => {
    const root = temporaryWorkspace();
    const authority = new MemoryAuthority();
    const config = configPort(root);
    const created = await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "coord", operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
      authority, config,
    });
    // Default is ABSENT, which the whole feature reads as refusal.
    expect(created.snapshot.profile.grants).toBeUndefined();

    const granted = await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "coord", operation: "edit",
      expectedRevision: created.revision,
      patch: proposeSavedAgentGrantPatchFromStudioMutation(
        { schemaVersion: 1, operation: "set-propose-saved-agent-grant", agentName: "coord", expectedRevision: created.revision, granted: true },
        created.snapshot,
      ),
      authority, config,
    });
    expect(granted.snapshot.profile.grants?.proposeSavedAgent).toBe(true);
    // It survives a re-read from disk — the door reads the file, not this object.
    expect(readAgentProfileGrants(root, "coord")?.proposeSavedAgent).toBe(true);

    const revoked = await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "coord", operation: "edit",
      expectedRevision: granted.revision,
      patch: proposeSavedAgentGrantPatchFromStudioMutation(
        { schemaVersion: 1, operation: "set-propose-saved-agent-grant", agentName: "coord", expectedRevision: granted.revision, granted: false },
        granted.snapshot,
      ),
      authority, config,
    });
    // Revocation removes the key rather than writing `false`: one representation of refusal.
    expect(revoked.snapshot.profile.grants).toEqual({});
    expect(revoked.snapshot.profile.grants?.proposeSavedAgent).toBeUndefined();
    expect(readAgentProfileGrants(root, "coord")?.proposeSavedAgent).not.toBe(true);
  });

  it("refuses a stale revision instead of writing an authority change the human never saw", () => {
    const snapshot = { agentName: "coord", revision: "a".repeat(64), profile: {} } as never;
    expect(() => proposeSavedAgentGrantPatchFromStudioMutation(
      { schemaVersion: 1, operation: "set-propose-saved-agent-grant", agentName: "coord", expectedRevision: "b".repeat(64), granted: true },
      snapshot,
    )).toThrow(/revision conflict/);
    expect(() => proposeSavedAgentGrantPatchFromStudioMutation(
      { schemaVersion: 1, operation: "set-propose-saved-agent-grant", agentName: "other", expectedRevision: "a".repeat(64), granted: true },
      snapshot,
    )).toThrow(/revision conflict/);
  });
});
