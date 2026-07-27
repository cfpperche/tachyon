import { describe, expect, it } from "vitest";
import { ROUTES } from "../../scripts/webview-preview/routes.js";
import { RUNTIME_CONFIG_SNAPSHOT } from "../../src/webview/runtime-config/messages.js";
import type { RuntimeConfigControlSnapshot } from "../../src/runtimeConfig/types.js";

describe("cockpit runtime config fixture (t-80d367)", () => {
  it("injects the product snapshot envelope after init and model", () => {
    const fixture = ROUTES.cockpit.fixtures["runtime-config"];
    expect(fixture).toBeTruthy();

    const messages = ROUTES.cockpit.makeMessage(fixture!.vm) as Array<{
      type: string;
      snapshot?: RuntimeConfigControlSnapshot;
    }>;

    expect(messages.map((message) => message.type)).toEqual([
      "init",
      "model",
      RUNTIME_CONFIG_SNAPSHOT,
    ]);
    expect(messages[2]?.snapshot?.runtimes.map((runtime) => runtime.runtime)).toEqual([
      "codex",
      "claude",
    ]);
    expect(messages[2]?.snapshot?.runtimes.every((runtime) => runtime.documents.length > 0)).toBe(true);
  });

  it("does not leak the snapshot into unrelated cockpit sections", () => {
    const messages = ROUTES.cockpit.makeMessage(ROUTES.cockpit.fixtures.default!.vm) as Array<{
      type: string;
    }>;
    expect(messages.some((message) => message.type === RUNTIME_CONFIG_SNAPSHOT)).toBe(false);
  });
});
