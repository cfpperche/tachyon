import { describe, expect, it } from "vitest";
import { isKeysModel, modelMessage } from "../../packages/webview-ui/src/webview/keys/messages";
import { toModel } from "../../apps/vscode-extension/src/webview/KeysPanel";

describe("Keys projection schema", () => {
  it("accepts inventory projections without secret values and rejects them structurally", () => {
    const model = toModel({
      stored: [{ provider: "anthropic", id: "api-key", value: "launch-only-secret" }],
      required: [{ agent: "claude", name: "key", provider: "anthropic", id: "api-key", purpose: "model access" }],
    });
    expect(isKeysModel(model)).toBe(true);
    expect(JSON.stringify(modelMessage(model))).not.toContain("launch-only-secret");
    expect(isKeysModel({ ...model, stored: [{ ...model.stored[0], value: "launch-only-secret" }] })).toBe(false);
  });
});

describe("t-3b8073 — an unused key names its cause", () => {
  const key = (provider: string, id: string) => ({ provider, id });
  const required = (agent: string, provider: string, id: string) =>
    ({ agent, name: agent, provider, id, purpose: "launch" });

  it("a key nothing declares, in a workspace that declares NOTHING, is orphaned", () => {
    // The 2026-08-21 shape: the workspace was re-created, its agents went with it, the machine keys
    // (correctly) stayed. The screen must say that, not just "no profile declares this key".
    const model = toModel({ stored: [key("zai", "api-key"), key("openrouter", "api-key")], required: [] });
    expect(model.stored.map(k => k.orphan)).toEqual(["no-declarations", "no-declarations"]);
  });

  it("a key nothing declares, while OTHER keys are declared, is merely not wired here", () => {
    const model = toModel({
      stored: [key("zai", "api-key"), key("anthropic", "api-key")],
      required: [required("claude", "anthropic", "api-key")],
    });
    expect(model.stored.find(k => k.provider === "zai")?.orphan).toBe("not-declared-here");
    expect(model.stored.find(k => k.provider === "anthropic")?.orphan).toBeUndefined();
  });

  it("a declared key carries no orphan cause at all", () => {
    const model = toModel({ stored: [key("anthropic", "api-key")], required: [required("claude", "anthropic", "api-key")] });
    expect(model.stored[0]!.usedBy).toEqual(["claude"]);
    expect(model.stored[0]).not.toHaveProperty("orphan");
  });

  it("the model with an orphan cause still passes the safe projection schema", () => {
    const model = toModel({ stored: [key("zai", "api-key")], required: [] });
    expect(isKeysModel(model)).toBe(true);
    // and a bogus cause is refused rather than rendered
    expect(isKeysModel({ ...model, stored: [{ ...model.stored[0], orphan: "whatever" }] })).toBe(false);
  });
});
