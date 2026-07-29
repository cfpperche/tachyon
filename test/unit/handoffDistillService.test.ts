import { describe, expect, it, vi } from "vitest";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";
import {
  listHandoffDistillTargets,
  startHandoffDistillation,
  type HandoffDistillOperations,
} from "../../src/handoff/handoffDistillService.js";

describe("handoff distillation service", () => {
  it("sends once to an already-live declared target without a lifecycle transition", async () => {
    const operations = fakeOperations([agent("codex", { running: true })]);

    await expect(startHandoffDistillation(operations, {
      mode: "existing",
      agent: "codex",
      instructions: "Keep decisions only",
    })).resolves.toEqual({ mode: "existing", agent: "codex" });

    expect(operations.startDeclaredAgent).not.toHaveBeenCalled();
    expect(operations.resumeAgent).not.toHaveBeenCalled();
    expect(operations.sendAgentInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(operations.sendAgentInput).mock.calls[0]?.[1]).toContain("Keep decisions only");
  });

  it("resumes a known target, waits for live truth, and only then sends", async () => {
    const rows = [agent("codex", { running: false })];
    const order: string[] = [];
    const operations = fakeOperations(rows, new Set(["codex"]));
    vi.mocked(operations.resumeAgent).mockImplementation(async () => {
      order.push("resume");
      rows[0] = agent("codex", { running: true });
    });
    vi.mocked(operations.sendAgentInput).mockImplementation(async () => { order.push("send"); });

    await startHandoffDistillation(operations, { mode: "existing", agent: "codex" }, { readyTimeoutMs: 0 });

    expect(order).toEqual(["resume", "send"]);
    expect(operations.startDeclaredAgent).not.toHaveBeenCalled();
  });

  /**
   * t-04052d, from adversarial review — the END-TO-END half of the fork case.
   *
   * `buildDistillTargets` listing the fork is only half the fix: `startHandoffDistillation` gates on
   * target membership BEFORE it ever calls `ensureAgentLive`, so while the fork was filtered out of
   * the list, the resume branch below was unreachable for it no matter what that branch said. This
   * asserts the whole path — listed, then RESUMED rather than fresh-spawned, because a fork has no
   * config definition for `startDeclaredAgent` to spawn from.
   */
  it("resumes a stopped fork end to end — listed as a target, then resumed, never fresh-spawned", async () => {
    const rows = [agent("claude-fork-1", { running: false, lifetime: "temporary", resumePolicy: "restartable" })];
    const operations = fakeOperations(rows, new Set(["claude-fork-1"]));
    vi.mocked(operations.resumeAgent).mockImplementation(async () => {
      rows[0] = agent("claude-fork-1", { running: true, lifetime: "temporary", resumePolicy: "restartable" });
    });

    expect((await listHandoffDistillTargets(operations)).map((t) => t.name)).toEqual(["claude-fork-1"]);
    await expect(startHandoffDistillation(operations, { mode: "existing", agent: "claude-fork-1" }, { readyTimeoutMs: 0 }))
      .resolves.toEqual({ mode: "existing", agent: "claude-fork-1" });

    expect(operations.resumeAgent).toHaveBeenCalledWith("claude-fork-1");
    expect(operations.startDeclaredAgent).not.toHaveBeenCalled();
  });

  it("fresh-starts a stopped declared target and refuses stopped ad-hoc targets", async () => {
    const rows = [agent("reviewer", { running: false }), agent("adhoc", { running: false, lifetime: "temporary", resumePolicy: "collected" })];
    const operations = fakeOperations(rows);
    vi.mocked(operations.startDeclaredAgent).mockImplementation(async (name) => {
      rows[0] = agent(name, { running: true });
    });

    expect((await listHandoffDistillTargets(operations)).map((target) => target.name)).toEqual(["reviewer"]);
    await expect(startHandoffDistillation(operations, { mode: "existing", agent: "reviewer" }, { readyTimeoutMs: 0 }))
      .resolves.toEqual({ mode: "existing", agent: "reviewer" });
    await expect(startHandoffDistillation(operations, { mode: "existing", agent: "adhoc" }, { readyTimeoutMs: 0 }))
      .rejects.toThrow(/not a handoff distillation target/i);
  });

  it("starts an allowlisted ad-hoc profile with an exact unique command and approval prompt", async () => {
    const rows = [agent("handoff-codex-73", { running: true, lifetime: "temporary", resumePolicy: "collected" })];
    const operations = fakeOperations(rows);

    const result = await startHandoffDistillation(operations, {
      mode: "adhoc",
      profileId: "codex:default",
      args: "--model gpt-5.6",
      instructions: "Prefer architecture decisions",
    }, { now: () => 255 });

    expect(result).toEqual({ mode: "adhoc", agent: "handoff-codex-73-2" });
    expect(operations.startAdhocAgent).toHaveBeenCalledTimes(1);
    expect(operations.startAdhocAgent).toHaveBeenCalledWith(
      "handoff-codex-73-2",
      "codex --model gpt-5.6",
      expect.stringContaining("Do not call `set_project_handoff` immediately"),
    );
    expect(vi.mocked(operations.startAdhocAgent).mock.calls[0]?.[2]).toContain("Prefer architecture decisions");
    expect(operations.sendAgentInput).not.toHaveBeenCalled();
  });

  it("fails closed on readiness timeout and never sends into an unavailable pane", async () => {
    const operations = fakeOperations([agent("codex", { running: false })]);

    await expect(startHandoffDistillation(
      operations,
      { mode: "existing", agent: "codex" },
      { readyTimeoutMs: 0 },
    )).rejects.toThrow(/did not become ready/i);

    expect(operations.startDeclaredAgent).toHaveBeenCalledTimes(1);
    expect(operations.sendAgentInput).not.toHaveBeenCalled();
  });
});

function fakeOperations(rows: ManagedEntryInfo[], resumable = new Set<string>()): HandoffDistillOperations {
  return {
    listAgents: vi.fn(async () => rows.map((row) => ({ ...row }))),
    resumableAgentNames: vi.fn(() => new Set(resumable)),
    startDeclaredAgent: vi.fn(async () => undefined),
    resumeAgent: vi.fn(async () => undefined),
    startAdhocAgent: vi.fn(async () => undefined),
    sendAgentInput: vi.fn(async () => undefined),
  };
}

function agent(name: string, overrides: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo {
  return {
    name,
    session: `tachyon-ws-${name}`,
    running: false,
    lifetime: "saved", resumePolicy: "restartable",
    dead: false,
    crashed: false,
    kind: "agent",
    ...overrides,
  };
}
