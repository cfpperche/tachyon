import { describe, expect, it } from "vitest";
import {
  agentProfileStudioSnapshotSchemaV1,
  createProfileFromStudioMutation,
  patchProfileFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  type AgentProfileStudioMutationV1,
} from "../../src/config/agentProfileStudio.js";
import type { AgentProfileLifecycleSnapshot } from "../../src/config/agentProfileLifecycle.js";

function lifecycleSnapshot(): AgentProfileLifecycleSnapshot {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    agentName: "reviewer",
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    revision: "a".repeat(64),
    profile: {
      schemaVersion: 1,
      agentId: "123e4567-e89b-42d3-a456-426614174000",
      displayName: "Reviewer",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      environment: {
        values: { PUBLIC: "private-enough-not-to-project" },
        secrets: { TOKEN: { provider: "vault", id: "secret-handle", purpose: "auth" } },
      },
      prompt: { soul: "soul", evolution: "evolution", role: "reviewer" },
      lifecycle: { enabled: false },
      references: [
        { id: "soul", kind: "soul", scope: "profile", owner: "123e4567-e89b-42d3-a456-426614174000", path: "SOUL.md", mode: "pinned", sha256: "b".repeat(64) },
        { id: "evolution", kind: "evolution", scope: "product", owner: "tachyon", path: "evolution.md", mode: "pinned", sha256: "c".repeat(64), version: "1" },
      ],
    },
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "d".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 2 },
      learned: { scope: "profile", writable: false, present: true },
      projection: { scope: "runtime", writable: false, active: false },
    },
  };
}

function mutation(expectedRevision?: string): AgentProfileStudioMutationV1 {
  return {
    schemaVersion: 1,
    kind: "canonical",
    agentName: "reviewer",
    ...(expectedRevision ? { expectedRevision } : {}),
    editable: {
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      role: "tester",
    },
  };
}

describe("canonical Agent Studio projection", () => {
  it("projects only authored editable values plus content-free binding/provenance metadata", () => {
    const projected = projectAgentProfileStudioSnapshot(lifecycleSnapshot());
    expect(projected.editable).toEqual({
      displayName: "Reviewer",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      role: "reviewer",
    });
    expect(projected.bindings).toMatchObject({
      environmentValueNames: ["PUBLIC"],
      secretNames: ["TOKEN"],
      prompt: { soul: true, evolution: true },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private-enough-not-to-project");
    expect(serialized).not.toContain("secret-handle");
    expect(serialized).not.toContain("vault");
    expect(serialized).not.toContain("SOUL.md");
  });

  it("rejects unknown response fields and creates fresh profiles disabled", () => {
    const projected = projectAgentProfileStudioSnapshot(lifecycleSnapshot());
    expect(agentProfileStudioSnapshotSchemaV1.safeParse({ ...projected, secret: "leak" }).success).toBe(false);
    expect(createProfileFromStudioMutation(mutation())).toEqual({
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      prompt: { role: "tester" },
      lifecycle: { enabled: false },
    });
  });

  it("builds a narrow edit while retaining unrelated prompt bindings and rejects stale revisions", () => {
    const current = lifecycleSnapshot();
    expect(patchProfileFromStudioMutation(mutation(current.revision), current)).toEqual({
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      prompt: { soul: "soul", evolution: "evolution", role: "tester" },
    });
    expect(() => patchProfileFromStudioMutation(mutation("e".repeat(64)), current)).toThrow("revision conflict");
  });
});
