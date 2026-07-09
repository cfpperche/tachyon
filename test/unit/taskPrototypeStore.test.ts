import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "task-prototype-")); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("TaskPrototypeStore", () => {
  it("creates immutable task-scoped drafts and approves exact bytes through a human-only store method", () => {
    const workspace = root();
    const store = new TaskPrototypeStore(workspace, "t-abc123");
    const first = store.createDraft({ html: "<h1>One</h1>", title: "Proposal", author: "designer", now: "2026-01-01T00:00:00.000Z" });
    const draft = first.prototypes[0]!;
    expect(draft).toMatchObject({ state: "draft", available: true, integrity: "verified", author: "designer" });
    expect(draft.relativePath).toContain(`/t-abc123/prototypes/${draft.sha256}/prototype.html`);
    expect(fs.readFileSync(path.join(workspace, draft.relativePath), "utf8")).toBe("<h1>One</h1>");

    const approved = store.approve(draft.id, { expectUpdatedAt: first.updatedAt!, now: "2026-01-02T00:00:00.000Z" });
    expect(approved.approved).toMatchObject({ id: draft.id, state: "approved", approvedBy: "human", sha256: draft.sha256 });
    expect(() => store.reject(draft.id, { expectUpdatedAt: approved.updatedAt! })).toThrow(/invalid prototype transition/);
  });

  it("supersedes one approved anchor, rejects stale CAS, and detects tampered blobs", () => {
    const store = new TaskPrototypeStore(root(), "t-abc123");
    const a = store.createDraft({ html: "<p>A</p>", title: "A", author: "agent", now: "a" });
    const approvedA = store.approve(a.prototypes[0]!.id, { expectUpdatedAt: a.updatedAt!, now: "b" });
    const b = store.createDraft({ html: "<p>B</p>", title: "B", author: "agent", now: "c" });
    expect(() => store.approve(b.prototypes.at(-1)!.id, { expectUpdatedAt: approvedA.updatedAt!, now: "d" })).toThrow(/precondition-failed/);
    const approvedB = store.approve(b.prototypes.at(-1)!.id, { expectUpdatedAt: b.updatedAt!, now: "d" });
    expect(approvedB.prototypes.filter((p) => p.state === "approved")).toHaveLength(1);
    expect(approvedB.prototypes[0]).toMatchObject({ state: "superseded", supersededBy: approvedB.approved!.id });
    fs.writeFileSync(store.prototypePath(approvedB.approved!.sha256), "tampered");
    expect(store.read().approved).toMatchObject({ available: false, integrity: "mismatch" });
    expect(() => store.readHtml(approvedB.approved!.id)).toThrow(/unavailable/);
  });

  it("fails closed on a newer/malformed manifest and cleanup remains an unwired helper", () => {
    const store = new TaskPrototypeStore(root(), "t-abc123");
    fs.mkdirSync(store.attachmentDir, { recursive: true });
    fs.writeFileSync(store.manifestPath, JSON.stringify({ schemaVersion: 99, taskId: "t-abc123", updatedAt: "x", prototypes: [] }));
    expect(store.read()).toMatchObject({ readOnly: true, prototypes: [], error: expect.stringContaining("schema") });
    store.cleanup();
    expect(fs.existsSync(store.manifestPath)).toBe(false);
  });
});
