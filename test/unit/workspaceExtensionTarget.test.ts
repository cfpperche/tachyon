import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceExtensionCommandSuccessV1,
  workspaceExtensionQuerySuccessV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspaceExtensionTarget } from "../../src/shell/WorkspaceExtensionTarget.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace extension target", () => {
  it("queries and invokes only exact action-bound engine results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-target-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        if (query.method !== "extension.query") throw new Error("unexpected query");
        return workspaceExtensionQuerySuccessV1(query, [{ name: "worker", running: false }]);
      },
      invoke: async (_operationId, command) => {
        if (command.method !== "extension.invoke") throw new Error("unexpected command");
        return workspaceExtensionCommandSuccessV1(command, { changed: true });
      },
    });
    const target = workspaceExtensionTarget(fake);

    await expect(target.query({ action: "agents.list" }))
      .resolves.toEqual([{ name: "worker", running: false }]);
    await expect(target.invoke({ action: "config.command.delete", name: "lint" }))
      .resolves.toEqual({ changed: true });
    expect(fake.queries).toEqual([{ schemaVersion: 1, method: "extension.query", input: { action: "agents.list" } }]);
    expect(fake.invocations[0]).toMatchObject({
      operationId: expect.stringMatching(/^extension:[0-9a-f-]{36}$/),
      command: { method: "extension.invoke", input: { action: "config.command.delete", name: "lint" } },
    });
  });

  it("fails closed when a valid response changes the requested action", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-target-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async () => ({
        schemaVersion: 1,
        method: "extension.query",
        status: "ok",
        action: "attention.list",
        value: {},
      }),
    });

    await expect(workspaceExtensionTarget(fake).query({ action: "agents.list" }))
      .rejects.toThrow(/invalid result|mismatched/i);
  });
});
