import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { makeTempDir } from "../helpers/tempDir.js";

describe("agent soul lifecycle composition closure", () => {
  it("agent soul lifecycle composition closure", async () => {
    const layers = await import("../../src/agents/promptLayers.js");
    const soul = { source: ".tachyon/agents/reviewer/SOUL.md", profileId: "123e4567-e89b-42d3-a456-426614174000", body: "Steady identity.", sha256: "a".repeat(64), chars: 16, bytes: 16 };
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
      soul: { ...soul, body: identityBody, chars: identityBody.length, bytes: identityBody.length },
      role: "reviewer",
      instructions: "Persistent specialization.",
      bridgeGuidance: true,
      taskBrief: "Current execution task.",
      taskContractCompletion: "done_when",
    });
    const body = composed.body!;
    expect(body.indexOf(identityBody)).toBeLessThan(body.indexOf("Your task: review for quality."));
    expect(body.indexOf("Persistent specialization.")).toBeLessThan(body.indexOf("[Tachyon] You are part of a Tachyon team."));
    expect(body.indexOf("[Tachyon] You are part of a Tachyon team.")).toBeLessThan(body.indexOf("Current execution task."));
    expect(composed.manifest).toEqual({
      soul: true,
      role: true,
      persistentInstructions: true,
      bridgeGuidance: true,
      task: { kind: "contract", completion: "done_when" },
    });

    const { SessionLedger } = await import("../../src/resume/SessionLedger.js");
    const root = makeTempDir("soul-ledger-");
    const ledger = new SessionLedger(root);
    ledger.record("reviewer", { def: { cmd: "codex", kind: "agent", role: "reviewer", soul: true, taskBrief: "Current execution task." }, cwd: root, instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false }, identity: { soul: { ...composed.soul!, offeredAt: new Date(0).toISOString(), channel: "startup-argument", state: "offered" }, health: "offered" } });
    expect(fs.readFileSync(ledger.path, "utf8")).not.toContain(identityBody);
    expect(new SessionLedger(root).get("reviewer")?.identity?.soul.sha256).toBe("a".repeat(64));
    const malformed = JSON.parse(fs.readFileSync(ledger.path, "utf8")) as { sessions: Record<string, { identity?: { soul: { bytes: number; profileId: string; offeredAt: string }; degradedAt?: string } }> };
    const validIdentity = structuredClone(malformed.sessions.reviewer!.identity!);
    malformed.sessions.reviewer!.identity!.soul.bytes = Number.POSITIVE_INFINITY;
    fs.writeFileSync(ledger.path, JSON.stringify(malformed));
    const sanitized = new SessionLedger(root).get("reviewer");
    expect(sanitized).toBeDefined();
    expect(sanitized?.identity).toBeUndefined();
    for (const breakIdentity of [
      (identity: typeof validIdentity) => { identity.soul.profileId = "not-a-uuid"; },
      (identity: typeof validIdentity) => { identity.soul.offeredAt = "not-a-date"; },
      (identity: typeof validIdentity) => { identity.degradedAt = "not-a-date"; },
    ]) {
      malformed.sessions.reviewer!.identity = structuredClone(validIdentity);
      breakIdentity(malformed.sessions.reviewer!.identity!);
      fs.writeFileSync(ledger.path, JSON.stringify(malformed));
      expect(new SessionLedger(root).get("reviewer")).toMatchObject({ identity: undefined, def: { cmd: "codex" } });
    }

    const legacy = layers.composeAgentPrompt({ instructions: "  persistent  ", bridgeGuidance: false, taskBrief: "  one run  " }).body;
    expect(legacy).toBe("persistent  \n\n  one run");

    expect(layers.composeAgentPrompt({ bridgeGuidance: false }).manifest).toEqual({
      soul: false,
      role: false,
      persistentInstructions: false,
      bridgeGuidance: false,
      task: { kind: "absent" },
    });
    expect(layers.composeAgentPrompt({ role: "custom", instructions: "   ", bridgeGuidance: true, taskBrief: "pipeline objective" }).manifest).toEqual({
      soul: false,
      role: false,
      persistentInstructions: false,
      bridgeGuidance: true,
      task: { kind: "brief" },
    });
    expect(layers.composeAgentPrompt({ role: "coder", bridgeGuidance: false, taskBrief: "delegated", taskContractCompletion: "deliverable" }).manifest).toEqual({
      soul: false,
      role: true,
      persistentInstructions: false,
      bridgeGuidance: false,
      task: { kind: "contract", completion: "deliverable" },
    });
  });
});
