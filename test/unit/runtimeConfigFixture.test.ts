import { describe, expect, it } from "vitest";
import { ROUTES } from "../../scripts/webview-preview/routes.js";
import { RUNTIME_CONFIG_SNAPSHOT } from "@tachyon/webview-ui/webview/runtime-config/messages.js";
import type { RuntimeConfigControlSnapshot } from "@tachyon/webview-ui/runtimeConfig/types";

describe("standalone runtime config fixture (t-80d367 / SDD 485 D8)", () => {
  it("injects the product snapshot envelope into its own app", () => {
    const fixture = ROUTES["runtime-config"].fixtures.default;
    expect(fixture).toBeTruthy();

    const message = ROUTES["runtime-config"].makeMessage(fixture!.vm) as {
      type: string;
      snapshot?: RuntimeConfigControlSnapshot;
    };

    expect(message.type).toBe(RUNTIME_CONFIG_SNAPSHOT);
    expect(message.snapshot?.runtimes.map((runtime) => runtime.runtime)).toEqual([
      "codex",
      "claude",
      "grok",
    ]);
    expect(message.snapshot?.runtimes.every((runtime) => runtime.documents.length > 0)).toBe(true);
  });
});
