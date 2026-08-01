import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";

/**
 * t-1339a8 — "Awaiting you": a first-class, AUTHORED (never derived) signal that a task is blocked on the
 * HUMAN, coexisting with (not merging into) the Validations subsystem. Covers:
 *   (1) DATA MODEL — Task.awaitingHuman + TaskAttentionCode 'awaiting_human' (types.ts, exercised implicitly
 *       through the store below).
 *   (2) PERSISTENCE — TaskStore.update sets/round-trips/clears the field; attentionFor derives the attention.
 *   (3) BRIDGE TOOLS — flag_for_human (agent-caller-only, mirrors request_human_approval) + clear_human_flag.
 * The Mission Control render coverage (strip + card highlight) lives in boardModel.test.ts, since App.tsx has
 * no existing component-render harness in test/unit and boardModel is the pure VM App.tsx renders from.
 */

/** A fake MCP server that just captures tool handlers (mirrors verifyTask.test.ts's FakeMcp). */
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

function wireTools(workspaceRoot: string, tasks: TaskStore, caller: BridgeDeps["caller"]): FakeMcp {
  const mcp = new FakeMcp();
  const deps = { workspaceRoot, tasks, caller } as unknown as BridgeDeps;
  registerTools(mcp as never, deps);
  return mcp;
}

async function callTool(mcp: FakeMcp, name: string, args: Record<string, unknown>) {
  const handler = mcp.handlers.get(name);
  if (!handler) throw new Error(`${name} not registered`);
  return handler(args);
}

describe("container-generated delegation behavior", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function newWorkspace(): { root: string; store: TaskStore } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snawait-"));
    roots.push(root);
    return { root, store: new TaskStore(root) };
  }

  async function activeTask(store: TaskStore, title: string) {
    const task = await store.create({ title, author: "claude" });
    await store.update(task.id, { status: "triaged" });
    return store.update(task.id, { status: "active", assignee: "snAwait" });
  }

  it("flagging a task for human sets a persisted field, derives an awaiting_human attention, and clears on status transition", async () => {
    const { store } = newWorkspace();
    const task = await activeTask(store, "needs a decision");

    // flag_for_human's persisted-field contract: set it directly through TaskStore.update (the same seam
    // the Bridge tool delegates to) and confirm it round-trips through a fresh read.
    const flagged = await store.update(task.id, {
      awaitingHuman: { reason: "need a call on the migration approach", since: "2026-07-08T12:00:00.000Z", kind: "decision" },
    });
    expect(flagged.awaitingHuman).toEqual({ reason: "need a call on the migration approach", since: "2026-07-08T12:00:00.000Z", kind: "decision" });
    expect(store.get(task.id).awaitingHuman).toEqual(flagged.awaitingHuman);

    // derivation: attentionFor projects the authored field into the SAME attention rendering dangling_dep/
    // ready_to_close already use — never heuristically discovered.
    const view = store.getView(task.id);
    expect(view.attention).toContainEqual({ code: "awaiting_human", message: "need a call on the migration approach" });

    // a status transition means the task advanced — no longer waiting on the human — and clears the flag
    // automatically, field AND derived attention both gone.
    const landed = await store.update(task.id, { status: "landed" });
    expect(landed.awaitingHuman).toBeUndefined();
    const clearedView = store.getView(task.id);
    expect(clearedView.attention ?? []).not.toContainEqual(expect.objectContaining({ code: "awaiting_human" }));
    expect(store.get(task.id).awaitingHuman).toBeUndefined();
  });

  it("explicit clear (awaitingHuman: null) unsets the field without requiring a status transition", async () => {
    const { store } = newWorkspace();
    const task = await activeTask(store, "needs dogfood signoff");
    await store.update(task.id, { awaitingHuman: { reason: "screenshot the MC before dogfood", since: "2026-07-08T12:00:00.000Z", kind: "dogfood" } });

    const cleared = await store.update(task.id, { awaitingHuman: null });
    expect(cleared.status).toBe("active"); // no transition happened — this is the EXPLICIT-clear path
    expect(cleared.awaitingHuman).toBeUndefined();
    expect(store.getView(task.id).attention ?? []).not.toContainEqual(expect.objectContaining({ code: "awaiting_human" }));
  });

  it("awaitingHuman round-trips a fresh TaskStore instance (persisted JSON, not derived)", async () => {
    const { root, store } = newWorkspace();
    const task = await activeTask(store, "needs approval");
    await store.update(task.id, { awaitingHuman: { reason: "approve the rollout plan", since: "2026-07-08T12:00:00.000Z", kind: "validation" } });

    const raw = JSON.parse(fs.readFileSync(store.pathFor(task.id), "utf8"));
    expect(raw.awaitingHuman).toEqual({ reason: "approve the rollout plan", since: "2026-07-08T12:00:00.000Z", kind: "validation" });

    const reopened = new TaskStore(root);
    expect(reopened.get(task.id).awaitingHuman).toEqual({ reason: "approve the rollout plan", since: "2026-07-08T12:00:00.000Z", kind: "validation" });
  });

  it("old task JSON without awaitingHuman loads fine — backward compatible", async () => {
    const { store } = newWorkspace();
    const task = await store.create({ title: "legacy task", author: "claude" });
    const onDisk = JSON.parse(fs.readFileSync(store.pathFor(task.id), "utf8"));
    expect(onDisk.awaitingHuman).toBeUndefined();
    expect(store.get(task.id).awaitingHuman).toBeUndefined();
    expect(store.getView(task.id).attention ?? []).toEqual([]);
  });

  it("flag_for_human requires an agent-authenticated caller — a legacy/human caller is rejected", async () => {
    const { root, store } = newWorkspace();
    const task = await activeTask(store, "needs a decision");

    const mcp = wireTools(root, store, { kind: "legacy" });
    const res = await callTool(mcp, "flag_for_human", { id: task.id, reason: "blocked", kind: "decision" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("agent-authenticated caller");
    expect(store.get(task.id).awaitingHuman).toBeUndefined();
  });

  it("flag_for_human sets the field with an agent caller; clear_human_flag unsets it", async () => {
    const { root, store } = newWorkspace();
    const task = await activeTask(store, "needs a decision");

    const mcp = wireTools(root, store, { kind: "agent", name: "snAwait" });
    const flagRes = await callTool(mcp, "flag_for_human", { id: task.id, reason: "need a call on scope", kind: "decision" });
    expect(flagRes.isError).toBeUndefined();
    // t-f638bd — both tools answer with a receipt now, so the authored field is read back off the store,
    // which is where the contract actually lives.
    const flagged = JSON.parse(flagRes.content[0].text);
    expect(flagged).toMatchObject({ id: task.id, changed: ["awaitingHuman"] });
    const stored = store.get(task.id).awaitingHuman!;
    expect(stored.reason).toBe("need a call on scope");
    expect(stored.kind).toBe("decision");
    expect(new Date(stored.since).toISOString()).toBe(stored.since);

    const clearRes = await callTool(mcp, "clear_human_flag", { id: task.id });
    expect(clearRes.isError).toBeUndefined();
    expect(JSON.parse(clearRes.content[0].text)).toMatchObject({ id: task.id, changed: ["awaitingHuman"] });
    expect(store.get(task.id).awaitingHuman).toBeUndefined();
  });

  it("clear_human_flag requires an agent-authenticated caller — a legacy/human caller is rejected", async () => {
    const { root, store } = newWorkspace();
    const task = await activeTask(store, "needs a decision");

    const agentMcp = wireTools(root, store, { kind: "agent", name: "snAwait" });
    await callTool(agentMcp, "flag_for_human", { id: task.id, reason: "need a call on scope", kind: "decision" });
    expect(store.get(task.id).awaitingHuman).toBeDefined();

    const legacyMcp = wireTools(root, store, { kind: "legacy" });
    const res = await callTool(legacyMcp, "clear_human_flag", { id: task.id });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("agent-authenticated caller");
    expect(store.get(task.id).awaitingHuman).toBeDefined();
  });
});
