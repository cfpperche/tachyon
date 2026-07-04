import { describe, it, expect } from "vitest";
import { validateSpawnContract, composeSpawnContractBrief, notifyParentGuidance, identityLine, normalizeField, type SpawnContract } from "../../src/bridge/spawnContract.js";

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
  it("composes the slots in order, labeled, after the identity line", () => {
    const b = composeSpawnContractBrief("worker-1", good);
    expect(b).toBe(
      `${identityLine("worker-1")}\n\n` +
        "TASK: Add a retry to the upload client\n" +
        "CONTEXT: src/upload/client.ts times out on flaky networks\n" +
        "CONSTRAINTS: no new deps; keep the public signature\n" +
        "DELIVERABLE: a unit test proving 3 retries with backoff",
    );
  });

  it("uses DONE_WHEN when deliverable absent", () => {
    const b = composeSpawnContractBrief("worker-1", { ...good, deliverable: undefined, doneWhen: "the suite is green" });
    expect(b).toMatch(/DONE_WHEN: the suite is green$/);
    expect(b).not.toMatch(/DELIVERABLE:/);
  });

  it("appends optional free-form instructions after the contract", () => {
    const b = composeSpawnContractBrief("worker-1", good, "Prefer fetch over axios.");
    expect(b.endsWith("\n\nPrefer fetch over axios.")).toBe(true);
  });

  it("truncates an over-long field with an ellipsis, never drops it", () => {
    const b = composeSpawnContractBrief("worker-1", { ...good, context: "x".repeat(2000) });
    const ctx = b.split("\n").find((l) => l.startsWith("CONTEXT:"))!;
    expect(ctx.length).toBeLessThan(700); // LONG_CAP + label
    expect(ctx.endsWith("…")).toBe(true);
  });

  it("bounds the total brief", () => {
    const b = composeSpawnContractBrief("worker-1", good, "y".repeat(5000));
    // the identity line is reserved OUTSIDE the truncatable budget, so the total is cap + identity overhead
    const withoutIdentity = b.slice(`${identityLine("worker-1")}\n\n`.length);
    expect(withoutIdentity.length).toBeLessThanOrEqual(1800);
  });
});

describe("composeSpawnContractBrief — t-d7b3a9 layer A identity line", () => {
  it("opens the brief with the identity line naming the child's own agent name", () => {
    const b = composeSpawnContractBrief("codex-review", good);
    expect(b.startsWith(identityLine("codex-review"))).toBe(true);
  });

  it("names the exact agent, distinct agents get distinct identity lines", () => {
    const a = composeSpawnContractBrief("claude-2", good);
    const b = composeSpawnContractBrief("codex-review", good);
    expect(a).toContain("You are agent claude-2");
    expect(b).toContain("You are agent codex-review");
    expect(a).not.toContain("You are agent codex-review");
  });

  it("points the agent at its own $TACHYON_AGENT_NAME env var", () => {
    expect(identityLine("codex-review")).toMatch(/\$TACHYON_AGENT_NAME/);
  });

  it("survives truncation of an over-long contract — identity is OUTSIDE the truncatable budget", () => {
    const overCap: SpawnContract = { ...good, context: "x".repeat(3000), constraints: "y".repeat(3000) };
    const b = composeSpawnContractBrief("codex-review", overCap, "z".repeat(3000));
    expect(b.startsWith(identityLine("codex-review"))).toBe(true);
  });
});

describe("composeSpawnContractBrief — spec 332 parent-aware notify guidance (dueto F5/F6)", () => {
  it("appends no guidance when parent is omitted", () => {
    const b = composeSpawnContractBrief("worker-1", good);
    expect(b).not.toMatch(/notify_agent/);
  });

  it("appends the notify_agent guidance, naming the parent, when parent is given", () => {
    const b = composeSpawnContractBrief("worker-1", good, undefined, "orchestrator");
    expect(b).toMatch(/notify_agent\(to: "orchestrator"/);
    // it ADDS to (not replaces) the human-facing completion reporting language
    expect(b).toMatch(/in ADDITION to.*normal completion reporting/);
  });

  it("reserves the guidance OUTSIDE the truncatable budget — survives an over-cap brief intact", () => {
    const overCap: SpawnContract = { ...good, context: "x".repeat(2000), constraints: "y".repeat(2000) };
    const b = composeSpawnContractBrief("worker-1", overCap, "z".repeat(2000), "orchestrator");
    const guidance = notifyParentGuidance("orchestrator");
    expect(b.endsWith(guidance)).toBe(true);
    // the truncatable body (everything before the guidance, and after the identity line) is still capped
    const withoutIdentity = b.slice(`${identityLine("worker-1")}\n\n`.length);
    const body = withoutIdentity.slice(0, withoutIdentity.length - guidance.length - 2); // strip the "\n\n" separator too
    expect(body.length).toBeLessThanOrEqual(1800);
  });

  it("notifyParentGuidance interpolates the exact parent name", () => {
    expect(notifyParentGuidance("codex-2")).toContain('notify_agent(to: "codex-2"');
  });
});

describe("normalizeField", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeField("  a\n\t b  ")).toBe("a b");
    expect(normalizeField(undefined)).toBe("");
  });
});
