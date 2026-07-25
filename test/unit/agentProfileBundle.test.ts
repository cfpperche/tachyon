import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clonePortableAgentProfile,
  exportPortableAgentProfileBundle,
  importPortableAgentProfileBundle,
  parsePortableAgentProfileBundle,
  readPortableAgentProfileBundleFile,
  renderPortableAgentProfileBundle,
} from "../../src/config/agentProfileBundle.js";
import {
  commitAgentProfileLifecycle,
  inspectAgentProfileLifecycle,
  type AgentProfileLifecycleConfigPort,
} from "../../src/config/agentProfileLifecycle.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import type { AgentProfileAuthorityPort } from "../../src/config/agentProfileTransactions.js";

const roots: string[] = [];

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function temporaryWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-profile-bundle-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n");
  return root;
}

class MemoryAuthority implements AgentProfileAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  async read(name: string) { return structuredClone(this.records.get(name)); }
  async publish(record: AgentProfileAuthorityRecord) {
    if (this.records.has(record.agentName)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord) {
    if (JSON.stringify(this.records.get(record.agentName)) !== JSON.stringify(expected)) throw new Error("authority CAS conflict");
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

async function sourceFixture() {
  const root = temporaryWorkspace();
  const authority = new MemoryAuthority();
  const config = configPort(root);
  const soul = "# Soul\n\nBe exact.\n";
  const skillDigest = sha256("skill-contract");
  const created = await commitAgentProfileLifecycle({
    workspaceRoot: root,
    agentName: "source",
    operation: "create",
    createProfile: {
      displayName: "Portable source",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      environment: {
        values: { PUBLIC_SETTING: "must-not-transfer" },
        secrets: { API_TOKEN: { provider: "vault", id: "secret-handle-42", purpose: "testing" } },
      },
      prompt: { soul: "local-soul", role: "reviewer", evolution: "evolution" },
      lifecycle: { enabled: true, autostart: true },
      workspace: { cwd: "/machine/local/path" },
      capabilities: { mcp: ["tool"] },
      references: [
        { id: "evolution", kind: "evolution", scope: "product", owner: "tachyon", path: "evolution.md", mode: "pinned", sha256: sha256("evolution"), version: "1" },
        { id: "tool", kind: "mcp", scope: "product", owner: "tachyon", path: "mcp/example", mode: "pinned", sha256: skillDigest, version: "1" },
      ],
    },
    createProfileLocalReferences: [
      { id: "local-soul", kind: "soul", path: "SOUL.md", mode: "pinned", sha256: sha256(soul) },
    ],
    createArtifacts: [{ path: "SOUL.md", text: soul, sha256: sha256(soul) }],
    authority,
    config,
    activateState: () => undefined,
  });
  authority.records.get("source")!.capabilityGrants = [{ referenceId: "tool", sourceSha256: skillDigest, adapter: "codex", kind: "mcp" }];
  return { root, authority, config, created, soul };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("portable agent profile bundle", () => {
  it("exports deterministic allowlisted bytes without identity, credentials, grants or machine bindings", async () => {
    const fixture = await sourceFixture();
    const snapshot = await inspectAgentProfileLifecycle({ workspaceRoot: fixture.root, agentName: "source", authority: fixture.authority, config: fixture.config });

    const first = exportPortableAgentProfileBundle({ workspaceRoot: fixture.root, snapshot });
    const second = exportPortableAgentProfileBundle({ workspaceRoot: fixture.root, snapshot });
    const text = first.bytes.toString("utf8");

    expect(second).toEqual(first);
    expect(first.bundle.profile).toEqual({
      displayName: "Portable source",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      role: "reviewer",
      documents: { soul: { mediaType: "text/markdown", sha256: sha256(fixture.soul), text: fixture.soul } },
    });
    expect(text).not.toContain(fixture.created.snapshot.agentId);
    expect(text).not.toContain("must-not-transfer");
    expect(text).not.toContain("secret-handle-42");
    expect(text).not.toContain("vault");
    expect(text).not.toContain("/machine/local/path");
    expect(text).not.toContain("capabilityGrants");
    expect(first.bundle.requiresReauthorization).toEqual(expect.arrayContaining([
      { kind: "environment", field: "environment.values.PUBLIC_SETTING" },
      { kind: "secret", field: "environment.secrets.API_TOKEN" },
      { kind: "reference", field: "capabilities.mcp", referenceId: "tool", referenceKind: "mcp" },
      { kind: "reference", field: "prompt.evolution", referenceId: "evolution", referenceKind: "evolution" },
      { kind: "workspace", field: "workspace" },
      { kind: "lifecycle", field: "lifecycle" },
    ]));
  });

  it("imports and clones through canonical bytes into fresh disabled identities with empty authority", async () => {
    const fixture = await sourceFixture();
    const source = await inspectAgentProfileLifecycle({ workspaceRoot: fixture.root, agentName: "source", authority: fixture.authority, config: fixture.config });
    const exported = exportPortableAgentProfileBundle({ workspaceRoot: fixture.root, snapshot: source });
    const dependencies = {
      workspaceRoot: fixture.root,
      authority: fixture.authority,
      config: fixture.config,
      activateState: () => undefined,
    };

    const imported = await importPortableAgentProfileBundle({ ...dependencies, agentName: "imported", bundle: exported.bytes });
    const cloned = await clonePortableAgentProfile({ ...dependencies, source, destinationAgentName: "cloned" });

    expect(new Set([source.agentId, imported.lifecycle.snapshot.agentId, cloned.lifecycle.snapshot.agentId]).size).toBe(3);
    for (const result of [imported, cloned]) {
      expect(result.lifecycle.snapshot.profile.lifecycle).toEqual({ enabled: false });
      expect(result.lifecycle.snapshot.profile.prompt).toMatchObject({ soul: "portable-soul", role: "reviewer" });
      expect(result.lifecycle.snapshot.profile.environment).toBeUndefined();
      expect(result.lifecycle.snapshot.profile.capabilities).toBeUndefined();
      expect(fixture.authority.records.get(result.lifecycle.snapshot.agentName)?.capabilityGrants).toBeUndefined();
      expect(fs.readFileSync(path.join(fixture.root, ".tachyon", "agents", result.lifecycle.snapshot.agentName, "SOUL.md"), "utf8")).toBe(fixture.soul);
    }
    expect(cloned.bundleSha256).toBe(exported.sha256);
    await expect(importPortableAgentProfileBundle({ ...dependencies, agentName: "imported", bundle: exported.bytes })).rejects.toThrow("already");
  });

  it("rejects noncanonical, unknown, oversized and symlink-sourced input before publication", async () => {
    const valid = {
      schemaVersion: 1 as const,
      kind: "tachyon-agent-profile" as const,
      sourceCanonicalSha256: "a".repeat(64),
      profile: { runtime: { adapter: "codex", executable: "codex" } },
      requiresReauthorization: [],
    };
    const canonical = renderPortableAgentProfileBundle(valid);
    expect(parsePortableAgentProfileBundle(canonical).bundle).toEqual(valid);
    expect(() => parsePortableAgentProfileBundle(JSON.stringify(valid))).toThrow("not canonical");
    expect(() => parsePortableAgentProfileBundle(renderPortableAgentProfileBundle({ ...valid, schemaVersion: 1 }))).not.toThrow();
    expect(() => parsePortableAgentProfileBundle(Buffer.alloc(256 * 1024 + 1, 0x20))).toThrow("1..262144 bytes");
    expect(() => parsePortableAgentProfileBundle(`${JSON.stringify({ ...valid, schemaVersion: 2 })}\n`)).toThrow();
    expect(() => parsePortableAgentProfileBundle(`${JSON.stringify({ ...valid, unexpected: true })}\n`)).toThrow();

    if (process.platform !== "win32") {
      const root = temporaryWorkspace();
      const real = path.join(root, "bundle.json");
      const link = path.join(root, "bundle-link.json");
      fs.writeFileSync(real, canonical);
      fs.symlinkSync(real, link);
      expect(() => readPortableAgentProfileBundleFile(link)).toThrow();
    }
  });
});
