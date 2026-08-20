import { describe, expect, it } from "vitest";
import {
  canonicalAgentFields,
  environmentRowProblem,
  serializeAgentPatch,
  type AgentStudioFields,
} from "@tachyon/webview-ui/webview/agent-studio-shell/domain";

/**
 * t-9aec3e — the row-level contract behind the driving browser test:
 *   `environmentRowProblem` names the exact row that cannot save (the devhost refusal named
 *   nothing), and `serializeAgentPatch` never lets a half-created row leave the form — the
 *   streamed patch and the save snapshot stay shapes the door accepts even mid-editing.
 *
 * The rules mirror the door, no more: a blank value/secret name and a secret id of "" are
 * refused (the envelope refused exactly the blank key; the mutation schema requires id ≥ 1).
 * A secret with a blank PROVIDER is accepted here because the door accepts it — a stricter rule
 * would strand a hand-authored profile this form did not write.
 */

function withEnvironment(environment: NonNullable<AgentStudioFields["canonical"]>["environment"]): AgentStudioFields {
  const fields = canonicalAgentFields();
  fields.name = "row-guard";
  fields.cmd = "claude";
  fields.canonical!.environment = environment;
  return fields;
}

describe("t-9aec3e — environment rows", () => {
  it("names the blank value row by position", () => {
    const fields = withEnvironment({ values: { SDK: "x", "": "" }, secrets: {} });
    expect(environmentRowProblem(fields)).toBe("Environment value 2 needs a variable name before saving.");
  });

  it("names the blank secret name, then the missing coordinate", () => {
    expect(environmentRowProblem(withEnvironment({
      values: {},
      secrets: { "": { provider: "github", id: "tok", purpose: "" } },
    }))).toBe("Secret reference 1 needs a variable name before saving.");
    expect(environmentRowProblem(withEnvironment({
      values: {},
      secrets: { GITHUB_TOKEN: { provider: "", id: "", purpose: "" } },
    }))).toBe("Secret reference 1 needs a Keys coordinate (provider and id) before saving.");
  });

  it("accepts what the door accepts — blank provider with a real id, clean rows", () => {
    expect(environmentRowProblem(withEnvironment({
      values: { NODE_ENV: "review" },
      secrets: { TOKEN: { provider: "", id: "some-id", purpose: "why" } },
    }))).toBeUndefined();
  });

  it("never serializes a half-created row", () => {
    const fields = withEnvironment({
      values: { SDK: "x", "": "" },
      secrets: { OK: { provider: "github", id: "tok", purpose: "p" }, "": { provider: "", id: "", purpose: "" }, HALF: { provider: "github", id: "", purpose: "" } },
    });
    const patch = serializeAgentPatch(fields, true);
    if (!patch || patch.kind !== "agent-instance") throw new Error("expected an agent-instance patch");
    expect(patch.editable.environment).toMatchObject({
      values: { SDK: "x" },
      secrets: { OK: { provider: "github", id: "tok", purpose: "p" } },
    });
  });

  it("an unnamed row marks the form dirty but never blocks naming it afterwards", () => {
    // the row exists as UI state only; naming it puts it back in the payload
    const fields = withEnvironment({ values: { "": "" }, secrets: {} });
    const blank = serializeAgentPatch(fields, true);
    if (!blank || blank.kind !== "agent-instance") throw new Error("expected an agent-instance patch");
    expect(Object.keys(blank.editable.environment?.values ?? {})).toEqual([]);
    fields.canonical!.environment = { values: { SDK: "x" }, secrets: {} };
    const named = serializeAgentPatch(fields, true);
    if (!named || named.kind !== "agent-instance") throw new Error("expected an agent-instance patch");
    expect(named.editable.environment?.values).toEqual({ SDK: "x" });
    expect(environmentRowProblem(fields)).toBeUndefined();
  });
});
