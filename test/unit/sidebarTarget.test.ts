import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspacePinStudioViewSuccessV1,
  workspaceSidebarMutationSuccessV1,
  workspaceSidebarViewSuccessV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspaceSidebarTarget } from "../../src/shell/SidebarTarget.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace Sidebar target", () => {
  it("loads one strict fleet, composes Pin preview and invokes exact engine mutations", async () => {
    const root = temp();
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        if (query.method === "sidebar.view") return workspaceSidebarViewSuccessV1(sidebarView(identity.workspaceHash));
        if (query.method === "pin.studio") {
          return workspacePinStudioViewSuccessV1({
            schemaVersion: 1,
            studio: {
              schemaVersion: 1,
              pinId: query.input.id,
              title: "Engine pin",
              tags: ["ui"],
              doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
              attachments: [],
            },
          });
        }
        throw new Error("unexpected query");
      },
      invoke: async (_operationId, command) => {
        if (command.method !== "sidebar.mutate") throw new Error("unexpected command");
        return workspaceSidebarMutationSuccessV1(command, {
          action: command.input.action,
          id: command.input.id,
          changed: true,
        });
      },
    });
    const target = workspaceSidebarTarget(fake);

    await expect(target.loadSidebar()).resolves.toMatchObject({
      folder: { hash: identity.workspaceHash },
      pins: [{ id: "p-abc123", text: "Engine pin" }],
    });
    await expect(target.loadPinPreview("p-abc123", { asWebviewUri: (value) => `webview:${value}` }))
      .resolves.toMatchObject({ id: "p-abc123", title: "Engine pin", tags: ["ui"] });
    await expect(target.mutateSidebar({ action: "pin.toggle", id: "p-abc123", done: true }))
      .resolves.toEqual({ action: "pin.toggle", id: "p-abc123", changed: true });

    expect(fake.queries.map((query) => query.method)).toEqual(["sidebar.view", "sidebar.view", "pin.studio"]);
    expect(fake.invocations[0]).toMatchObject({
      operationId: expect.stringMatching(/^sidebar:[0-9a-f-]{36}$/),
      command: { method: "sidebar.mutate", input: { action: "pin.toggle", id: "p-abc123", done: true } },
    });
    expect(target.shellCommandArgs({ kind: "agent", agentName: "codex", contextValue: "agent-running-ai" }))
      .toEqual([{ workspaceHash: identity.workspaceHash, agentName: "codex", contextValue: "agent-running-ai" }]);
  });

  it("refuses a valid mutation result redirected to another entity", async () => {
    const root = temp();
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => {
        if (command.method !== "sidebar.mutate") throw new Error("unexpected command");
        return {
          schemaVersion: 1,
          method: "sidebar.mutate",
          status: "ok",
          action: "pin.delete",
          id: "p-def456",
          changed: true,
        };
      },
    });

    await expect(workspaceSidebarTarget(fake).mutateSidebar({ action: "pin.delete", id: "p-abc123" }))
      .rejects.toThrow(/mismatched result/i);
  });

  it("refuses a valid Sidebar projection redirected to another workspace", async () => {
    const root = temp();
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async () => workspaceSidebarViewSuccessV1(sidebarView("other-workspace")),
    });

    await expect(workspaceSidebarTarget(fake).loadSidebar()).rejects.toThrow(/workspace identity/i);
  });
});

function sidebarView(workspaceHash: string) {
  return {
    schemaVersion: 1 as const,
    fleet: {
      folder: { hash: workspaceHash, name: "workspace" },
      bridge: { port: "42897", connected: true },
      agents: [],
      terminals: [],
      commands: [],
      runbooks: [],
      pins: [{ id: "p-abc123", text: "Engine pin", done: false, by: "human", tags: ["ui"] }],
      schedules: [],
      pipelines: [],
      proposals: [],
      handoff: { exists: false, staleness: "fresh" as const, pendingCount: 0 },
    },
  };
}

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-target-"));
  roots.push(root);
  return root;
}
