import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("agent soul lifecycle composition closure", () => {
  it("agent soul lifecycle composition closure", async () => {
    const layers = await import("../../src/agents/promptLayers.js");
    const soul = { source: ".tachyon/agents/reviewer/SOUL.md", profileId: "p1", body: "Steady identity.", sha256: "a".repeat(64), chars: 16, bytes: 16 };
    const rendered = layers.composeAgentPrompt({
      soul,
      role: "reviewer",
      instructions: "Persistent specialization.",
      bridgeGuidance: true,
      taskBrief: "Current execution task.",
    }).body!;

    expect(rendered.indexOf(soul.body)).toBeLessThan(rendered.indexOf("Your task: review for quality."));
    expect(rendered.indexOf("Persistent specialization.")).toBeLessThan(rendered.indexOf("[Tachyon] You are part of a Tachyon team."));
    expect(rendered.indexOf("[Tachyon] You are part of a Tachyon team.")).toBeLessThan(rendered.indexOf("Current execution task."));

    const identityBody = "DISTINCTIVE_SOUL_BODY_MUST_NOT_REACH_LEDGER";
    const composed = layers.composeAgentPrompt({
      soul: { source: ".tachyon/agents/reviewer/SOUL.md", profileId: "p1", body: identityBody, sha256: "a".repeat(64), chars: identityBody.length, bytes: identityBody.length },
      role: "reviewer",
      instructions: "Persistent specialization.",
      bridgeGuidance: true,
      taskBrief: "Current execution task.",
    });
    const body = composed.body!;
    expect(body.indexOf(identityBody)).toBeLessThan(body.indexOf("Your task: review for quality."));
    expect(body.indexOf("Persistent specialization.")).toBeLessThan(body.indexOf("[Tachyon] You are part of a Tachyon team."));
    expect(body.indexOf("[Tachyon] You are part of a Tachyon team.")).toBeLessThan(body.indexOf("Current execution task."));

    const { SessionLedger } = await import("../../src/resume/SessionLedger.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soul-ledger-"));
    const ledger = new SessionLedger(root);
    ledger.record("reviewer", { cwd: root, declared: true, identity: { soul: { ...composed.soul!, offeredAt: new Date(0).toISOString(), channel: "startup-argument", state: "offered" }, health: "offered" } });
    expect(fs.readFileSync(ledger.path, "utf8")).not.toContain(identityBody);
  });
});
