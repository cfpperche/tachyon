import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationStore } from "../../src/validations/ValidationStore.js";

const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-validation-store-"));

describe("ValidationStore", () => {
  it("creates validations with open type/source labels", async () => {
    const store = new ValidationStore(fresh());
    const v = await store.create({
      title: "Tenant migration rehearsal",
      author: "human",
      type: "red-team prompt pass",
      executor: "either",
      source_refs: [{ type: "external-ticket", ref: "OPS-12" }],
    });

    expect(v).toMatchObject({
      title: "Tenant migration rehearsal",
      type: "red-team prompt pass",
      executor: "either",
      status: "pending",
      source_refs: [{ type: "external-ticket", ref: "OPS-12" }],
    });
    expect(store.get(v.id).type).toBe("red-team prompt pass");
  });

  it("uses CAS preconditions and skips corrupt files while listing", async () => {
    const root = fresh();
    const store = new ValidationStore(root);
    const v = await store.create({ title: "Install smoke", author: "human", executor: "human" });
    await expect(store.update(v.id, { status: "triaged", expect: { updatedAt: "stale" } })).rejects.toThrow("precondition-failed");

    fs.mkdirSync(path.join(root, ".tachyon", "validations"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "validations", "v-ffffff.json"), "{ nope", "utf8");
    expect(store.list().map((x) => x.id)).toEqual([v.id]);
  });

  it("creates assigned validations as triaged so next_validation can surface deliberate assignments", async () => {
    const store = new ValidationStore(fresh());
    const v = await store.create({ title: "Agent smoke", author: "human", executor: "agent", assignee: "codex" });
    expect(v).toMatchObject({ status: "triaged", assignee: "codex" });
  });

  it("requires evidence or reason when closing and preserves failed rounds across reruns", async () => {
    const store = new ValidationStore(fresh());
    const triaged = await store.create({ title: "Dogfood Activity filters", author: "human", executor: "human", assignee: "human" });

    await expect(store.closeRound(triaged.id, { outcome: "failed", expect: { updatedAt: triaged.updatedAt } })).rejects.toThrow("requires evidence_refs or result_note");
    const failed = await store.closeRound(triaged.id, { outcome: "failed", result_note: "Filter menu overlaps on narrow panel." });
    expect(failed).toMatchObject({ status: "closed", rounds: [{ n: 1, outcome: "failed", result_note: "Filter menu overlaps on narrow panel." }] });
    await expect(store.closeRound(triaged.id, { outcome: "failed", result_note: "second close without reopen" })).rejects.toThrow("already closed");

    const rerun = await store.update(triaged.id, { status: "triaged", assignee: "human", expect: { updatedAt: failed.updatedAt } });
    const passed = await store.closeRound(triaged.id, { outcome: "passed", evidence_refs: [{ type: "screenshot", ref: "/tmp/activity-pass.png" }], expect: { updatedAt: rerun.updatedAt } });
    expect(passed.rounds.map((r) => r.outcome)).toEqual(["failed", "passed"]);
    expect(passed.rounds[0].result_note).toContain("overlaps");
  });
});
