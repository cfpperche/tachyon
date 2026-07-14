import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceCommandSuccessV1 } from "../../src/engine-service/protocol.js";
import { ClientWorkspaceStudioTarget } from "../../src/shell/ClientWorkspaceStudioTarget.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { CommandStudioAdapter } from "../../src/webview/CommandStudioAdapter.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";
import type { StudioDeps } from "../../src/webview/studioSubmit.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ClientWorkspaceStudioTarget", () => {
  it("loads forms locally but routes every save through one idempotency-keyed engine command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-"));
    roots.push(root);
    const configPath = path.join(root, "tachyon.yml");
    fs.writeFileSync(configPath, config("lint"), "utf8");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const identity = projectionIdentity(root);
    const operations: string[] = [];
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (operationId, command) => {
        operations.push(operationId);
        if (command.method !== "studio.submit") throw new Error("unexpected agent command");
        if (command.input.state.name === "invalid") {
          return workspaceCommandSuccessV1(command, ["forced validation failure"]);
        }
        expect(command.input.editingName).toBeUndefined();
        fs.writeFileSync(configPath, config("lint", command.input.state.name), "utf8");
        return workspaceCommandSuccessV1(command);
      },
    });
    let nextOperation = 0;
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      detectClis: async () => ["codex"],
      operationId: () => `studio-operation-${++nextOperation}`,
    });

    const adapter = new CommandStudioAdapter(target);
    const loaded = adapter.load("lint");
    expect(loaded).toMatchObject({ status: "ok", entity: { name: "lint", fields: { cmd: "npm run lint" } } });
    expect(await target.studioDeps().detectClis()).toEqual(["codex"]);
    expect(target.studioDeps().verifyCandidates()).toEqual(expect.arrayContaining(["npm test", "lint", "ship"]));

    const saved = await adapter.save(undefined, { ...blankCommandFields(), name: "deploy", cmd: "npm run deploy" });
    expect(saved).toEqual({ status: "ok" });
    expect(operations).toEqual(["studio-operation-1"]);
    expect(fake.invocations[0]?.command).toMatchObject({ method: "studio.submit", input: { state: { name: "deploy" } } });
    expect(target.config?.commands.deploy?.cmd).toBe("npm run deploy");

    const beforeInvalid = fs.readFileSync(configPath, "utf8");
    await expect(adapter.save(undefined, { ...blankCommandFields(), name: "invalid", cmd: "" }))
      .resolves.toMatchObject({ status: "error", error: { source: "validation" } });
    expect(fs.readFileSync(configPath, "utf8")).toBe(beforeInvalid);
    expect(operations).toEqual(["studio-operation-1", "studio-operation-2"]);

    fs.writeFileSync(configPath, "not: [valid", "utf8");
    expect(target.config?.commands.deploy?.cmd).toBe("npm run deploy");

    fs.rmSync(configPath);
    expect(target.config).toBeUndefined();
  });

  it("surfaces an engine command failure as transport failure instead of a validation error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-error-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), config("lint"), "utf8");
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => ({
        schemaVersion: 1,
        method: command.method,
        status: "error",
        code: "COMMAND_FAILED",
        message: "engine write failed",
      }),
    });
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      operationId: () => "studio-operation-error",
    });
    await expect(target.studioSubmit({ state: { ...blankCommandFields(), name: "deploy", cmd: "npm run deploy" } }))
      .rejects.toThrow("engine write failed");
  });
});

function config(...commands: string[]): string {
  return `agents:\n  worker:\n    cmd: sh\ncommands:\n${commands.map((name) => `  ${name}:\n    cmd: npm run ${name}\n`).join("")}runbooks:\n  ship:\n    steps:\n      - lint\n`;
}
