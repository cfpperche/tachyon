import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("agent soul lifecycle composition closure", () => {
  it("agent soul lifecycle composition closure", async () => {
    const layers = await import("../../src/agents/promptLayers.js");
    const rendered = layers.renderPromptLayers({
      soul: "Steady identity.",
      role: "Reusable role.",
      instructions: "Persistent specialization.",
      bridgeGuidance: "Bridge guidance.",
      taskBrief: "Current execution task.",
    });

    expect(rendered).toBe([
      "Steady identity.",
      "Reusable role.",
      "Persistent specialization.",
      "Bridge guidance.",
      "Current execution task.",
    ].join("\n\n"));

    const identityBody = "DISTINCTIVE_SOUL_BODY_MUST_NOT_REACH_LEDGER";
    const composed = layers.composeAgentPrompt({
      soul: { source: ".tachyon/agents/reviewer/SOUL.md", profileId: "p1", body: identityBody, sha256: "a".repeat(64), chars: identityBody.length, bytes: identityBody.length },
      role: "reviewer",
      instructions: "Persistent specialization.",
      bridgeGuidance: "Bridge guidance.",
      taskBrief: "Current execution task.",
    });
    const body = composed.body!;
    expect(body.indexOf(identityBody)).toBeLessThan(body.indexOf("Your task: review for quality."));
    expect(body.indexOf("Persistent specialization.")).toBeLessThan(body.indexOf("Bridge guidance."));
    expect(body.indexOf("Bridge guidance.")).toBeLessThan(body.indexOf("Current execution task."));

    const { SessionLedger } = await import("../../src/resume/SessionLedger.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soul-ledger-"));
    const ledger = new SessionLedger(root);
    ledger.record("reviewer", { cwd: root, declared: true, identity: { ...composed.soul!, offeredAt: new Date(0).toISOString(), channel: "startup-argument", health: "healthy" } });
    expect(fs.readFileSync(ledger.path, "utf8")).not.toContain(identityBody);
  });
});
