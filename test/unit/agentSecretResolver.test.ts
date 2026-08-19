import { describe, expect, it } from "vitest";
import { resolveProfileSecretEnvironment } from "@tachyon/engine/config/agentSecretResolver.js";
import { secretStorageKey } from "@tachyon/engine/config/agentProfileProjection.js";

const references = {
  ZAI_API_KEY: { provider: "zai", id: "glm-coding-pro", purpose: "GLM Coding Pro API access" },
} as const;

describe("machine-local profile secret resolver", () => {
  it("positive: resolves a stored reference into the process environment shape", async () => {
    const env = await resolveProfileSecretEnvironment(references, async (key) =>
      key === secretStorageKey("zai", "glm-coding-pro") ? "private-value" : undefined,
    );
    expect(env).toEqual({ ZAI_API_KEY: "private-value" });
  });

  it("negative: refuses a missing reference by safe coordinates", async () => {
    await expect(resolveProfileSecretEnvironment(references, async () => undefined))
      .rejects.toThrow("missing secret 'ZAI_API_KEY' (zai/glm-coding-pro)");
  });

  it("never includes the value in the refusal", async () => {
    const value = "private-value";
    try {
      await resolveProfileSecretEnvironment(references, async () => undefined);
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
});
