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
