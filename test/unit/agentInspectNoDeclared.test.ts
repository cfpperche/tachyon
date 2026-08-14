import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeExtensionQuery } from "@tachyon/engine/engine-service/extensionOperationService.js";

/**
 * t-6c8cb4 — `agent.inspect` no longer carries the dead `declared` wire field.
 *
 * Residual from the Agent Instance cut (t-04052d): producer computed config-roster membership and
 * the consumer validated/repassed it, but no `agentInspection()` caller ever read the value. Keeping
 * the field on the wire invites someone to reuse it as agent-species vocabulary.
 *
 * The trap: consumer validation was `typeof payload.declared !== "boolean"` — drop the producer alone
 * and every inspect call throws at runtime while typecheck stays green (payload is JsonValue).
 */
describe("agent.inspect without declared (t-6c8cb4)", () => {
  it("producer returns a payload with no declared key", async () => {
    const workspace = {
      manager: {
        list: async () => [{ name: "worker", session: "s", running: true }],
        agentStates: async () => new Map([["worker", { state: "running" }]]),
        liveDescendants: async () => [] as string[],
      },
      ledger: {
        get: () => undefined,
      },
      worktrees: {
        status: async () => {
          throw new Error("status should not run without a worktree record");
        },
      },
      config: {
        agents: { worker: { cmd: "claude" } },
      },
    };

    const payload = await executeExtensionQuery(
      { workspace: workspace as never },
      { action: "agent.inspect", agent: "worker" },
    );

    expect(payload).toEqual(expect.objectContaining({
      descendants: [],
      record: null,
      worktreeStatus: null,
      resumable: false,
    }));
    expect(payload).not.toHaveProperty("declared");
  });

  it("consumer no longer requires or repasses declared (source pin — both sides of the trap)", () => {
    const consumer = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
    const producer = fs.readFileSync(
      path.join(process.cwd(), "packages/engine/src/engine-service/extensionOperationService.ts"),
      "utf8",
    );

    // The validation that would break runtime if the producer dropped the field alone.
    expect(consumer).not.toContain('typeof payload.declared !== "boolean"');
    expect(consumer).not.toContain("agent inspection declaration is invalid");
    expect(consumer).not.toContain("declared: payload.declared");

    // Producer must not reintroduce the field.
    expect(producer).not.toMatch(/declared:\s*workspace\.config\?\.agents\[agent\]/);
  });
});
