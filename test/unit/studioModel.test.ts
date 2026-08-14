import { describe, it, expect } from "vitest";
import { decideAnchor, composeDirtyPatch, isEmptyPatch, hashBody } from "@tachyon/engine/tasks/studioModel.js";
import type { Task } from "@tachyon/shared/tasks/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-abc123",
    title: "x",
    status: "inbox",
    author: "human",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("decideAnchor — the authoring-truth model (bodyHash anchoring, spec F1/F2/F15/F18)", () => {
  it("reimports when there is no sidecar yet", () => {
    const task = makeTask({ body: "some agent-authored body" });
    expect(decideAnchor(task, { status: "missing" })).toEqual({ action: "reimport", reason: "no sidecar yet" });
  });

  it("loads the sidecar when its bodyHash matches the current task.body", () => {
    const task = makeTask({ body: "hello" });
    const decision = decideAnchor(task, {
      status: "ok",
      detail: { schemaVersion: 1, taskId: task.id, doc: { type: "doc", content: [] }, attachments: [], bodyHash: hashBody("hello"), taskUpdatedAt: task.updatedAt },
    });
    expect(decision.action).toBe("load");
  });

  it("reimports (external edit wins) when the body changed since the sidecar was written — the no-op preservation invariant's precondition", () => {
    const task = makeTask({ body: "an agent updated this body externally" });
    const decision = decideAnchor(task, {
      status: "ok",
      detail: { schemaVersion: 1, taskId: task.id, doc: { type: "doc", content: [] }, attachments: [], bodyHash: hashBody("the old body before the agent's update_task"), taskUpdatedAt: task.updatedAt },
    });
    expect(decision).toEqual({ action: "reimport", reason: "task.body changed since the sidecar was written" });
  });

  it("treats a missing task.body as an empty string for hashing purposes", () => {
    const task = makeTask({});
    const decision = decideAnchor(task, {
      status: "ok",
      detail: { schemaVersion: 1, taskId: task.id, doc: { type: "doc", content: [] }, attachments: [], bodyHash: hashBody(""), taskUpdatedAt: task.updatedAt },
    });
    expect(decision.action).toBe("load");
  });

  it("is fail-closed read-only on a malformed or unknown/newer schemaVersion sidecar — never reimported", () => {
    const task = makeTask({ body: "anything" });
    const decision = decideAnchor(task, { status: "malformed", error: "unsupported schemaVersion" });
    expect(decision).toEqual({ action: "read-only", reason: "unsupported schemaVersion" });
  });
});

describe("composeDirtyPatch — dirty-field-only patch composition (spec F4)", () => {
  const values = {
    title: "Fixed title",
    kind: "bug",
    priority: 2 as const,
    assignee: "codex",
    deps: ["t-000001"],
    artifact_refs: [{ type: "sdd", ref: "docs/specs/339" }],
  };

  it("includes ONLY the field marked dirty, nothing else", () => {
    expect(composeDirtyPatch(values, { kind: true })).toEqual({ kind: "bug" });
  });

  it("includes multiple dirty fields together", () => {
    expect(composeDirtyPatch(values, { title: true, priority: true })).toEqual({ title: "Fixed title", priority: 2 });
  });

  it("never includes status or rank — they are not representable inputs to this function at all", () => {
    const patch = composeDirtyPatch(values, { title: true, kind: true, priority: true, assignee: true, deps: true, artifact_refs: true });
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("rank");
  });

  it("clears a scalar field with null when dirty and the value was unset (not omitted)", () => {
    const cleared = { ...values, kind: null };
    expect(composeDirtyPatch(cleared, { kind: true })).toEqual({ kind: null });
  });

  it("produces an empty patch when nothing is dirty and the doc wasn't dirty either — proving untouched fields are never sent even though `values` carries live fan-out data", () => {
    // `values` here simulates a fresher snapshot received via live fan-out while the Studio was open —
    // none of it should leak into the patch because nothing was marked dirty by the USER.
    const patch = composeDirtyPatch(values, {});
    expect(patch).toEqual({});
    expect(isEmptyPatch(patch)).toBe(true);
  });

  it("includes body only when the doc itself was dirty at Save time", () => {
    const patch = composeDirtyPatch(values, {}, { body: "new markdown" });
    expect(patch).toEqual({ body: "new markdown" });
    expect(isEmptyPatch(patch)).toBe(false);
  });

  it("attaches the CAS expect.updatedAt precondition when provided, without counting as a dirty field", () => {
    const patch = composeDirtyPatch(values, { title: true }, { expectUpdatedAt: "2026-07-03T00:00:00.000Z" });
    expect(patch).toEqual({ title: "Fixed title", expect: { updatedAt: "2026-07-03T00:00:00.000Z" } });
  });

  it("isEmptyPatch ignores expect/now-only patches (still a no-op Save)", () => {
    expect(isEmptyPatch({ expect: { updatedAt: "x" } })).toBe(true);
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ title: "x" })).toBe(false);
  });
});
