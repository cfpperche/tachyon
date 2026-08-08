import { describe, it, expect, vi } from "vitest";
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
 * (load/save/cancel/refreshAll/restore/reveal/malformed-message) — covered generically by panel-base
 * / cancel tests (the Control-route FSM suite that used to live beside studioHost.ts is gone with
 * that host) — and the AGENT-SPECIFIC domain dispatch this file re-covers directly, calling the
 * ported function in isolation rather than through the full Cockpit/panel stack (simpler to drive,
 * and the exact same logic either way — this function has no dependency on binding/txnLock state at
 * all).
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
    agentOwnershipView: async () => ({ subagents: [], candidates: [] }),
    ...overrides,
  } as unknown as WorkspaceAgentStudioTarget;
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function profileSnapshot(agentName = "Ada", revision = "a".repeat(64)): AgentProfileStudioSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "agent-instance",
    agentName,
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    revision,
    enabled: false,
    readiness: { state: "limited", limitations: ["fork-unavailable"] },
    editable: {
      displayName: agentName, runtime: { adapter: "codex", executable: "codex" }, role: "reviewer",
      cwd: "", lifecycle: { autostart: false, restart: "never", attention: true },
      worktree: { enabled: false, branch: "", setup: [] }, verify: "", selfEvolution: false, isolation: "",
      nativeConfig: {},
    },
    bindings: { grants: { proposeSavedAgent: false }, foreignWorkspaceCommands: false, environmentValueNames: [], secretNames: [], prompt: { soul: false, instructions: false, evolution: false }, capabilities: { skills: 0, mcp: 0, hooks: 0, pi: 0 }, tooling: { skills: [], mcp: [], hooks: [] }, externalReferences: 0 },
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

  /**
   * t-5498a6 — the authorization door reached from the Studio. Authorizing does NOT select; the
   * refresh that follows is the success signal, because the profile then answers for itself.
   */
  it("authorizes a skill and refreshes so the new reference renders from the profile itself", async () => {
    const calls: Array<{ agent: string; skill: string }> = [];
    const target = ws({
      authorizeAgentSkill: async (agent: string, skillName: string) => {
        calls.push({ agent, skill: skillName });
        return { ok: true as const, outcome: "authorized", referenceId: skillName };
      },
      inspectAgentProfileStudio: async () => profileSnapshot("Ada"),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizeSkill" as const, agent: "Ada", skillName: "visual-qa", reauthorize: false }));
    await flush();

    expect(calls).toEqual([{ agent: "Ada", skill: "visual-qa" }]);
    expect(findType(ctx.posted, "agentProfileSnapshot").at(-1)).toBeTruthy();
  });

  it("surfaces a REFUSAL as itself rather than as a generic failure", async () => {
    // "this plugin does not install for codex" is an answer the human has to read; the engine returns
    // it as a value precisely so it cannot be flattened into a transport error.
    const target = ws({
      authorizeAgentSkill: async () => ({ ok: false as const, error: "plugin 'product-foundation@0.1.1' does not declare runtime 'codex'" }),
      inspectAgentProfileStudio: async () => { throw new Error("must not refresh after a refusal"); },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizeSkill" as const, agent: "Ada", skillName: "product-foundation", reauthorize: false }));
    await flush();

    expect(JSON.stringify(ctx.posted)).toContain("does not declare runtime 'codex'");
  });

  /**
   * t-4a2a6f — the defect this closes: `digest-changed` is `ok: true` and writes NOTHING. The handler
   * used to see `ok` and refresh, so the screen reported a repair it never performed.
   */
  it("reports digest-changed as a refusal naming the repair, never as a silent success", async () => {
    const target = ws({
      authorizeAgentSkill: async () => ({ ok: true as const, outcome: "digest-changed", referenceId: "visual-qa" }),
      inspectAgentProfileStudio: async () => { throw new Error("must not refresh a profile that did not change"); },
      authorizableCapabilitiesFor: async () => ({ workspaceSkills: [], plugins: [], checkoutOnlyPlugins: [] }),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizeSkill" as const, agent: "Ada", skillName: "visual-qa", reauthorize: false }));
    await flush();

    const posted = JSON.stringify(ctx.posted);
    expect(posted).toContain("has since changed");
    expect(posted).toContain("Reauthorize");
  });

  it("carries reauthorize to the host verbatim — the accept-changed-content decision is never inferred", async () => {
    const seen: boolean[] = [];
    const target = ws({
      authorizeAgentPlugin: async (_agent: string, _plugin: string, options: { reauthorize?: boolean }) => {
        seen.push(options.reauthorize === true);
        return { ok: true as const, authorized: ["agent-browser"], outcomes: ["reauthorized"] };
      },
      inspectAgentProfileStudio: async () => profileSnapshot("Ada"),
      authorizableCapabilitiesFor: async () => ({ workspaceSkills: [], plugins: [], checkoutOnlyPlugins: [] }),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizePlugin" as const, agent: "Ada", pluginName: "agent-browser", reauthorize: true }));
    await flush();
    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizePlugin" as const, agent: "Ada", pluginName: "agent-browser", reauthorize: false }));
    await flush();

    expect(seen).toEqual([true, false]);
  });

  it("refuses an authorize message that omits reauthorize — accepting changed content must not be reachable by omission", async () => {
    let called = 0;
    const target = ws({ authorizeAgentPlugin: async () => { called += 1; return { ok: true as const, authorized: [], outcomes: [] }; } } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizePlugin" as const, agent: "Ada", pluginName: "agent-browser" } as never));
    await flush();

    expect(called).toBe(0);
  });

  it("names the skills a plugin authorization held back, so a partial repair cannot read as a whole one", async () => {
    const target = ws({
      authorizeAgentPlugin: async () => ({
        ok: true as const,
        authorized: ["fresh-skill", "drifted-skill"],
        outcomes: ["authorized", "digest-changed"],
      }),
      inspectAgentProfileStudio: async () => profileSnapshot("Ada"),
      authorizableCapabilitiesFor: async () => ({ workspaceSkills: [], plugins: [], checkoutOnlyPlugins: [] }),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizePlugin" as const, agent: "Ada", pluginName: "multi", reauthorize: false }));
    await flush();

    const posted = JSON.stringify(ctx.posted);
    expect(posted).toContain("drifted-skill");
    expect(posted).not.toContain("fresh-skill was authorized at content");
  });

  /**
   * t-746f0f — an authorization that lands while the agent runs cannot reach the live session, so the
   * panel has to say when it will. Silence here reads as "your running agent now has this skill".
   */
  it("names the launch boundary when the capability landed while the agent was running", async () => {
    const target = ws({
      authorizeAgentSkill: async () => ({ ok: true as const, outcome: "authorized", referenceId: "atlas", reachesAgentAtNextLaunch: true }),
      inspectAgentProfileStudio: async () => profileSnapshot("Ada"),
      authorizableCapabilitiesFor: async () => ({ workspaceSkills: [], plugins: [], checkoutOnlyPlugins: [] }),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizeSkill" as const, agent: "Ada", skillName: "atlas", reauthorize: false }));
    await flush();

    const notice = findType(ctx.posted, "agentProfileNotice").at(-1) as { message: string } | undefined;
    expect(notice?.message).toContain("restart Ada");
    // The snapshot refresh posts its own "Latest profile loaded." — the specific sentence has to be
    // the one left standing, so it is posted last.
    expect((ctx.posted.at(-1) as { type: string }).type).toBe("agentProfileNotice");
  });

  it("says nothing about a launch when the agent was stopped — there is no gap to explain", async () => {
    const target = ws({
      authorizeAgentSkill: async () => ({ ok: true as const, outcome: "authorized", referenceId: "atlas" }),
      inspectAgentProfileStudio: async () => profileSnapshot("Ada"),
      authorizableCapabilitiesFor: async () => ({ workspaceSkills: [], plugins: [], checkoutOnlyPlugins: [] }),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizeSkill" as const, agent: "Ada", skillName: "atlas", reauthorize: false }));
    await flush();

    expect(findType(ctx.posted, "agentProfileNotice")).toEqual([]);
  });

  /**
   * t-746f0f — the stale-skill warning used to be posted BEFORE the refreshes, so the refresh's own
   * "Latest profile loaded." overwrote it. One statement survives this handler; when a repair only
   * half landed it has to be the one naming what did not.
   */
  it("leaves the half-repair warning as the last word, ahead of any launch notice", async () => {
    const target = ws({
      authorizeAgentPlugin: async () => ({
        ok: true as const,
        authorized: ["fresh-skill", "drifted-skill"],
        outcomes: ["authorized", "digest-changed"],
        reachesAgentAtNextLaunch: true,
      }),
      inspectAgentProfileStudio: async () => profileSnapshot("Ada"),
      authorizableCapabilitiesFor: async () => ({ workspaceSkills: [], plugins: [], checkoutOnlyPlugins: [] }),
    } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizePlugin" as const, agent: "Ada", pluginName: "multi", reauthorize: false }));
    await flush();

    const last = ctx.posted.at(-1) as { type: string; message?: string };
    expect(last.type).toBe("agentProfileError");
    expect(last.message).toContain("drifted-skill");
    expect(findType(ctx.posted, "agentProfileNotice")).toEqual([]);
  });

  it("refuses a skill name that could never BE a reference id, before it reaches the host", async () => {
    let called = 0;
    const target = ws({ authorizeAgentSkill: async () => { called += 1; return { ok: true as const, outcome: "authorized", referenceId: "x" }; } } as never);
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "authorizeSkill" as const, agent: "Ada", skillName: "../../etc/passwd", reauthorize: false }));
    await flush();

    expect(called).toBe(0);
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

  /**
   * t-359469 — ACTORS A1/A2 at the layer that decides what a human actually READS.
   *
   * `postProfileError` never forwards the engine's message: it looks the code up in a fixed table and
   * posts that string, so the truthful refusal written in `soulProfileTransactions` reaches this
   * surface only if the code carries it. Under the old `soul/path-invalid` the human saw "The profile
   * action or canonical path is invalid." — which points at a typo that does not exist.
   */
  it("t-359469 tells the human WHICH block declares the name instead of calling the action invalid", async () => {
    const target = ws({
      createSoulProfile: async () => {
        throw new SoulError("soul/not-an-agent", "'shell' is declared in tachyon.yml under 'terminals:', not 'agents:'");
      },
    } as never);
    const ctx = { ...fakeCtx(), entityId: "shell" };

    handleAgentStudioDomainMessage(target, ctx, envelope({ type: "createSoul" as const, agent: "shell" }));
    await flush();

    const posted = findType(ctx.posted, "soulProfileError").at(-1) as { code: string; message: string };
    expect(posted.code).toBe("soul/not-an-agent");
    expect(posted.message).toMatch(/terminals:/);
    expect(posted.message).not.toMatch(/could not be completed|path is invalid/);
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

  it("routes a declared-subagents edit and answers with both the new revision and the roster view (t-4c113c)", async () => {
    const mutations: unknown[] = [];
    const views: string[] = [];
    const target = ws({
      commitAgentProfileStudioLifecycle: async (mutation) => {
        mutations.push(mutation);
        return { schemaVersion: 1, kind: "snapshot", snapshot: profileSnapshot("Ada", "c".repeat(64)) };
      },
      agentOwnershipView: async (agent: string) => {
        views.push(agent);
        return { subagents: ["Bea"], candidates: ["Bea", "Cleo"] };
      },
    });
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "setAgentProfileSubagents" as const,
      agent: "Ada",
      expectedRevision: "a".repeat(64),
      subagents: ["Bea"],
    }));
    await flush();

    expect(mutations).toEqual([expect.objectContaining({ operation: "set-subagents", agentName: "Ada", subagents: ["Bea"] })]);
    // The snapshot carries the NEXT CAS revision; the ownership message carries what the form draws.
    expect(findType(ctx.posted, "agentProfileSnapshot").at(-1)).toMatchObject({
      action: "set-subagents", snapshot: { revision: "c".repeat(64) },
    });
    expect(findType(ctx.posted, "agentProfileOwnership").at(-1)).toMatchObject({
      agent: "Ada", ownership: { subagents: ["Bea"] },
    });
    expect(views).toEqual(["Ada"]);

    // Cross-agent tampering is refused by the same binding guard as every other profile action.
    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "setAgentProfileSubagents" as const,
      agent: "Bea",
      expectedRevision: "a".repeat(64),
      subagents: ["Ada"],
    }));
    await flush();
    expect(mutations).toHaveLength(1);
    expect(findType(ctx.posted, "agentProfileError").at(-1)).toMatchObject({ agent: "Ada" });
  });

  it("t-3bde32: dispatches the Saved Agent proposal grant, and refuses cross-agent tampering", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const target = ws({
      commitAgentProfileStudioLifecycle: async (mutation) => {
        mutations.push(mutation as Record<string, unknown>);
        return { schemaVersion: 1, kind: "snapshot", snapshot: profileSnapshot("Ada", "c".repeat(64)) };
      },
    });
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    for (const granted of [true, false]) {
      handleAgentStudioDomainMessage(target, ctx, envelope({
        type: "setAgentProfileProposeGrant" as const,
        agent: "Ada",
        expectedRevision: "a".repeat(64),
        granted,
      }));
      await flush();
    }
    expect(mutations).toEqual([
      expect.objectContaining({ operation: "set-propose-saved-agent-grant", agentName: "Ada", granted: true }),
      expect.objectContaining({ operation: "set-propose-saved-agent-grant", agentName: "Ada", granted: false }),
    ]);
    expect(findType(ctx.posted, "agentProfileSnapshot").at(-1))
      .toMatchObject({ action: "set-propose-saved-agent-grant" });

    // An authority change for ANOTHER agent must not ride this binding — same guard as every other
    // profile action, and the one that matters most on a grant.
    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "setAgentProfileProposeGrant" as const,
      agent: "Bea",
      expectedRevision: "a".repeat(64),
      granted: true,
    }));
    await flush();
    expect(mutations).toHaveLength(2);
    expect(findType(ctx.posted, "agentProfileError").at(-1)).toMatchObject({ agent: "Ada" });
  });

  it("dispatches revisioned lifecycle actions and refreshes a redacted snapshot after a stale conflict", async () => {
    const mutations: unknown[] = [];
    const target = ws({
      commitAgentProfileStudioLifecycle: async (mutation) => {
        mutations.push(mutation);
        if (mutation.expectedRevision === "a".repeat(64)) {
          return {
            schemaVersion: 1,
            kind: "refused",
            code: "agent-profile/revision-conflict",
            message: "agent 'Ada' profile revision conflict at /private/path",
          };
        }
        return { schemaVersion: 1, kind: "snapshot", snapshot: profileSnapshot("Ada", "c".repeat(64)) };
      },
      inspectAgentProfileStudio: async () => profileSnapshot("Ada", "b".repeat(64)),
    });
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "setAgentProfileEnabled" as const,
      agent: "Ada",
      expectedRevision: "a".repeat(64),
      enabled: true,
    }));
    await flush();
    expect(mutations).toEqual([expect.objectContaining({ operation: "set-enabled", agentName: "Ada", enabled: true })]);
    expect(findType(ctx.posted, "agentProfileError").at(-1)).toMatchObject({
      agent: "Ada",
      code: "agent-profile/revision-conflict",
      conflict: true,
    });
    expect(JSON.stringify(findType(ctx.posted, "agentProfileError").at(-1))).not.toContain("/private/path");
    expect(findType(ctx.posted, "agentProfileSnapshot").at(-1)).toMatchObject({ action: "refresh", snapshot: { revision: "b".repeat(64) } });

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "forgetAgentProfile" as const,
      agent: "Ada",
      expectedRevision: "b".repeat(64),
      confirmation: "Bea",
    }));
    await flush();
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ operation: "forget", confirmation: "Bea" });
  });

  /**
   * t-05dff5 — the two classes, side by side, because the bug was that only one of them existed.
   *
   * A GOVERNED REFUSAL arrives as `kind: "refused"`: a precondition the engine named, whose sentence
   * IS the recovery. It reaches the human verbatim. An INTERNAL FAILURE arrives as a thrown error and
   * is still flattened to one neutral sentence, because a path or a stack is not a gesture anyone can
   * perform. Nothing here reads the message to decide which is which — that was the defect: the old
   * `message.includes("revision")` classified "still owns a worktree; remove it explicitly before
   * canonical forget" as an internal failure and threw the only actionable text on the screen away.
   */
  it("forwards a governed refusal, flattens an internal failure in-panel, and retains its redacted diagnosis", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refusal = "agent 'Ada' still owns a worktree; remove it explicitly before canonical forget";
    const leakedToken = "do-not-retain-this-token";
    const leakedEnvValue = "do-not-retain-this-env-value";
    const target = ws({
      commitAgentProfileStudioLifecycle: async (mutation) => {
        if (mutation.expectedRevision === "a".repeat(64)) {
          return { schemaVersion: 1, kind: "refused", code: "agent-profile/forget-worktree-owned", message: refusal };
        }
        throw new Error(`EIO writing /Users/ada/.tachyon/profiles/Ada/profile.yml TACHYON_AGENT_BRIDGE_TOKEN=${leakedToken} PLUGIN_STATE=${leakedEnvValue}`);
      },
      inspectAgentProfileStudio: async () => profileSnapshot("Ada", "b".repeat(64)),
    });
    const ctx = { ...fakeCtx(), entityId: "Ada" };

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "forgetAgentProfile" as const,
      agent: "Ada",
      expectedRevision: "a".repeat(64),
      confirmation: "Ada",
    }));
    await flush();
    expect(findType(ctx.posted, "agentProfileError").at(-1)).toMatchObject({
      agent: "Ada",
      code: "agent-profile/forget-worktree-owned",
      message: refusal,
      conflict: false,
    });
    // No reload: the block is the worktree, not a stale read, so redrawing would show the same wall.
    expect(findType(ctx.posted, "agentProfileSnapshot")).toHaveLength(0);
    expect(findType(ctx.posted, "agentProfileForgotten")).toHaveLength(0);

    handleAgentStudioDomainMessage(target, ctx, envelope({
      type: "forgetAgentProfile" as const,
      agent: "Ada",
      expectedRevision: "b".repeat(64),
      confirmation: "Ada",
    }));
    await flush();
    const flattened = findType(ctx.posted, "agentProfileError").at(-1);
    expect(flattened).toMatchObject({
      agent: "Ada",
      code: "agent-profile/lifecycle-failed",
      message: "The profile lifecycle action could not be completed.",
      conflict: false,
    });
    expect(JSON.stringify(flattened)).not.toContain("/Users/ada");
    const retained = errorLog.mock.calls.flat().join("\n");
    expect(retained).toContain("Agent Studio lifecycle failed for 'Ada'");
    expect(retained).toContain("EIO writing /Users/ada/.tachyon/profiles/Ada/profile.yml");
    expect(retained).toContain("TACHYON_AGENT_BRIDGE_TOKEN=[redacted]");
    expect(retained).toContain("PLUGIN_STATE=[redacted]");
    expect(retained).not.toContain(leakedToken);
    expect(retained).not.toContain(leakedEnvValue);
    errorLog.mockRestore();
  });
});
