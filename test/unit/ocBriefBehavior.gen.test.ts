import { describe, expect, it } from "vitest";
import { composeCommand, instructionsDeliverable, resolveBinary } from "@tachyon/engine/config/loadConfig.js";

describe("container-generated delegation behavior", () => {
  it("opencode spawns deliver the composed brief as a prompt argument", () => {
    expect(composeCommand({ cmd: "opencode", instructions: "TASK: ship it" })).toBe("opencode --prompt 'TASK: ship it'");
    expect(instructionsDeliverable("opencode")).toBe(true);

    // resolveBinary sees through npx/bunx/env launchers (spec 246 codex #1/#3) — composeCommand must agree.
    const launched = composeCommand({ cmd: "npx opencode", instructions: "TASK: review" });
    expect(resolveBinary("npx opencode")).toBe("opencode");
    expect(launched.startsWith("npx opencode --prompt ")).toBe(true);
    expect(launched).toMatch(/TASK: review/);
  });
});
