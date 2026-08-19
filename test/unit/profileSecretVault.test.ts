import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { resolveProfileSecretEnvironment } from "@tachyon/engine/config/agentSecretResolver.js";
import { secretStorageKey } from "@tachyon/engine/config/agentProfileProjection.js";
import { extensionCommandSchema, type ExtensionCommandV1 } from "@tachyon/engine/runtime-api/extensionOperations.js";
import { validateAgentStudioHostDomainMessage } from "@tachyon/webview-ui/webview/agent-studio-shell/domain";

describe("Agent Studio machine-secret vault", () => {
  it("stores through the human operation and delivers the value only at agent launch", async () => {
    const values = new Map<string, string>();
    const save = extensionCommandSchema.parse({ action: "secret.set", provider: "zai", id: "glm-coding-pro", value: "launch-only-secret" }) as Extract<ExtensionCommandV1, { action: "secret.set" }>;
    expect(save).toMatchObject({ action: "secret.set", provider: "zai", id: "glm-coding-pro" });
    values.set(secretStorageKey(save.provider, save.id), save.value);

    const environment = await resolveProfileSecretEnvironment(
      { ZAI_API_KEY: { provider: save.provider, id: save.id, purpose: "GLM Coding Pro" } },
      (key) => Promise.resolve(values.get(key)),
    );
    expect(environment).toEqual({ ZAI_API_KEY: "launch-only-secret" });
  });

  it("has an explicit replace operation for editing without reading the old value", () => {
    expect(extensionCommandSchema.parse({ action: "secret.replace", provider: "zai", id: "glm-coding-pro", value: "new-secret" }))
      .toEqual({ action: "secret.replace", provider: "zai", id: "glm-coding-pro", value: "new-secret" });
  });

  it("removes a stored coordinate and makes its declaring profile refuse launch by name", async () => {
    const values = new Map([[secretStorageKey("zai", "glm-coding-pro"), "launch-only-secret"]]);
    const remove = extensionCommandSchema.parse({ action: "secret.remove", provider: "zai", id: "glm-coding-pro" }) as Extract<ExtensionCommandV1, { action: "secret.remove" }>;
    expect(remove).toEqual({ action: "secret.remove", provider: "zai", id: "glm-coding-pro" });
    values.delete(secretStorageKey(remove.provider, remove.id));

    await expect(resolveProfileSecretEnvironment(
      { ZAI_API_KEY: { provider: remove.provider, id: remove.id, purpose: "GLM Coding Pro" } },
      (key) => Promise.resolve(values.get(key)),
    )).rejects.toThrow("missing secret 'ZAI_API_KEY' (zai/glm-coding-pro)");
  });

  it("rejects secret values in every webview inventory response", () => {
    const inventory = {
      type: "secretInventory",
      inventory: {
        stored: [{ provider: "zai", id: "glm-coding-pro" }],
        required: [{ agent: "glm", name: "ZAI_API_KEY", provider: "zai", id: "glm-coding-pro", purpose: "GLM Coding Pro", present: true }],
      },
    };
    expect(validateAgentStudioHostDomainMessage(inventory)).toBe(true);
    expect(validateAgentStudioHostDomainMessage({ ...inventory, inventory: { ...inventory.inventory, secretValue: "launch-only-secret" } })).toBe(false);
    expect(JSON.stringify(inventory)).not.toContain("launch-only-secret");
  });

  it("keeps the editor palette and Bridge out of the secret-writing door", () => {
    const extension = fs.readFileSync("apps/vscode-extension/src/extension.ts", "utf8");
    const packageJson = fs.readFileSync("apps/vscode-extension/package.json", "utf8");
    expect(extension).not.toContain("tachyon.setProfileSecret");
    expect(packageJson).not.toContain("tachyon.setProfileSecret");
    expect(fs.readFileSync("packages/bridge/src/tools.ts", "utf8")).not.toContain("secret.set");
  });
});
