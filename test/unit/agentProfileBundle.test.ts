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
} from "@tachyon/engine/config/agentProfileBundle.js";
import {
  commitAgentProfileLifecycle,
  inspectAgentProfileLifecycle,
} from "@tachyon/engine/config/agentProfileLifecycle.js";
import type { AgentProfileAuthorityRecord } from "@tachyon/engine/config/agentProfileAuthority.js";
import type { AgentProfileAuthorityPort } from "@tachyon/engine/config/agentProfileTransactions.js";

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


async function sourceFixture() {
  const root = temporaryWorkspace();
  const authority = new MemoryAuthority();
  const instructions = "Be exact.\n";
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
      prompt: { instructions: "local-instructions" },
      lifecycle: { enabled: true, autostart: true },
      workspace: { cwd: "/machine/local/path" },
      capabilities: { mcp: ["tool"] },
      references: [
        { id: "tool", kind: "mcp", scope: "product", owner: "tachyon", path: "mcp/example", mode: "pinned", sha256: skillDigest, version: "1" },
      ],
    },
    createProfileLocalReferences: [
      { id: "local-instructions", kind: "instructions", path: "instructions.md", mode: "pinned", sha256: sha256(instructions) },
    ],
    artifacts: [{ path: "instructions.md", text: instructions, sha256: sha256(instructions) }],
    authority,
    activateState: () => undefined,
  });
  authority.records.get("source")!.capabilityGrants = [{ referenceId: "tool", sourceSha256: skillDigest, adapter: "codex", kind: "mcp" }];
  return { root, authority, created, instructions };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("portable agent profile bundle", () => {
  it("exports deterministic allowlisted bytes without identity, credentials, grants or machine bindings", async () => {
    const fixture = await sourceFixture();
    const snapshot = await inspectAgentProfileLifecycle({ workspaceRoot: fixture.root, agentName: "source", authority: fixture.authority });

    const first = exportPortableAgentProfileBundle({ workspaceRoot: fixture.root, snapshot });
    const second = exportPortableAgentProfileBundle({ workspaceRoot: fixture.root, snapshot });
    const text = first.bytes.toString("utf8");

    expect(second).toEqual(first);
    expect(first.bundle.profile).toEqual({
      displayName: "Portable source",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      documents: { instructions: { mediaType: "text/markdown", sha256: sha256(fixture.instructions), text: fixture.instructions } },
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
      { kind: "workspace", field: "workspace" },
      { kind: "lifecycle", field: "lifecycle" },
    ]));
  });

  it("imports and clones through canonical bytes into fresh disabled identities with empty authority", async () => {
    const fixture = await sourceFixture();
    const source = await inspectAgentProfileLifecycle({ workspaceRoot: fixture.root, agentName: "source", authority: fixture.authority });
    const exported = exportPortableAgentProfileBundle({ workspaceRoot: fixture.root, snapshot: source });
    const dependencies = {
      workspaceRoot: fixture.root,
      authority: fixture.authority,
      activateState: () => undefined,
    };

    const imported = await importPortableAgentProfileBundle({ ...dependencies, agentName: "imported", bundle: exported.bytes });
    const cloned = await clonePortableAgentProfile({ ...dependencies, source, destinationAgentName: "cloned" });

    expect(new Set([source.agentId, imported.lifecycle.snapshot.agentId, cloned.lifecycle.snapshot.agentId]).size).toBe(3);
    for (const result of [imported, cloned]) {
      expect(result.lifecycle.snapshot.profile.lifecycle).toEqual({ enabled: false });
      expect(result.lifecycle.snapshot.profile.prompt).toMatchObject({ instructions: "persistent-instructions" });
      expect(result.lifecycle.snapshot.profile.environment).toBeUndefined();
      expect(result.lifecycle.snapshot.profile.capabilities).toBeUndefined();
      expect(fixture.authority.records.get(result.lifecycle.snapshot.agentName)?.capabilityGrants).toBeUndefined();
      expect(fs.readFileSync(path.join(fixture.root, ".tachyon", "agents", result.lifecycle.snapshot.agentName, "instructions.md"), "utf8")).toBe(fixture.instructions);
    }
    expect(cloned.bundleSha256).toBe(exported.sha256);
    for (const result of [imported, cloned]) {
      // t-4071e4 — the bundle carries no workspace posture (it is machine-local), so import and clone
      // have to pick one, and they used to pick "share the human's checkout" by omission. Both doors
      // now land on the same creation default as proposal approval and the Studio's new-agent form.
      expect(result.lifecycle.snapshot.profile.workspace?.worktree?.enabled).toBe(true);
      // Isolated, but never at a location the bundle chose: no path, no base, no branch travels.
      expect(result.lifecycle.snapshot.profile.workspace?.worktree?.branch).toBeUndefined();
      expect(result.lifecycle.snapshot.profile.workspace?.cwd).toBeUndefined();
    }
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
