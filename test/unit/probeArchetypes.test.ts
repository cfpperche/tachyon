import { describe, it, expect } from "vitest";
import { adversarialReview, composeBrief, extractJsonObject, factualVerify, freeform, getArchetype } from "../../src/probe/archetypes.js";

describe("archetypes — composeBrief folds the framing guard in (D7)", () => {
  it("adversarial-review prepends the anti-bias guard + the output contract", () => {
    const brief = composeBrief("adversarial-review", { task: "review spec X", constraints: "be concrete" });
    expect(brief).toContain("Do NOT inspect the filesystem");
    expect(brief).toContain("run shell commands");
    expect(brief).toContain("ADVERSARIAL");
    expect(brief).toContain("DISAGREE");
    expect(brief).toContain("TASK: review spec X");
    expect(brief).toContain("CONSTRAINTS: be concrete");
    expect(brief).toContain('"findings"');
  });

  it("factual-verify carries the anti-fabrication guard", () => {
    const brief = composeBrief("factual-verify", { task: "check these claims" });
    expect(brief).toContain("FACT-CHECKER");
    expect(brief).toContain("Do NOT fabricate");
  });

  it("freeform adds no framing or schema — prose only", () => {
    const brief = composeBrief("freeform", { task: "just answer" });
    expect(brief).toContain("Do NOT inspect the filesystem");
    expect(brief).toContain("TASK: just answer");
    expect(brief).not.toContain('"findings"');
  });
});

describe("archetypes — schema validation, non-compliant → not ok (→ parse_error upstream, OQ5)", () => {
  it("adversarial-review accepts a valid findings object (even fenced + prose-wrapped)", () => {
    const msg = 'Here is my review:\n```json\n{"findings":[{"title":"leak","severity":"major","problem":"x","fix":"y"}],"mostImportant":"the leak"}\n```';
    const v = adversarialReview.validate(msg);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.findings).toHaveLength(1);
      expect(v.value.findings[0]!.severity).toBe("major");
      expect(v.value.mostImportant).toBe("the leak");
    }
  });

  it("adversarial-review rejects a bad severity", () => {
    const v = adversarialReview.validate('{"findings":[{"title":"t","severity":"huge","problem":"p"}]}');
    expect(v.ok).toBe(false);
  });

  it("adversarial-review rejects prose with no JSON", () => {
    expect(adversarialReview.validate("this all looks great, ship it").ok).toBe(false);
  });

  it("factual-verify accepts valid claims and rejects a bad verdict", () => {
    expect(factualVerify.validate('{"claims":[{"claim":"sky is blue","verdict":"true","evidence":"looked"}]}').ok).toBe(true);
    expect(factualVerify.validate('{"claims":[{"claim":"x","verdict":"maybe"}]}').ok).toBe(false);
  });

  it("freeform always validates, value is the raw prose", () => {
    const v = freeform.validate("anything goes");
    expect(v).toEqual({ ok: true, value: "anything goes" });
  });
});

describe("archetypes — JSON extraction + registry", () => {
  it("extracts a balanced object from surrounding prose", () => {
    expect(extractJsonObject('blah {"a":1} blah')).toEqual({ a: 1 });
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("getArchetype returns the right archetype by id", () => {
    expect(getArchetype("adversarial-review").id).toBe("adversarial-review");
    expect(getArchetype("freeform").framing).toBe("");
  });
});
