import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceActivityContextSuccessV1,
  workspaceCommandSuccessV1,
} from "../../src/engine-service/protocol.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspaceActivityTarget } from "../../src/shell/ActivityTarget.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace Activity target", () => {
  it("reads strict context and routes pane input through one exact engine command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-target-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity, 0, [
        projectedAgent("codex", { running: true, attention: "working" }),
        projectedAgent("reviewer", { running: true, declared: false }),
      ]),
      query: async (query) => {
        expect(query).toEqual({ schemaVersion: 1, method: "activity.context", input: { agent: "codex" } });
        return workspaceActivityContextSuccessV1({
          schemaVersion: 1,
          context: {
            schemaVersion: 1,
            agent: "codex",
            sharedCwd: true,
            attention: "working",
            targets: { total: 1, truncated: false, items: [{ name: "reviewer", declared: false }] },
          },
        });
      },
      invoke: async (_operationId, command) => workspaceCommandSuccessV1(command),
    });
    const target = workspaceActivityTarget(fake);

    expect(target.activityAttention("codex")).toBe("working");
    await expect(target.activityContext("codex")).resolves.toMatchObject({
      agent: "codex",
      sharedCwd: true,
      targets: { items: [{ name: "reviewer", declared: false }] },
    });
    await expect(target.sendAgentInput("reviewer", "review this", false)).resolves.toBeUndefined();
    expect(fake.invocations).toHaveLength(1);
    expect(fake.invocations[0]).toMatchObject({
      operationId: expect.stringMatching(/^agent-input:[0-9a-f-]{36}$/),
      command: {
        method: "agent.input",
        input: { agent: "reviewer", text: "review this", submit: false },
      },
    });
  });

  it("rejects a valid context response redirected to another agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-target-redirect-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async () => workspaceActivityContextSuccessV1({
        schemaVersion: 1,
        context: {
          schemaVersion: 1,
          agent: "reviewer",
          sharedCwd: false,
          attention: null,
          targets: { total: 0, truncated: false, items: [] },
        },
      }),
    });

    await expect(workspaceActivityTarget(fake).activityContext("codex"))
      .rejects.toThrow(/invalid result/i);
  });
});
