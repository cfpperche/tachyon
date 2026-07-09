import { describe, expect, it } from "vitest";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import { runtimeProfile } from "../../src/runtime/runtimeProfile.js";

describe("container-generated delegation behavior", () => {
  it("grok has a resume/fork adapter and profile, and opencode gains a fork command", () => {
    const grok = adapterForRuntime("grok");
    expect(grok).toBeDefined();
    expect(grok?.mintsId).toBe(true);
    expect(grok?.injectId("grok", "session-1")).toBe("grok -s session-1");
    expect(grok?.resumeCommand("grok", "session-1")).toBe("grok -r session-1");
    expect(grok?.forkCommand?.("grok -s fork-1", "source-1")).toBe("grok -s fork-1 -r source-1 --fork-session");

    const opencode = adapterForRuntime("opencode");
    expect(opencode?.forkCommand?.("opencode", "source-1")).toBe("opencode -s source-1 --fork");

    const profile = runtimeProfile("grok");
    expect(profile?.label).toBe("Grok");
    expect(profile?.isolation).toMatchObject({ mechanism: "project-scoped", source: "measured", verified: true });
  });
});
