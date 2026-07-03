import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { buildBoardSnapshot } from "../../src/tasks/boardSnapshot.js";

let root: string;
let store: TaskStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-board-snapshot-"));
  store = new TaskStore(root);
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
  });

  it("unions declared agents, human, and assignee strings found in tasks — ad-hoc assignees get a chip", async () => {
    const t1 = await store.create({ title: "a", author: "human" });
    await store.update(t1.id, { status: "triaged", assignee: "ad-hoc-runner" });

    const snap = buildBoardSnapshot({ store, declaredAgents: ["claude", "codex"] });
    expect(snap.chips.map((c) => c.agent)).toEqual(["claude", "codex", "human", "ad-hoc-runner"]);
    expect(snap.chips.map((c) => c.source)).toEqual(["declared", "declared", "human", "assignee"]);
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
});
