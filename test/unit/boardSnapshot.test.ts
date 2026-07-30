import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { EDITOR_HUMAN_ACTOR } from "../../src/validations/types.js";
import { buildBoardSnapshot } from "../../src/tasks/boardSnapshot.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";

let root: string;
let store: TaskStore;
let validationStore: ValidationStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-board-snapshot-"));
  store = new TaskStore(root);
  validationStore = new ValidationStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildBoardSnapshot", () => {
  it("computes allowedDropStatuses from the store's own transition authority, per task status", async () => {
    const inbox = await store.create({ title: "inbox task", author: "human" });
    const triaged = await store.create({ title: "triaged task", author: "human" });
    await store.update(triaged.id, { status: "triaged" });

    const snap = buildBoardSnapshot({ store, declaredAgents: [] });
    expect(snap.allowedDropStatuses[inbox.id]).toEqual(["triaged", "dropped"]);
    expect(snap.allowedDropStatuses[triaged.id]).toEqual(["active", "dropped", "inbox"]); // incl. t-370286's return-for-re-evaluation

    await store.update(triaged.id, { status: "active", assignee: "codex" });
    await store.update(triaged.id, { status: "landed" });
    const landedSnap = buildBoardSnapshot({ store, declaredAgents: [] });
    expect(landedSnap.allowedDropStatuses[triaged.id]).toEqual(["done", "active", "triaged", "dropped"]);
  });

  it("lists declared agents + human, and only relevant ad-hocs (live or with open work)", async () => {
    const t1 = await store.create({ title: "a", author: "human" });
    await store.update(t1.id, { status: "triaged", assignee: "active-runner" });
    await store.update(t1.id, { status: "active" });
    await store.update(t1.id, { status: "done" });
    const t2 = await store.create({ title: "b", author: "human" });
    await store.update(t2.id, { status: "triaged", assignee: "open-runner" });

    const snap = buildBoardSnapshot({ store, declaredAgents: ["claude", "codex"], liveTemporaryAgents: ["live-runner"] });
    expect(snap.chips.map((c) => c.agent)).toEqual(["claude", "codex", "human", "live-runner", "open-runner"]);
    expect(snap.chips.map((c) => c.source)).toEqual(["declared", "declared", "human", "assignee", "assignee"]);
  });

  it("does not carry live agents in the snapshot; liveness is only filter-chip relevance", async () => {
    const snap = buildBoardSnapshot({
      store,
      declaredAgents: ["codex"],
      liveTemporaryAgents: ["live-runner"],
    });

    expect(snap.chips.map((c) => c.agent)).toEqual(["codex", "human", "live-runner"]);
    expect("liveAgents" in snap).toBe(false);
  });

  it("omits a dead ad-hoc that appears only on landed/done/dropped tasks from filter chips", async () => {
    const landed = await store.create({ title: "landed", author: "human" });
    await store.update(landed.id, { status: "triaged", assignee: "landed-runner" });
    await store.update(landed.id, { status: "active" });
    await store.update(landed.id, { status: "landed" });
    const done = await store.create({ title: "done", author: "human" });
    await store.update(done.id, { status: "triaged", assignee: "dead-runner" });
    await store.update(done.id, { status: "active" });
    await store.update(done.id, { status: "done" });
    const dropped = await store.create({ title: "dropped", author: "human" });
    await store.update(dropped.id, { status: "triaged", assignee: "also-dead" });
    await store.update(dropped.id, { status: "dropped" });

    const snap = buildBoardSnapshot({ store, declaredAgents: ["codex"] });

    expect(snap.chips.map((c) => c.agent)).toEqual(["codex", "human"]);
  });

  it("dedupes when a declared agent name is also found as an assignee", async () => {
    const t1 = await store.create({ title: "a", author: "human" });
    await store.update(t1.id, { status: "triaged", assignee: "codex" });

    const snap = buildBoardSnapshot({ store, declaredAgents: ["codex"] });
    expect(snap.chips.filter((c) => c.agent === "codex")).toHaveLength(1);
    expect(snap.chips.find((c) => c.agent === "codex")?.source).toBe("declared");
  });

  it("parity: each chip's next result matches TaskStore.next(agent) for the same fixture", async () => {
    const specDir = path.join(root, "docs", "specs", "900-fixture");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "spec.md"), "**Status:** in-progress\n");

    const a = await store.create({ title: "p0 unassigned", author: "human", priority: 0 });
    await store.update(a.id, { status: "triaged" });
    const b = await store.create({ title: "p1 assigned to codex", author: "human", priority: 1, artifact_refs: [{ type: "sdd", ref: "900-fixture" }] });
    await store.update(b.id, { status: "triaged", assignee: "codex" });
    await store.update(b.id, { status: "active" });
    const c = await store.create({ title: "human queue item", author: "human", priority: 2 });
    await store.update(c.id, { status: "triaged", assignee: "human" });

    const snap = buildBoardSnapshot({ store, declaredAgents: ["claude", "codex"] });
    for (const chip of snap.chips) {
      expect(chip.next).toEqual(store.next(chip.agent));
    }
  });

  it("bounds views like listViews (default clamps to the store's max)", async () => {
    for (let i = 0; i < 12; i++) await store.create({ title: `t${i}`, author: "human" });
    const snap = buildBoardSnapshot({ store, declaredAgents: [], limit: 5 });
    expect(snap.views).toHaveLength(5);
  });

  it("includes validation queue counts and discovery candidates without creating validation records", async () => {
    await validationStore.create({ title: "Manual smoke", author: "human", executor: "human" });
    const agentValidation = await validationStore.create({ title: "Review generated asset", author: "claude", executor: "agent", priority: 1 });
    await validationStore.update(agentValidation.id, { actor: EDITOR_HUMAN_ACTOR, status: "triaged" });
    const specDir = path.join(root, "docs", "specs", "901-validation");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "tasks.md"), "- [ ] Human dogfood install flow\n", "utf8");

    const snap = buildBoardSnapshot({ store, declaredAgents: [], validationStore, workspaceRoot: root });

    expect(snap.validations?.pendingCount).toBe(2);
    expect(snap.validations?.humanPendingCount).toBe(1);
    expect(snap.validations?.agentPendingCount).toBe(1);
    expect(snap.validations?.candidateCount).toBe(1);
    expect(validationStore.list()).toHaveLength(2);
  });

  it("computes per-task attachment counts from the Task Studio sidecar when workspaceRoot is given (read-only)", async () => {
    const withPic = await store.create({ title: "has a screenshot", author: "human" });
    const plain = await store.create({ title: "no attachments", author: "human" });
    const { TaskDetailStore, hashBody } = await import("../../src/tasks/TaskDetailStore.js");
    const { TaskAttachmentStore } = await import("../../src/tasks/TaskAttachmentStore.js");
    const attStore = new TaskAttachmentStore(root, withPic.id);
    const att = attStore.putImage({ data: Buffer.from("png bytes"), mediaType: "image/png", name: "shot.png", source: "paste" });
    new TaskDetailStore(root).write({
      schemaVersion: 1,
      taskId: withPic.id,
      doc: { type: "doc", content: [] },
      attachments: [att],
      bodyHash: hashBody(""),
      taskUpdatedAt: withPic.updatedAt,
    });

    const snap = buildBoardSnapshot({ store, declaredAgents: [], workspaceRoot: root });
    expect(snap.attachmentCounts?.[withPic.id]).toBe(1);
    expect(snap.attachmentCounts?.[plain.id]).toBeUndefined();
  });

  it("omits attachmentCounts entirely when workspaceRoot is not given", async () => {
    await store.create({ title: "a", author: "human" });
    const snap = buildBoardSnapshot({ store, declaredAgents: [] });
    expect(snap.attachmentCounts).toBeUndefined();
  });

  it("snapshot carries only journalCount, never the journal array or entry text", async () => {
    const task = await store.create({ title: "journal card", author: "human" });
    store.journal.append(task.id, { author: "codex", text: "sensitive journal text" });

    const snap = buildBoardSnapshot({ store, declaredAgents: [], workspaceRoot: root });
    const view = snap.views.find((v) => v.task.id === task.id);
    expect(view?.journalCount).toBe(1);
    expect(view?.journal).toBeUndefined();
    const serialized = JSON.stringify(snap);
    expect(serialized).toContain("\"journalCount\":1");
    expect(serialized).not.toContain("sensitive journal text");
    expect(serialized).not.toContain("\"journal\":[");
  });
});
