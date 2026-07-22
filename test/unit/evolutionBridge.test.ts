import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { EvolutionStore } from "../../src/evolution/EvolutionStore.js";

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();

  registerTool(
    name: string,
    _definition: unknown,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void {
    this.handlers.set(name, handler);
  }
}

const roots: string[] = [];

async function setup(caller: BridgeDeps["caller"]): Promise<{
  evolution: EvolutionStore;
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
  reviewId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tachyon-evolution-bridge-"));
  roots.push(root);
  const ids = ["profile-id", "review-id"];
  const evolution = new EvolutionStore(root, { uuid: () => ids.shift()! });
  const created = await evolution.createReview("reviewer", {
    taskId: "t-123456",
    taskTitle: "Ship the feature",
    completionRevision: "a".repeat(64),
    session: "tachyon-reviewer",
  });
  const mcp = new FakeMcp();
  registerTools(mcp as never, {
    workspaceRoot: root,
    evolution,
    caller,
  } as unknown as BridgeDeps);
  return {
    evolution,
    reviewId: created.review.id,
    call: (args) => mcp.handlers.get("submit_evolution_review")!(args),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("submit_evolution_review Bridge tool (SDD 421 Slice 2)", () => {
  it("submits only the caller's review and returns a bounded idempotent summary", async () => {
    const { evolution, reviewId, call } = await setup({ kind: "agent", name: "reviewer" });
    const args = {
      review_id: reviewId,
      proposals: [{ kind: "learning", content: "Run the focused test first.", reason: "It shortened diagnosis." }],
    };

    const first = await call(args);
    expect(first.isError).not.toBe(true);
    expect(JSON.parse(first.content[0]!.text)).toEqual({
      review: { id: reviewId, taskId: "t-123456", status: "submitted" },
      candidates: [{ id: "candidate-review-id-1", kind: "learning" }],
      replayed: false,
    });
    expect((await evolution.listCandidates("reviewer"))).toHaveLength(1);

    const replay = await call(args);
    expect(JSON.parse(replay.content[0]!.text).replayed).toBe(true);
    expect((await evolution.listCandidates("reviewer"))).toHaveLength(1);
  });

  it("supports an explicit no-proposal result", async () => {
    const { evolution, reviewId, call } = await setup({ kind: "agent", name: "reviewer" });
    const result = await call({ review_id: reviewId, proposals: [] });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      review: { id: reviewId, status: "no-proposal" },
      candidates: [],
      replayed: false,
    });
    expect((await evolution.listCandidates("reviewer"))).toEqual([]);
  });

  it("rejects cross-agent, human, and legacy submissions", async () => {
    const crossAgent = await setup({ kind: "agent", name: "other" });
    const crossResult = await crossAgent.call({ review_id: crossAgent.reviewId, proposals: [] });
    expect(crossResult.isError).toBe(true);
    expect(crossResult.content[0]!.text).toContain("unknown Evolution review");

    for (const caller of [{ kind: "human" as const }, { kind: "legacy" as const }]) {
      const denied = await setup(caller);
      const result = await denied.call({ review_id: denied.reviewId, proposals: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("requires an agent-authenticated caller");
    }
  });
});
