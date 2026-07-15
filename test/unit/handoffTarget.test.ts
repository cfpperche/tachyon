import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceHandoffDistillSuccessV1,
  workspaceHandoffEnsureSuccessV1,
  workspaceHandoffViewSuccessV1,
} from "../../src/engine-service/protocol.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspaceHandoffTarget } from "../../src/shell/HandoffTarget.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace Handoff target", () => {
  it("loads, ensures and distills only through exact engine operations", async () => {
    const root = temp();
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "HANDOFF.md"), "existing", "utf8");
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        expect(query).toEqual({ schemaVersion: 1, method: "handoff.view", input: {} });
        return workspaceHandoffViewSuccessV1(handoffView());
      },
      invoke: async (_operationId, command) => {
        if (command.method === "handoff.ensure") {
          return workspaceHandoffEnsureSuccessV1(command, ".tachyon/HANDOFF.md");
        }
        if (command.method === "handoff.distill") {
          return workspaceHandoffDistillSuccessV1(command, {
            mode: command.input.mode,
            agent: command.input.mode === "existing" ? command.input.agent : "handoff-codex-next",
          });
        }
        throw new Error("unexpected command");
      },
    });
    const target = workspaceHandoffTarget(fake);

    await expect(target.loadHandoff()).resolves.toMatchObject({
      body: "## Current State\n\nReady.",
      pendingCount: 1,
    });
    await expect(target.ensureHandoffFile()).resolves.toBe(fs.realpathSync(path.join(root, ".tachyon", "HANDOFF.md")));
    await expect(target.startHandoffDistill({ mode: "existing", agent: "codex" }))
      .resolves.toEqual({ mode: "existing", agent: "codex" });
    await expect(target.startHandoffDistill({ mode: "adhoc", profileId: "codex:default", args: "--full-auto" }))
      .resolves.toEqual({ mode: "adhoc", agent: "handoff-codex-next" });

    expect(fake.queries).toEqual([{ schemaVersion: 1, method: "handoff.view", input: {} }]);
    expect(fake.invocations.map((entry) => entry.command.method)).toEqual([
      "handoff.ensure",
      "handoff.distill",
      "handoff.distill",
    ]);
    expect(fake.invocations[0]?.operationId).toMatch(/^handoff-ensure:[0-9a-f-]{36}$/);
    expect(fake.invocations.slice(1).every((entry) => /^handoff-distill:[0-9a-f-]{36}$/.test(entry.operationId))).toBe(true);
  });

  it("refuses unsafe file paths and an existing-target identity redirect", async () => {
    const root = temp();
    const identity = projectionIdentity(root);
    let unsafePath = true;
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => {
        if (command.method === "handoff.ensure") {
          return {
            schemaVersion: 1,
            method: "handoff.ensure",
            status: "ok",
            canonicalRelativePath: unsafePath ? "../outside.md" : ".tachyon/HANDOFF.md",
          };
        }
        if (command.method === "handoff.distill") {
          return {
            schemaVersion: 1,
            method: "handoff.distill",
            status: "ok",
            mode: "existing",
            agent: "reviewer",
          };
        }
        throw new Error("unexpected command");
      },
    });
    const target = workspaceHandoffTarget(fake);

    await expect(target.ensureHandoffFile()).rejects.toThrow(/invalid result/i);
    unsafePath = false;
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "HANDOFF.md"), "body", "utf8");
    await expect(target.startHandoffDistill({ mode: "existing", agent: "codex" }))
      .rejects.toThrow(/changed the selected agent/i);
  });
});

function handoffView() {
  return {
    schemaVersion: 1 as const,
    handoff: {
      canonicalRelativePath: ".tachyon/HANDOFF.md",
      exists: true,
      body: "## Current State\n\nReady.",
      staleness: "needs_distill" as const,
      pendingCount: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      updatedBy: "human" as const,
      revision: "0123456789abcdef",
      notes: [{
        ts: "2026-07-14T12:01:00.000Z",
        agent: "codex",
        kind: "next" as const,
        summary: "Continue",
        evidence: [],
      }],
      distillTargets: [{
        name: "codex",
        description: "running · declared",
        state: "running" as const,
        declared: true,
      }],
    },
  };
}

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-target-"));
  roots.push(root);
  return root;
}
