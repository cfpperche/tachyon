import { describe, it, expect } from "vitest";
import { handleAgentStudioDomainMessage } from "../../src/cockpit/agentStudioDomain.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import { SoulError } from "../../src/agents/soul.js";
import { EvolutionStoreError } from "../../src/evolution/EvolutionStore.js";
import type { WorkspaceAgentStudioTarget } from "../../src/shell/WorkspacePresentation.js";
import type { AgentProfileStudioSnapshotV1 } from "../../src/config/agentProfileStudio.js";

/**
 * t-610705 (SDD 410 Phase D, D1b) — the soul-profile/evolution domain-message DISPATCH+error-mapping
 * logic ported from the retired AgentStudioPanelManager.handleDomainMessage into agentStudioDomain.ts
 * (generic StudioRegistryEntry.handleDomainMessage extension point). The retired
 * `agentStudioPanel.test.ts` conflated two things: the generic StudioPanelManagerBase LIFECYCLE
 * (load/save/cancel/refreshAll/restore/reveal/malformed-message) — now covered generically by
 * cockpitStudio.test.ts's D0 FSM tests, which apply to every StudioId including "agent" once wired,
 * same as terminal/runbook/schedule lost their own copies of that coverage in D1a — and the
 * AGENT-SPECIFIC domain dispatch this file re-covers directly, calling the ported function in
 * isolation rather than through the full Cockpit.ts/studioHost.ts stack (simpler to drive, and the
 * exact same logic either way — this function has no dependency on binding/txnLock state at all).
 */

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeCtx() {
  const posted: unknown[] = [];
  return { post: (m: unknown) => posted.push(m), posted };
}

function ws(overrides: Partial<WorkspaceAgentStudioTarget> = {}): WorkspaceAgentStudioTarget {
  return {
    wsHash: "ws1",
    workspaceRoot: "/ws/root",
    ...overrides,
  } as unknown as WorkspaceAgentStudioTarget;
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function profileSnapshot(agentName = "Ada", revision = "a".repeat(64)): AgentProfileStudioSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "canonical",
    agentName,
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    revision,
    enabled: false,
    editable: {
      displayName: agentName, runtime: { adapter: "codex", executable: "codex" }, role: "reviewer",
      cwd: "", lifecycle: { autostart: false, restart: "never", attention: true, watch: [] },
      worktree: { enabled: false, branch: "" }, isolation: "",
      nativeConfig: {},
    },
    bindings: { environmentValueNames: [], secretNames: [], prompt: { soul: false, instructions: false, evolution: false }, capabilities: { skills: 0, mcp: 0, hooks: 0, pi: 0 }, tooling: { skills: [], mcp: [], hooks: [] }, externalReferences: 0 },
    provenance: { canonical: { scope: "profile", writable: true, sha256: "b".repeat(64) }, authority: { scope: "host", writable: false, revision: "one", grants: 0 }, learned: { scope: "profile", writable: false, present: false }, projection: { scope: "runtime", writable: false, active: false } },
  };
}

describe("Agent Studio domain dispatch (t-610705 Phase D, D1b)", () => {
  it("binds profile actions to the CURRENT binding's entityId and rejects cross-agent or extra-field tampering", async () => {
    let creates = 0;
    const target = ws({
      createSoulProfile: async () => {
        creates += 1;
        return {
          status: {
            agent: "Ada",
            canonicalPath: "/private/workspace/.tachyon/agents/Ada/SOUL.md",
            relativePath: ".tachyon/agents/Ada/SOUL.md",
            lifecycle: "active",
            profileId: "123e4567-e89b-42d3-a456-426614174000",
            sha256: "a".repeat(64),
            soulEnabled: true,
            resolvable: true,
            transactionDegraded: false,
          },
        };
      },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "createSoul" as const, agent: "Bea" }));
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "createSoul" as const, agent: "Ada", canonicalPath: "/tmp/tampered" }));
    await flush();
    expect(creates).toBe(0);
    expect(findType(ctx.posted, "soulProfileError").at(-1)).toMatchObject({ agent: "Ada", code: "soul/path-invalid" });

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "createSoul" as const, agent: "Ada" }));
    await flush();
    expect(creates).toBe(1);
    const status = findType(ctx.posted, "soulProfileStatus").at(-1);
    expect(status).toMatchObject({ status: { agent: "Ada", relativePath: ".tachyon/agents/Ada/SOUL.md" } });
    expect(JSON.stringify(status)).not.toContain("/private/workspace");
    expect(JSON.stringify(status)).not.toContain("canonicalPath");
  });

  it("rejects profile actions when the binding has no entityId (an unsaved new-agent route)", async () => {
    let creates = 0;
    const target = ws({ createSoulProfile: async () => { creates += 1; throw new Error("must not run"); } } as never);
    const ctx = { ...fakeCtx(), entityId: undefined };
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "createSoul" as const, agent: "Ada" }));
    await flush();
    expect(creates).toBe(0);
    expect(findType(ctx.posted, "soulProfileError").at(-1)).toMatchObject({ code: "soul/path-invalid" });
  });

  it("imports webview-selected bytes without invoking a VS Code file path or reflecting payload data", async () => {
    const body = "# Private identity\n";
    const contentBase64 = Buffer.from(body).toString("base64");
    let received: Buffer | undefined;
    const target = ws({
      importSoulProfileBytes: async (_agent: string, bytes: Buffer) => {
        received = Buffer.from(bytes);
        throw new SoulError("soul/io-error", "Unable to import identity profile");
      },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "importSoul" as const, agent: "Ada", contentBase64 }));
    await flush();
    const error = findType(ctx.posted, "soulProfileError").at(-1);
    expect(received?.toString("utf8")).toBe(body);
    expect(error).toMatchObject({ agent: "Ada", code: "soul/io-error" });
    expect(JSON.stringify(error)).not.toContain(contentBase64);
  });

  it("routes only an explicit digest-backed replacement message", async () => {
    const body = "# Replacement identity\n";
    const contentBase64 = Buffer.from(body).toString("base64");
    const expectedDigest = "a".repeat(64);
    let received: { bytes: Buffer; expectedDigest: string } | undefined;
    const target = ws({
      replaceSoulProfileBytes: async (_agent: string, bytes: Buffer, digest: string) => {
        received = { bytes: Buffer.from(bytes), expectedDigest: digest };
        return {
          status: {
            agent: "Ada",
            canonicalPath: "/private/workspace/.tachyon/agents/Ada/SOUL.md",
            relativePath: ".tachyon/agents/Ada/SOUL.md",
            lifecycle: "active",
            sha256: "b".repeat(64),
            soulEnabled: true,
            resolvable: true,
            transactionDegraded: false,
          },
        };
      },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "replaceSoul" as const, agent: "Ada", contentBase64, expectedDigest: "stale" }));
    await flush();
    expect(received).toBeUndefined();

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "replaceSoul" as const, agent: "Ada", contentBase64, expectedDigest }));
    await flush();
    expect(received?.bytes.toString("utf8")).toBe(body);
    expect(received?.expectedDigest).toBe(expectedDigest);
    expect(findType(ctx.posted, "soulProfileStatus").at(-1)).toMatchObject({ status: { action: "replace" } });
  });

  it("routes permanent identity deletion through the saved agent and returns a missing profile status", async () => {
    let deleted = 0;
    const target = ws({
      deleteSoulProfile: async (agent: string) => {
        deleted += 1;
        expect(agent).toBe("Ada");
        return {
          status: {
            agent: "Ada",
            canonicalPath: "/private/workspace/.tachyon/agents/Ada/SOUL.md",
            relativePath: ".tachyon/agents/Ada/SOUL.md",
            lifecycle: "missing",
            soulEnabled: false,
            resolvable: false,
            transactionDegraded: false,
          },
        };
      },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "deleteSoulProfile" as const, agent: "Ada" }));
    await flush();
    expect(deleted).toBe(1);
    const status = findType(ctx.posted, "soulProfileStatus").at(-1);
    expect(status).toMatchObject({ status: { lifecycle: "missing", soulEnabled: false, action: "delete" } });
    expect(JSON.stringify(status)).not.toContain("/private/workspace");
  });

  it("the registered browse action round-trips a native folder pick to a 'cwd' reply", async () => {
    // browse doesn't need entityId (mirrors command/terminal's own handleBrowseDomainMessage) — just
    // confirms the message reaches vscode.window.showOpenDialog via the shared browseForCwd path.
    // (vscode.window.showOpenDialog is exercised through the mocked module in test/mocks/vscode.js —
    // covered end-to-end already by commandStudioAdapter-style tests; this only proves Agent Studio's
    // handler forwards "browse" the same way, not a second copy of the dialog-mocking machinery.)
    const target = ws();
    const ctx = { ...fakeCtx(), entityId: undefined };
    expect(() => handleAgentStudioDomainMessage(target, ctx, envelope({ type: "browse" as const }))).not.toThrow();
  });

  it("fails closed on a malformed domain message instead of silently dropping it", async () => {
    const target = ws();
    const ctx = { ...fakeCtx(), entityId: "Ada" };
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "totallyUnknownType" as never }));
    await flush();
    expect(findType(ctx.posted, "soulProfileError").at(-1)).toMatchObject({ code: "soul/path-invalid" });
  });

  it("routes bounded Evolution overview, on-demand detail, approval, and stale conflict through the saved agent", async () => {
    const summary = {
      agent: "Ada",
      enabled: true,
      profilePresent: true,
      activeVersion: 2,
      pendingCount: 1,
      activeLearnings: [],
      activeSkillNames: ["repo-check"],
    };
    const candidate = {
      id: "candidate-one",
      reviewId: "review-one",
      taskId: "t-123456",
      taskTitle: "Fix the repository",
      createdAt: "2026-07-21T18:00:00.000Z",
      status: "pending" as const,
      kind: "learning" as const,
      reason: "This correction should be reused.",
    };
    const detail = { ...candidate, expectedActiveVersion: 2, learningContent: "Run the focused test first." };
    let stale = false;
    const target = ws({
      readAgentEvolutionOverview: async () => ({ summary, candidates: [candidate] }),
      readAgentEvolutionCandidate: async () => detail,
      approveAgentEvolutionCandidate: async (_agent: string, _candidateId: string, input: { expectedActiveVersion: number }) => {
        if (stale) throw new EvolutionStoreError("evolution/promotion-conflict", "candidate changed");
        expect(input.expectedActiveVersion).toBe(2);
        return { candidateId: candidate.id, activeVersion: 3 };
      },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "refreshEvolution" as const, agent: "Ada" }));
    await flush();
    expect(findType(ctx.posted, "evolutionSummary").at(-1)).toMatchObject({ summary });
    expect(findType(ctx.posted, "evolutionCandidates").at(-1)).toMatchObject({ candidates: [candidate] });

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "loadEvolutionCandidate" as const, agent: "Ada", candidateId: candidate.id }));
    await flush();
    expect(findType(ctx.posted, "evolutionCandidateDetail").at(-1)).toMatchObject({ detail });

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "approveEvolutionCandidate" as const, agent: "Ada", candidateId: candidate.id, expectedActiveVersion: 2 }));
    await flush();
    expect(findType(ctx.posted, "evolutionActionResult").at(-1)).toMatchObject({ candidateId: candidate.id, status: "approved", activeVersion: 3 });

    stale = true;
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "approveEvolutionCandidate" as const, agent: "Ada", candidateId: candidate.id, expectedActiveVersion: 2 }));
    await flush();
    expect(findType(ctx.posted, "evolutionError").at(-1)).toMatchObject({ code: "evolution/promotion-conflict", conflict: true });
  });

  it("dispatches revisioned lifecycle actions and refreshes a redacted snapshot after a stale conflict", async () => {
    const mutations: unknown[] = [];
    const target = ws({
      commitAgentProfileStudioLifecycle: async (mutation) => {
        mutations.push(mutation);
        if (mutation.expectedRevision === "a".repeat(64)) throw new Error("agent 'Ada' profile revision conflict at /private/path");
        return { schemaVersion: 1, kind: "snapshot", snapshot: profileSnapshot("Ada", "c".repeat(64)) };
      },
      inspectAgentProfileStudio: async () => profileSnapshot("Ada", "b".repeat(64)),
    });
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "setCanonicalProfileEnabled" as const,
      agent: "Ada",
      expectedRevision: "a".repeat(64),
      enabled: true,
    }));
    await flush();
    expect(mutations).toEqual([expect.objectContaining({ operation: "set-enabled", agentName: "Ada", enabled: true })]);
    expect(findType(ctx.posted, "canonicalProfileError").at(-1)).toMatchObject({
      agent: "Ada",
      code: "agent-profile/revision-conflict",
      conflict: true,
    });
    expect(JSON.stringify(findType(ctx.posted, "canonicalProfileError").at(-1))).not.toContain("/private/path");
    expect(findType(ctx.posted, "canonicalProfileSnapshot").at(-1)).toMatchObject({ action: "refresh", snapshot: { revision: "b".repeat(64) } });

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "forgetCanonicalProfile" as const,
      agent: "Ada",
      expectedRevision: "b".repeat(64),
      confirmation: "Bea",
    }));
    await flush();
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ operation: "forget", confirmation: "Bea" });
  });
});
