import { describe, it, expect } from "vitest";
import { validateSpawnContract, composeSpawnContractBrief, normalizeField, type SpawnContract } from "../../src/bridge/spawnContract.js";

const good: SpawnContract = {
  task: "Add a retry to the upload client",
  context: "src/upload/client.ts times out on flaky networks",
  constraints: "no new deps; keep the public signature",
  deliverable: "a unit test proving 3 retries with backoff",
};

describe("validateSpawnContract (spec 246 D5)", () => {
  it("accepts a substantive contract", () => {
    expect(validateSpawnContract(good)).toEqual({ ok: true, errors: [] });
  });

  it("requires task, context, constraints", () => {
    const r = validateSpawnContract({ deliverable: "a green test that covers it" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/task:/);
    expect(r.errors.join(" ")).toMatch(/context:/);
    expect(r.errors.join(" ")).toMatch(/constraints:/);
  });

  it("requires exactly one of deliverable / done_when", () => {
    expect(validateSpawnContract({ ...good, deliverable: undefined, doneWhen: undefined }).errors.join(" ")).toMatch(/deliverable OR done_when/);
    expect(validateSpawnContract({ ...good, doneWhen: "the suite is green on CI" }).errors.join(" ")).toMatch(/exactly ONE/);
  });

  it("accepts done_when as the alternative", () => {
    expect(validateSpawnContract({ ...good, deliverable: undefined, doneWhen: "npm test exits 0 on the changed module" }).ok).toBe(true);
  });

  // D5 substance corpus
  const reject = ["", "   ", "<task>", "{{describe}}", "asdf", "QWER", "tbd", "todo", "n/a", "none", "xxx", "short", "x"];
  for (const v of reject) {
    it(`rejects junk/placeholder/too-short task: ${JSON.stringify(v)}`, () => {
      expect(validateSpawnContract({ ...good, task: v }).ok).toBe(false);
    });
  }

  const pass = ["tests pass", "Fix lint.", "src/foo.ts", "read-only", "add retry logic", "ship 0.34.0"];
  for (const v of pass) {
    it(`accepts terse-but-real task: ${JSON.stringify(v)}`, () => {
      expect(validateSpawnContract({ ...good, task: v }).ok).toBe(true);
    });
  }
});

describe("composeSpawnContractBrief (spec 246 D3)", () => {
  it("composes the slots in order, labeled", () => {
    const b = composeSpawnContractBrief(good);
    expect(b).toBe(
      "TASK: Add a retry to the upload client\n" +
        "CONTEXT: src/upload/client.ts times out on flaky networks\n" +
        "CONSTRAINTS: no new deps; keep the public signature\n" +
        "DELIVERABLE: a unit test proving 3 retries with backoff",
    );
  });

  it("uses DONE_WHEN when deliverable absent", () => {
    const b = composeSpawnContractBrief({ ...good, deliverable: undefined, doneWhen: "the suite is green" });
    expect(b).toMatch(/DONE_WHEN: the suite is green$/);
    expect(b).not.toMatch(/DELIVERABLE:/);
  });

  it("appends optional free-form instructions after the contract", () => {
    const b = composeSpawnContractBrief(good, "Prefer fetch over axios.");
    expect(b.endsWith("\n\nPrefer fetch over axios.")).toBe(true);
  });

  it("truncates an over-long field with an ellipsis, never drops it", () => {
    const b = composeSpawnContractBrief({ ...good, context: "x".repeat(2000) });
    const ctx = b.split("\n").find((l) => l.startsWith("CONTEXT:"))!;
    expect(ctx.length).toBeLessThan(700); // LONG_CAP + label
    expect(ctx.endsWith("…")).toBe(true);
  });

  it("bounds the total brief", () => {
    const b = composeSpawnContractBrief(good, "y".repeat(5000));
    expect(b.length).toBeLessThanOrEqual(1800);
  });
});

describe("normalizeField", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeField("  a\n\t b  ")).toBe("a b");
    expect(normalizeField(undefined)).toBe("");
  });
});
